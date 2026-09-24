/**
 * dsh-session-rescue —— host 侧插件入口
 *
 * 契约来源（逐行出处见 docs/API-NOTES.md，本机实测 `@deepseek-ai/dsh@0.1.2-rc.1`）：
 *  - host 入口形状 = **具名导出 `name` / `inject` / `apply(ctx, config)`**（非 `export default`），
 *    照抄 `@deepseek-ai/dsh-command-compact\lib\index.js:7,8,77,100`；
 *  - ★帧类型名**不是** cordis 事件名：`turn/start` / `step/start` / `assistant/message` / `session/end-seed`
 *    只能通过 **`ctx.on('session/event', (session, event) => …)`** 拿到，再按 `event.type` 分派
 *    （`…\dsh-session\lib\index.js:1416-1435` 载出，官方消费点同在 handler 内 switch）；
 *  - 取消挂起轮的公开链路 = `ctx.agents.get(sessionId)?.cancel({kind,reason}, {keepInbox:true})`
 *    （`…\dsh-agent-loop\lib\index.js:410-416`，与 Web Stop 同一落点）；
 *  - ⚠️ **没有**单一公开的「重新加载/重建会话」API（`prepare(id)` 在会话活着时抛
 *    `cannot prepare session "…" while it is live`，`…\dsh-session-persistence\lib\index.js:975`）
 *    ⇒ 本插件**不声称**能做到整会话冷重建，见下面 `execute()` 里的如实降级。
 *
 * 安全边界：只读磁盘、不重启/升级 DSH、不改 DSH 安装目录、不触碰其它会话；
 * 首版默认 **dry-run**（只记录、只上报，不执行任何动作）。
 */

import { createStallDetector, FRAME } from './detect.js';
import { createRepairPlanner, ACTION, MODE } from './repair-plan.js';

export const name = 'session-rescue';
export const inject = ['agents', 'commands', 'sessions'];

const DEFAULTS = {
  /** turn/start 之后多久没有任何 step/assistant ⇒ 判定挂住 */
  stallMs: 45_000,
  /** 定时巡检间隔：挂住的本质是"不再有新事件"，必须靠轮询判定 */
  pollMs: 5_000,
  /** 首版默认只报告，不执行动作 */
  dryRun: true,
  /** mid-turn 默认只上报（实测会在正常长静默上误报） */
  allowMidTurn: false,
  /** 判定"存在未处理消息"的时间窗 */
  pendingWindowMs: 10 * 60_000,
  maxAttemptsPerSession: 2,
  windowMs: 10 * 60_000,
  cooldownMs: 2 * 60_000,
  /** 释放后等待该会话从 SessionStore 退场的上限（毫秒）——退场后才可能冷重建 */
  retirementTimeoutMs: 15_000,
  /** 等待退场的轮询间隔 */
  retirementPollMs: 250,
  /** 释放成功后是否尝试就地冷重建（走公开的 `ctx.agents.resume`） */
  rebuildAfterRelease: true,
};

