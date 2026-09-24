/**
 * dsh-session-rescue —— host 侧插件入口
 *
 * 目标：修复 DSH「冷启动后第一个回合永久转圈」的问题。
 *
 * ── 已定位的机制（证据级：实测 + 源码行号，详见 docs/DESIGN.md） ─────────────────
 * 1. 进程重启 / 会话载入会创建**新的 Session 对象**。
 * 2. token meter 的重放状态挂在 `WeakMap<Session, state>` 上
 *    （`@deepseek-ai/dsh-token-meter/lib/index.js:589`）⇒ 新对象 ⇒ 状态为空。
 * 3. `dsh-compaction-basic` 的自动压缩挂在 `agent/pre-step` 上（`lib/index.js:782`），
 *    它无条件调用 `meter.measure(session)`（`:862`）⇒ `_sync(session)`。
 * 4. `_sync` 是**同步**全量重放（`:679-697`）：
 *      while (state.consumedEvents < session.seq) { this._foldEvent(...); ... }
 *    本机实测该会话 seq 已达 51.7 万 ⇒ 51.7 万次迭代。
 * 5. 它跑在 `preStep` 里 —— 即 `turn/start` 与 `step/start` 之间。同步循环阻塞事件循环，
 *    于是 **`step/start` 永远写不出来**（日志永久静默），`while (await this.turn())` 永不返回，
 *    界面永久转圈。
 * 6. 实测对照：seq 35,236 同进程热轮 preStep=231 ms；seq 45,585 冷启动首轮 preStep=16,008 ms
 *    （差 70 倍，唯一变量是该 Session 对象是否新建）；seq 9.3 万 / 38.9 万 / 44.6 万时首轮永不返回。
 *    用户三次实测均以**压缩**恢复，重启无效（重启 = 又冷一次）。
 *
 * ── 因此本插件的修复方式 ────────────────────────────────────────────────────────
 * 不检测、不补超时（冷重放是同步 CPU 循环，`signal.throwIfAborted()` 根本没机会执行，
 * v1 的 cancel + 冷重建动作模型对该故障**无效**，已撤除）。改为两件事：
 *   ① GUARD：载入后规模已达危险线时，抢在用户首个回合之前压缩 ——
 *      把"躲不掉的重放代价"从用户回合里挪到载入后的空闲期，并把 surface 变小。
 *   ② COMPACT：回合之间（agent 空闲）按**增量**主动压缩，使下一次冷启动的重放停留在秒级。
 * 触发与决策全部在 src/guard.js / src/size.js 里，是纯函数，可离线单测。
 *
 * ── 安全边界 ──────────────────────────────────────────────────────────────────
 * 只调用官方压缩服务 `ctx.compaction.compactNow(agent, signal, commandId)`
 * （契约出处：`@deepseek-ai/dsh-command-compact/lib/index.js:8,54`）；
 * 不改 DSH 核心包与安装目录、不重启/升级 DSH、不动别人的会话、不自建会话；
 * 单会话尝试次数有上限、两次尝试之间有冷却，核心报 `busy` 一律退让不重试。
 */

import { createGuard, ACTION } from './guard.js';
import { DEFAULTS as SIZE_DEFAULTS, levelOf, sessionSeq, LEVEL } from './size.js';

export const name = 'session-rescue';
// 只 inject 我们**直接使用**的服务。压缩服务刻意走 ctx.get('compaction') 可选获取：
// 组合里没有 compaction 时插件仍应能装载并如实报告，而不是加载失败。
export const inject = ['agents', 'commands'];

export const DEFAULTS = {
  /** 总开关：false = 只观测、只报告，绝不调用压缩 */
  enabled: true,
  /** 压缩失败重试之外，两次尝试之间的最短间隔（ms） */
  cooldownMs: SIZE_DEFAULTS.cooldownMs,
  /** 巡检间隔（ms）——`agent/status` 之外的兜底 */
  pollMs: 30_000,
  /** 单次压缩调用的上限（ms），超时即放弃本次（不阻塞、不重试到天荒地老） */
  compactionTimeoutMs: 10 * 60_000,
  /** seq 阈值（见 src/size.js 的标定说明） */
  warnSeq: SIZE_DEFAULTS.warnSeq,
  dangerSeq: SIZE_DEFAULTS.dangerSeq,
  minGrowthSeq: SIZE_DEFAULTS.minGrowthSeq,
  maxAttemptsPerSession: SIZE_DEFAULTS.maxAttemptsPerSession,
  /** 日志保留条数 */
  journalLimit: 200,
};

