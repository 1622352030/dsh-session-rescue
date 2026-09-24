/**
 * dsh-session-rescue —— 修复编排（纯逻辑，零依赖、可单测）
 *
 * 职责：把「检测到的挂住」翻译成一串**有界、可解释、可审计**的动作计划；
 * 本模块**不做任何 IO、不调用任何 DSH API** —— 执行由宿主插件负责（便于 dry-run 与测试）。
 *
 * 策略依据（实测，见 docs/PLAN.md §1.1）：
 *  - 主判据 `never-started`（turn/start 后无 step）真实样本 5/5 命中、零误报 ⇒ 允许自动动作；
 *  - `mid-turn` 在正常轮上会误报（实测 31–119 s 静默被误判）⇒ 默认**只上报不动作**；
 *  - 同一会话的修复必须**有次数上限与冷却**，避免反复重建把会话越搅越坏；
 *  - **补投用户消息必须显式确认**（`hasPendingMessage === true`）：误补投会重复执行用户的工具调用，
 *    比"少做一次"更糟，因此默认不做。
 */

import { STALL_NEVER_STARTED, STALL_MID_TURN } from './detect.js';

export const ACTION = {
  /** 取消该会话当前挂起的那一轮（不重启应用）。 */
  RELEASE: 'release-turn',
  /** 只对该会话做一次「从磁盘冷重建」（等价于重启时 harness 对该会话做的事）。 */
  REBUILD: 'rebuild-session',
  /** 把那条未被处理的消息重新投递，让它真的跑完。 */
  REDELIVER: 'redeliver-message',
  /** 只上报，不改动任何状态。 */
  NOTIFY: 'notify',
};

export const MODE = { DRY_RUN: 'dry-run', APPLY: 'apply' };

const DEFAULTS = {
  maxAttemptsPerSession: 2,
  windowMs: 10 * 60 * 1000,
  cooldownMs: 2 * 60 * 1000,
  allowMidTurn: false,
  dryRun: true, // 首版默认只报告
};

/**
 * @param {object} [opts]
 * @param {number} [opts.maxAttemptsPerSession=2]  滑动窗口内每会话最多自动修复次数
 * @param {number} [opts.windowMs=600000]          计次窗口
 * @param {number} [opts.cooldownMs=120000]        两次修复之间的最小间隔
 * @param {boolean} [opts.allowMidTurn=false]      mid-turn 是否也自动动作（默认否）
 * @param {boolean} [opts.dryRun=true]             是否只报告
 * @param {() => number} [opts.now]
 */
export function createRepairPlanner(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  /** @type {Map<string, number[]>} sessionId -> 已执行修复的时刻表 */
  const attempts = new Map();
  const stats = { planned: 0, applied: 0, skipped: 0, giveUps: 0 };

  const at = () => {
    const t = now();
    return Number.isFinite(t) ? t : 0;
  };

  function recent(sessionId, time) {
    const list = attempts.get(sessionId) ?? [];
    return list.filter((t) => time - t < cfg.windowMs);
  }

  function notify(text, extra = {}) {
    return { kind: ACTION.NOTIFY, text, ...extra };
  }

  return {
    /**
     * @param {null | {kind: string, turn: number|string|null, waitedMs: number}} verdict
     * @param {{sessionId?: string, hasPendingMessage?: boolean}} [ctx]
     * @returns {{mode: string, sessionId: string|null, kind: string|null, actions: object[], giveUp: string|null, reason: string}}
     */
    plan(verdict, ctx = {}) {
      const mode = cfg.dryRun ? MODE.DRY_RUN : MODE.APPLY;
      const sessionId = ctx.sessionId ?? null;
      const kind = verdict?.kind ?? null;
      const out = { mode, sessionId, kind, actions: [], giveUp: null, reason: '' };

      if (!verdict) {
        out.reason = 'no-verdict';
        return out;
      }
      stats.planned += 1;

      // 1) 该判据是否允许自动动作
      const autoAllowed =
        kind === STALL_NEVER_STARTED ? true : kind === STALL_MID_TURN ? Boolean(cfg.allowMidTurn) : false;
      if (!autoAllowed) {
        out.reason = kind === STALL_MID_TURN ? 'mid-turn-report-only' : 'unknown-verdict';
        out.actions.push(
          notify(
            kind === STALL_MID_TURN
              ? `检测到 mid-turn 停住（${Math.round((verdict.waitedMs ?? 0) / 1000)}s 无活动），仅上报`
              : `未知判据 ${kind}，仅上报`,
          ),
        );
        stats.skipped += 1;
        return out;
      }

      // 2) 次数上限（滑动窗口）
      const time = at();
      const history = recent(sessionId, time);
      if (history.length >= cfg.maxAttemptsPerSession) {
        out.reason = 'attempts-exhausted';
        out.giveUp = 'attempts-exhausted';
        out.actions.push(
          notify(
            `本会话在 ${Math.round(cfg.windowMs / 60000)} 分钟内已自动修复 ${history.length} 次，放弃自动动作（避免反复重建）`,
          ),
        );
        stats.giveUps += 1;
        return out;
      }

      // 3) 冷却
      const last = history.length ? Math.max(...history) : null;
      if (last !== null && time - last < cfg.cooldownMs) {
        out.reason = 'cooldown';
        out.actions.push(
          notify(`距上次修复仅 ${Math.round((time - last) / 1000)}s（< ${Math.round(cfg.cooldownMs / 1000)}s），跳过本次自动动作`),
        );
        stats.skipped += 1;
        return out;
      }

      // 4) 正式动作
      out.reason = 'auto-repair';
      out.actions.push({
        kind: ACTION.RELEASE,
        turn: verdict.turn ?? null,
        reason: `挂住判据=${kind}，等待 ${Math.round((verdict.waitedMs ?? 0) / 1000)}s`,
      });
      out.actions.push({
        kind: ACTION.REBUILD,
        reason: '按实测有效路径：只对该会话做一次冷重建（等价于重启时 harness 对它做的事）',
      });
      if (ctx.hasPendingMessage === true) {
        out.actions.push({
          kind: ACTION.REDELIVER,
          reason: '存在未被处理的消息，修复后重新投递（避免只报错、消息丢失）',
        });
      } else {
        out.actions.push(notify('未确认存在未处理消息 ⇒ 不做补投（避免重复执行）'));
      }
      return out;
    },

    /** 调用方**真的执行完**一个 apply 计划后必须调用它，用于计次与冷却。 */
    noteApplied(sessionId) {
      const time = at();
      const list = recent(sessionId, time);
      list.push(time);
      attempts.set(sessionId, list);
      stats.applied += 1;
      return list.length;
    },

    /** 会话被关闭/删除时清理计次。 */
    forget(sessionId) {
      attempts.delete(sessionId);
    },

    remaining(sessionId) {
      const time = at();
      return Math.max(0, cfg.maxAttemptsPerSession - recent(sessionId, time).length);
    },

    config() {
      return { ...cfg };
    },

    /**
     * 运行期切换 dry-run（**只改本进程内的行为**，不写任何 DSH 配置）。
     * 注意：`config()` 返回的是副本，改它不会生效——必须走这个方法。
     */
    setDryRun(value) {
      cfg.dryRun = Boolean(value);
      return cfg.dryRun;
    },

    stats() {
      return { ...stats };
    },
  };
}
