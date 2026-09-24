/**
 * dsh-session-rescue —— 挂住轮次检测（纯逻辑，零依赖、可单测）
 *
 * 判定依据（实测，见 docs/PLAN.md §1）：DSH 出现「转圈」时，会话日志的形状是
 *   1) `agent/inbox/spliced` → 2) `turn/start` → 3) **此后没有任何真实帧**
 *      （没有 `step/start`、没有 `assistant/*`）
 * 另有一类样本是「跑到一半停住」（已产生若干 step/assistant 之后不再有新事件）。
 *
 * 本模块只做判定，不做任何 IO、不依赖 DSH API，便于单测与复用。
 * 宿主插件必须**定时调用 check()**：挂住的本质就是"不再有新事件"，
 * 只靠 observe() 永远不会触发。
 *
 * ★两条**实测陷阱**（用真实历史日志回放验证时踩到，见 tools/replay.js 与 docs/PLAN.md）：
 *  1) **冷载入补写的合成收尾帧必须排除**：会话被冷重建时，harness 会为未闭合的轮补写
 *     `turn/end {reason:{kind:"interrupted"}}`，其 `time` **抄自最后一条真实事件** ——
 *     于是它看起来"只比开轮晚 1 ms"，紧跟在 `turn/start` 之后。若照单全收，
 *     每一次挂住都会被误读为"正常闭合"（实测：漏报 3/3）。
 *     调用方应在喂入前剔除这类帧（判据：该 `turn/end` 的下一帧是 `session/end-seed`）。
 *  2) **时钟必须是有限值**：会话首帧 `{"type":"session",…}` **没有 time 字段**；
 *     若用它初始化虚拟时钟，`Math.max(undefined, x)` 会得到 NaN，
 *     此后所有比较恒为 false ⇒ 判定**静默失效**（实测：C 会话 0/3 漏报）。
 *     本模块的 check()/observe() 因此对非有限时钟做了防御。
 */

/** 会话帧类型（与 DSH 会话日志中的 type 字段一致）。 */
export const FRAME = {
  INBOX: 'agent/inbox/spliced',
  TURN_START: 'turn/start',
  TURN_END: 'turn/end',
  END_SEED: 'session/end-seed',
};

/** 视为「该轮确实在干活」的帧类型。 */
export const WORK_FRAMES = new Set([
  'step/start',
  'assistant/chunk',
  'assistant/message',
  'reasoning-chunks',
  'text-chunks',
  'tool/call',
  'tool/result',
]);

/** 明确的清除信号：该轮已经闭合（含冷载入补写的合成收尾帧），或会话被冷重建过。 */
const CLEAR_FRAMES = new Set([FRAME.TURN_END, FRAME.END_SEED]);

export const STALL_NEVER_STARTED = 'never-started';
export const STALL_MID_TURN = 'mid-turn';

/**
 * @param {object} [opts]
 * @param {number} [opts.stallMs=45000]         「跑到一半停住」的判定阈值（毫秒）
 * @param {number} [opts.neverStartedMs]        「开了轮就没动过」的判定阈值（默认取 stallMs）
 * @param {() => number} [opts.now]             时钟注入点（单测用）
 */
export function createStallDetector(opts = {}) {
  const stallMs = Number.isFinite(opts.stallMs) ? opts.stallMs : 45000;
  const neverStartedMs = Number.isFinite(opts.neverStartedMs) ? opts.neverStartedMs : stallMs;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** @type {{turn: number|string|null, startedAt: number, sawWork: boolean, lastActivityAt: number, abandonedTurns: number[]}|null} */
  let pending = null;
  let stats = { observed: 0, verdicts: 0, cleared: 0 };

  function eventTime(frame) {
    const t = frame && frame.time;
    return Number.isFinite(t) ? t : now();
  }

  /** 防御：时钟若为非有限值（NaN/undefined），一律退回 now()，避免判定被静默吞掉。 */
  function safeTime(at) {
    if (Number.isFinite(at)) return at;
    const fallback = now();
    return Number.isFinite(fallback) ? fallback : null;
  }

  function verdictFor(at) {
    if (!pending || at === null) return null;
    const sinceStart = at - pending.startedAt;
    const sinceActivity = at - pending.lastActivityAt;
    if (!pending.sawWork) {
      if (sinceStart >= neverStartedMs) {
        return {
          kind: STALL_NEVER_STARTED,
          turn: pending.turn,
          waitedMs: sinceStart,
          since: pending.startedAt,
        };
      }
      return null;
    }
    if (sinceActivity >= stallMs) {
      return {
        kind: STALL_MID_TURN,
        turn: pending.turn,
        waitedMs: sinceActivity,
        since: pending.lastActivityAt,
      };
    }
    return null;
  }

  return {
    /**
     * 喂入一条会话帧。
     * @returns {null | {kind: string, turn: number|string|null, waitedMs: number, since: number}}
     */
    observe(frame) {
      if (!frame || typeof frame.type !== 'string') return null;
      const at = eventTime(frame);
      stats.observed += 1;
      const type = frame.type;

      if (type === FRAME.TURN_START) {
        // 上一轮还没闭合就开了新轮：把它连同更早被抛弃的轮一起带到新状态里，
        // 否则信息会随对象替换而丢失（这正是自测第一版暴露的缺陷）。
        const carried = pending ? [...pending.abandonedTurns, pending.turn] : [];
        pending = {
          turn: frame.turn ?? null,
          startedAt: at,
          sawWork: false,
          lastActivityAt: at,
          abandonedTurns: carried,
        };
        return null;
      }

      if (CLEAR_FRAMES.has(type)) {
        if (pending) stats.cleared += 1;
        pending = null;
        return null;
      }

      if (!pending) return null;

      if (WORK_FRAMES.has(type)) {
        pending.sawWork = true;
        pending.lastActivityAt = at;
        return null;
      }

      // 同一轮内的其它非工作帧（例如 user/message、权限、todo）不算"干活"，
      // 但确实说明宿主还活着 ⇒ 只推进活动时间，不改变 sawWork。
      pending.lastActivityAt = Math.max(pending.lastActivityAt, at);
      return null;
    },

    /** 定时调用：没有新事件时也能判定。 */
    check(at = now()) {
      const v = verdictFor(safeTime(at));
      if (v) stats.verdicts += 1;
      return v;
    },

    /** 当前是否有未闭合的轮次（供状态展示）。 */
    pending() {
      if (!pending) return null;
      return {
        turn: pending.turn,
        startedAt: pending.startedAt,
        sawWork: pending.sawWork,
        waitedMs: now() - pending.startedAt,
        abandonedTurns: pending.abandonedTurns.slice(),
      };
    },

    /** 修复动作完成后调用：清空挂起状态并计数（用于"同一会话不应反复触发"）。 */
    resolve() {
      const had = pending;
      pending = null;
      if (had) stats.cleared += 1;
      return had;
    },

    stats() {
      return { ...stats };
    },
  };
}