function isUserInboxFrame(event) {
  if (event?.type !== FRAME.INBOX) return false;
  const src = event.data?.inserted?.[0]?.source;
  return !src || src.kind === 'user';
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };

  const planner = createRepairPlanner({
    dryRun: cfg.dryRun,
    allowMidTurn: cfg.allowMidTurn,
    maxAttemptsPerSession: cfg.maxAttemptsPerSession,
    windowMs: cfg.windowMs,
    cooldownMs: cfg.cooldownMs,
  });

  /** @type {Map<string, {det: ReturnType<typeof createStallDetector>, lastUserInboxAt: number|null}>} */
  const tracked = new Map();
  /**
   * 我们自己 `ctx.agents.resume()` 得到的 AgentHandle（会话 id → handle）。
   * 官方契约：`resume(options): Promise<AgentHandle>`，`AgentHandle = { agent, dispose }`；
   * 而 `ctx.agents.get()` 只给**裸 Agent**（拿不到 dispose）。⇒ **谁 resume，谁能释放**。
   */
  const handles = new Map();
  /** 正在修复中的会话（防重入） */
  const inFlight = new Set();
  /** 供 `/rescue log` 与状态展示 */
  const journal = [];
  const journalLimit = 200;

  function stateFor(sessionId) {
    let st = tracked.get(sessionId);
    if (!st) {
      st = { det: createStallDetector({ stallMs: cfg.stallMs }), lastUserInboxAt: null };
      tracked.set(sessionId, st);
    }
    return st;
  }

  function note(entry) {
    journal.push({ at: Date.now(), ...entry });
    if (journal.length > journalLimit) journal.splice(0, journal.length - journalLimit);
  }

  // ── 1) 事件输入：唯一正确来源是 session/event（A2）
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id;
    if (!sessionId || !event?.type) return;
    const st = stateFor(sessionId);
    if (isUserInboxFrame(event)) st.lastUserInboxAt = Number.isFinite(event.time) ? event.time : Date.now();
    st.det.observe({ type: event.type, time: event.time, turn: event.data?.turn ?? null });
  });

  // ── 2) 动作执行：只执行真正有公开链路的动作（A3/A4/A5）
  function execute(sessionId, plan) {
    for (const action of plan.actions) {
      if (action.kind === ACTION.RELEASE) {
        const agent = ctx.agents?.get?.(sessionId);
        if (!agent || typeof agent.cancel !== 'function') {
          // 拿不到 live agent 句柄时如实降级，不假装执行过
          note({ sessionId, action: ACTION.RELEASE, ok: false, why: 'no-live-agent-handle' });
          continue;
        }
        try {
          agent.cancel({ kind: 'hook', reason: 'session-rescue: stalled turn' }, { keepInbox: true });
          note({ sessionId, action: ACTION.RELEASE, ok: true, turn: action.turn ?? null });
        } catch (err) {
          note({ sessionId, action: ACTION.RELEASE, ok: false, why: String(err && err.message ? err.message : err) });
        }
      } else if (action.kind === ACTION.REBUILD) {
        // ★如实降级：本机没有任何单一公开 API 能重建一个"活着的"会话（A4），
        //   唯一能释放活 agent 的 AgentHandle 只暴露给创建方（A5，待真机验证）。
        //   ⇒ 这里**不执行**，只登记，绝不对外声称做过。
        note({ sessionId, action: ACTION.REBUILD, ok: false, why: 'no-public-api (see docs/API-NOTES.md §6)' });
      } else if (action.kind === ACTION.REDELIVER) {
        // cancel 使用了 { keepInbox: true } ⇒ 尽量不丢那条未处理消息。
        // 主动重投会重复执行用户的工具调用，故首版不实现（由 planner 的保守策略一致）。
        note({ sessionId, action: ACTION.REDELIVER, ok: false, why: 'not-implemented-by-design' });
      }
    }
  }

  function tick() {
    const now = Date.now();
    for (const [sessionId, st] of tracked) {
      const verdict = st.det.check(now);
      if (!verdict) continue;
      const hasPendingMessage =
        Number.isFinite(st.lastUserInboxAt) && now - st.lastUserInboxAt <= cfg.pendingWindowMs;
      const plan = planner.plan(verdict, { sessionId, hasPendingMessage });
      note({ sessionId, verdict: verdict.kind, waitedMs: verdict.waitedMs, plan: plan.reason, mode: plan.mode });

      if (plan.mode !== MODE.APPLY || plan.reason !== 'auto-repair') continue;
      execute(sessionId, plan);
      planner.noteApplied(sessionId);
      st.det.resolve();
    }
  }

  // ── 3) 生命周期：轮询只在本插件存活期间运行
  ctx.effect(() => {
    const timer = setInterval(tick, cfg.pollMs);
    if (typeof timer.unref === 'function') timer.unref();
    note({ event: 'started', dryRun: planner.config().dryRun, stallMs: cfg.stallMs, pollMs: cfg.pollMs });
    return () => clearInterval(timer);
  });

  // ── 4) 可观测入口：/rescue
  function statusText() {
    const lines = [];
    lines.push(`session-rescue：模式=${planner.config().dryRun ? 'dry-run（只报告）' : 'apply'}，阈值=${Math.round(cfg.stallMs / 1000)}s，巡视会话=${tracked.size}`);
    const s = planner.stats();
    lines.push(`计划 ${s.planned}｜已执行 ${s.applied}｜跳过 ${s.skipped}｜放弃 ${s.giveUps}`);
    const recent = journal.slice(-5);
    if (recent.length === 0) lines.push('暂无事件');
    for (const e of recent) {
      const t = new Date(e.at + 8 * 3600e3).toISOString().slice(11, 19);
      lines.push(`${t} ${e.sessionId ? e.sessionId.slice(0, 18) : '—'} ${e.verdict ?? e.event ?? ''} ${e.plan ?? e.action ?? ''} ${e.why ?? ''}`.trim());
    }
    return lines.join('\n');
  }

  ctx.effect(function* registerCommand() {
    yield ctx.commands.register(
      {
        name: 'rescue',
        description: 'Report or control session-stall recovery (dry-run by default).',
        handler: (invocation) => {
          const sub = String(invocation?.rawInput ?? '').trim().toLowerCase();
          if (sub === 'apply') {
            planner.setDryRun(false); // 仅本进程内生效，不改 DSH 任何配置
            note({ event: 'mode', dryRun: false });
            return { kind: 'success', text: 'session-rescue：已切换为 apply（本进程内生效）。' };
          }
          if (sub === 'dry-run' || sub === 'dry') {
            planner.setDryRun(true);
            note({ event: 'mode', dryRun: true });
            return { kind: 'success', text: 'session-rescue：已切回 dry-run（只报告）。' };
          }
          return { kind: 'success', text: statusText() };
        },
      },
      'session-rescue command',
    );
  });
}