function nowMs() {
  return Date.now();
}

function localTime(ms) {
  return new Date(ms + 8 * 3600e3).toISOString().slice(11, 19);
}

function errCode(err) {
  const code = err && typeof err === 'object' ? err.code : undefined;
  return typeof code === 'string' ? code : null;
}

function errText(err) {
  return String(err && err.message ? err.message : err);
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  const guard = createGuard({
    warnSeq: cfg.warnSeq,
    dangerSeq: cfg.dangerSeq,
    minGrowthSeq: cfg.minGrowthSeq,
    cooldownMs: cfg.cooldownMs,
    maxAttemptsPerSession: cfg.maxAttemptsPerSession,
  });

  /**
   * 本进程已见过的 Session 对象。
   * 与 token meter 的 WeakMap 同构判定冷热：meter 没见过这个对象 ⇒ 它会从 0 重放；
   * 我们也没见过 ⇒ 下一个回合就是"冷回合"。这两个判断在**同一个进程**里必然一致。
   */
  const seen = new WeakSet();
  /** 本进程见过的会话 id 集合（巡检按 id 取 agent 用，见下面的 setInterval） */
  const knownSessions = new Set();
  /** 会话 id → 未结束的 turn 号（用于确认 agent 真的空闲） */
  const openTurn = new Map();
  /** 会话 id → 当前 turn 的 turn/start 时刻（用于自测 preStep 窗口） */
  const turnStartAt = new Map();
  /** 正在压缩中的会话 id（防重入） */
  const busy = new Set();

  const journal = [];
  let seq = 0;

  function note(entry) {
    journal.push({ at: nowMs(), ...entry });
    if (journal.length > cfg.journalLimit) journal.splice(0, journal.length - cfg.journalLimit);
  }

  function compactionService() {
    const svc = typeof ctx.get === 'function' ? ctx.get('compaction') : undefined;
    return svc ?? ctx.compaction ?? null;
  }

  // ── 1) 观测：唯一正确的帧来源是 session/event（帧类型名不是 cordis 事件名）
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id;
    const type = event?.type;
    if (!sessionId || !type) return;
    knownSessions.add(sessionId);

    // 冷热判定：本进程第一次见到这个 Session 对象
    if (!seen.has(session)) {
      seen.add(session);
      guard.observeLoad(sessionId, sessionSeq(session), false, nowMs());
    }

    switch (type) {
      case 'turn/start':
        openTurn.set(sessionId, event.data?.turn ?? null);
        turnStartAt.set(sessionId, Number.isFinite(event.time) ? event.time : nowMs());
        break;
      case 'step/start': {
        // preStep 窗口 = turn/start → 首个 step/start。这是本插件自带的对照量：
        // 它会随会话规模增长，冷启动时尤其明显。
        if (event.data?.step === 1) {
          const t0 = turnStartAt.get(sessionId);
          if (Number.isFinite(t0)) {
            const ms = (Number.isFinite(event.time) ? event.time : nowMs()) - t0;
            guard.observePreStep(sessionId, ms);
            const lv = levelOf(sessionSeq(session), guard.config());
            if (lv !== LEVEL.OK) {
              note({ event: 'prestep', sessionId, ms, seq: sessionSeq(session), level: lv });
            }
          }
        }
        break;
      }
      case 'turn/end':
        openTurn.delete(sessionId);
        turnStartAt.delete(sessionId);
        break;
      case 'session/end-seed':
        // 载入完成（seed 结束）。此处一定是新的 Session 对象，冷判定已在上面登记。
        guard.observeLoad(sessionId, sessionSeq(session), false, nowMs());
        note({ event: 'session-loaded', sessionId, seq: sessionSeq(session) });
        break;
      default:
        break;
    }
  });

  // ── 2) 时机：agent 转空闲时判定（覆盖"载入后"与"每个回合之间"两种场景）
  ctx.on('agent/status', ({ agent, status } = {}) => {
    if (status !== 'idle' || !agent) return;
    void maybeAct(agent);
  });

  // ── 3) 执行：官方压缩服务，回合之外、agent 空闲时调用
  async function runCompaction(agent, decision) {
    const sessionId = agent?.session?.id;
    const svc = compactionService();
    if (!svc || typeof svc.compactNow !== 'function') {
      note({ event: 'compaction-unavailable', sessionId, why: 'ctx.compaction 不可用' });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('session-rescue: compaction timeout')), cfg.compactionTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    seq += 1;
    const commandId = `session-rescue-${decision.action}-${seq}`;
    const t0 = nowMs();
    let wasBusy = false;
    try {
      const result = await svc.compactNow(agent, controller.signal, commandId);
      const tookMs = nowMs() - t0;
      if (result === null) {
        guard.noteResult(sessionId, { ok: true, code: null }, nowMs(), sessionSeq(agent.session));
        note({ event: 'compacted', sessionId, action: decision.action, reason: decision.reason, tookMs, empty: true });
        return;
      }
      guard.noteResult(
        sessionId,
        { ok: true, code: null, shadowedSeqs: result.shadowedSeqs?.length ?? null, shadowedTokenCount: result.shadowedTokenCount ?? null },
        nowMs(),
        sessionSeq(agent.session),
      );
      note({
        event: 'compacted',
        sessionId,
        action: decision.action,
        reason: decision.reason,
        tookMs,
        items: result.shadowedSeqs?.length ?? null,
        tokens: result.shadowedTokenCount ?? null,
      });
    } catch (err) {
      const code = errCode(err);
      wasBusy = code === 'busy';
      guard.noteResult(sessionId, { ok: false, code }, nowMs(), sessionSeq(agent.session));
      note({ event: 'compact-failed', sessionId, action: decision.action, code, why: errText(err) });
    } finally {
      clearTimeout(timer);
      // 只有**真的跑完了一次 measure**（成功或非 busy 的失败）才算这个 Session 已经预热。
      // busy 表示核心拒绝了本次调用，冷重放代价尚未支付 —— 此时标记预热会让冷会话
      // 错过抢跑，用户的第一个回合照样卡死。busy 的重试由 guard 的冷却与 busyStreak 上限约束。
      if (!wasBusy) guard.markWarm(sessionId);
      busy.delete(sessionId);
    }
  }

  async function maybeAct(agent) {
    if (!cfg.enabled) return;
    const session = agent?.session;
    const sessionId = session?.id;
    if (!sessionId) return;
    if (busy.has(sessionId)) return;
    // 只对确定空闲的会话动手：核心自己也会以 `busy` 拒绝，但我们不主动去撞。
    if (openTurn.has(sessionId)) return;
    if (agent.status !== undefined && agent.status !== 'idle') return;

    const decision = guard.decide({
      sessionId,
      seq: sessionSeq(session),
      cold: !guard.get(sessionId)?.warm,
      idle: true,
      now: nowMs(),
    });
    if (decision.action === ACTION.NONE) return;
    busy.add(sessionId);
    await runCompaction(agent, decision);
  }

  // ── 4) 生命周期：巡检兜底（`agent/status` 在某些组合下可能不触发）
  ctx.effect(() => {
    const timer = setInterval(() => {
      // `ctx.agents` 没有 list()；核心自己也是按 id 取：`ownerCtx.agents.get(sessionId)`
      // （`@deepseek-ai/dsh-agent-loop/lib/index.js:1157`）。所以巡检按我们见过的会话 id 取 agent。
      const agents = ctx.agents;
      if (!agents || typeof agents.get !== 'function') return;
      for (const sessionId of knownSessions) {
        const agent = agents.get(sessionId);
        if (agent) void maybeAct(agent);
      }
    }, cfg.pollMs);
    if (typeof timer.unref === 'function') timer.unref();
    note({
      event: 'started',
      enabled: cfg.enabled,
      warnSeq: cfg.warnSeq,
      dangerSeq: cfg.dangerSeq,
      minGrowthSeq: cfg.minGrowthSeq,
    });
    return () => clearInterval(timer);
  });

  // ── 5) 可观测入口：/rescue
  function statusText() {
    const g = guard.config();
    const lines = [];
    lines.push(`session-rescue v0.2：${cfg.enabled ? '自动预防已开启' : '只观测（enabled=false）'}`);
    lines.push(`阈值：提醒 ≥ ${g.warnSeq} seq｜危险 ≥ ${g.dangerSeq} seq｜再压缩需增长 ≥ ${g.minGrowthSeq} seq｜冷却 ${Math.round(g.cooldownMs / 1000)}s`);
    const s = guard.stats();
    lines.push(`会话 ${s.sessions} 个｜抢跑 ${s.guarded}｜主动压缩 ${s.compacted}｜失败 ${s.failed}｜核心忙跳过 ${s.skippedBusy}`);
    const sessions = [...guard.states.keys()];
    if (sessions.length === 0) lines.push('（本进程尚未见到任何会话）');
    for (const sessionId of sessions.slice(-5)) {
      const st = guard.get(sessionId);
      const pre = Number.isFinite(st.lastPreStepMs) ? `${st.lastPreStepMs}ms` : '—';
      const coldPre = Number.isFinite(st.coldPreStepMs) ? `${st.coldPreStepMs}ms` : '—';
      lines.push(
        `· ${sessionId.slice(0, 22)} ${st.warm ? '已预热' : '冷（下次 measure 会全量重放）'}｜preStep 最近 ${pre}／冷启动 ${coldPre}｜尝试 ${st.attempts}`,
      );
      if (st.lastResult) {
        const r = st.lastResult;
        lines.push(
          `   上次压缩 ${localTime(r.at)} ${r.ok ? '成功' : `失败(${r.code ?? '?'})`}${Number.isFinite(r.items) ? ` 清除 ${r.items} 项/~${r.tokens} tokens` : ''}`,
        );
      }
    }
    const recent = journal.slice(-5);
    if (recent.length) {
      lines.push('最近事件：');
      for (const e of recent) {
        lines.push(`  ${localTime(e.at)} ${e.sessionId ? e.sessionId.slice(0, 18) : '—'} ${e.event} ${e.reason ?? ''} ${e.ms ? e.ms + 'ms' : ''} ${e.why ?? ''}`.trim());
      }
    }
    return lines.join('\n');
  }

  ctx.effect(function* registerCommand() {
    yield ctx.commands.register(
      {
        name: 'rescue',
        description: 'Prevent cold-start turn stalls by compacting before the danger size (report by default).',
        handler: async (invocation) => {
          const sub = String(invocation?.rawInput ?? '').trim().toLowerCase();
          if (sub === 'status' || sub === '') return { kind: 'success', text: statusText() };
          if (sub === 'on') {
            cfg.enabled = true;
            note({ event: 'mode', enabled: true });
            return { kind: 'success', text: 'session-rescue：已开启自动预防（仅本进程内生效）。' };
          }
          if (sub === 'off') {
            cfg.enabled = false;
            note({ event: 'mode', enabled: false });
            return { kind: 'success', text: 'session-rescue：已切换为只观测（仅本进程内生效）。' };
          }
          if (sub === 'now') {
            const agent = ctx.agents?.get?.(invocation?.agent?.session?.id) ?? invocation?.agent;
            const sessionId = agent?.session?.id;
            if (!sessionId) return { kind: 'error', text: '拿不到当前会话，无法压缩。' };
            if (openTurn.has(sessionId)) return { kind: 'error', text: '当前有未结束的回合，压缩需要 agent 空闲。' };
            const decision = { action: ACTION.COMPACT, reason: 'manual-now' };
            busy.add(sessionId);
            await runCompaction(agent, decision);
            return { kind: 'success', text: `${statusText()}\n（已按要求立即执行一次压缩）` };
          }
          return { kind: 'success', text: `${statusText()}\n\n用法：/rescue [status|on|off|now]` };
        },
      },
      'session-rescue command',
    );
  });

  return { guard };
}
