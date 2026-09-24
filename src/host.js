/**
 * dsh-session-rescue —— host 侧插件入口
 *
 * 目标：避免 DSH「冷启动后第一个回合永久转圈」这一**现象**。
 *
 * ── 实测事实（唯一可依据的部分；★病因未确定）──────────────────────────────────────
 * · 现象签名：`turn/start` 写下之后**再无任何帧**（没有 `step/start`），日志永久静默、界面永久转圈。
 *   静默窗口落在 agent-loop 的 `preStep`（`:539`，介于 `:528` 的 `turn/start` 与 `:553` 的
 *   `step/start` 之间）。
 * · 8/8 次卡死都发生在**进程重启后的第一个回合**（与 harness 日志 `[desktop] starting` 逐一对上）；
 *   **重启不能脱困**（每重启一次就再来一次）；**`/compact` 是唯一被观测到的恢复手段（3/3）**，
 *   且压缩之后的下一轮都正常（turn 8 / 31 / 36）。
 * · 冷启动首轮的 preStep 远贵于同进程热轮，且随会话规模增长：
 *   seq 35,236 热 = 231 ms｜seq 45,585 冷 = 16,008 ms｜seq 9.3 万 / 38.9 万 / 44.6 万 冷 = 永不返回。
 * · 热轮同样昂贵并会**饱和**（231 ms @35k → ~1.1 s @212k → 平台期 3–6 s）⇒ 代价在**每个回合都走**
 *   的路径上，而不只在冷启动路径上。
 * · ★「冷启动时 token meter 从 seq 0 全量重放」这一度是主假设，已被 `tools/measure-replay.js`
 *   用产品自身的 `TokenMeter._sync` **实测证伪**：整份 526,383 seq 只要 47.0 ms，比 16,008 ms
 *   小约 340 倍。**本插件不再声称知道病因**，详见 docs/DESIGN.md。
 *
 * ── 因此本插件的做法：不解释病因，只避免现象 ─────────────────────────────────────
 * 唯一被实测有效的动作是压缩，而现象只出现在「载入后、压缩前」这个窗口。所以把它提前：
 *   ① GUARD：会话载入后若规模已达危险线，抢在用户首个回合**之前**压缩。
 *   ② COMPACT：回合之间（agent 空闲）按**增量**主动压缩（seq 不会回落，绝对阈值会反复触发）。
 * 这是**避让**，不是修复：病因未明，本插件不声称能消除根因。
 * v1 的 cancel + 冷重建动作模型已撤除 —— 实测无效：重启与取消都不能脱困，只有压缩有效。
 * 触发与决策在 src/guard.js / src/size.js，纯函数，可离线单测。
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
  /** 会话载入完成（seed 结束）后多久尝试抢跑一次（ms）。
   *  ★不能只依赖 `agent/status === "idle"`：该事件在启动时是否一定触发未经证实，
   *  而"用户首个回合之前"这个时机正是本插件唯一要抢的东西。 */
  loadGuardDelayMs: 2_000,
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
  /**
   * 「本插件已为该会话跑过一次压缩」的记账，按 **Session 对象身份** 记。
   * ★这是**设计选择，不是机制结论**：那个变慢的监听器究竟按对象、按 sessionId 还是按进程冷，
   * 目前并不知道（原先拿 token meter 的 WeakMap 来论证这件事的写法已撤回）。
   * 选择按对象 = 「每次重新载入都当成可能又会卡，于是再抢一次」——偏保守、偏向"避免现象"，
   * 代价是最坏情况下每次重新载入多付一次压缩。若按 sessionId 记，同一进程内的重新载入会被
   * 误判成"已处理"而漏掉唯一要抢的时机。
   */
  const warmed = new WeakSet();
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

  // 走 harness 自己的 logger，便于在 headless/无人值守场景观察（/rescue status 只在交互时可见）
  const TAG = '[dsh-session-rescue]';
  function logInfo(msg) {
    try {
      (ctx.logger?.info ?? ctx.logger?.log)?.call(ctx.logger, `${TAG} ${msg}`);
    } catch {
      /* 日志失败绝不影响主流程 */
    }
  }
  function logWarn(msg) {
    try {
      (ctx.logger?.warn ?? ctx.logger?.info)?.call(ctx.logger, `${TAG} ${msg}`);
    } catch {
      /* 同上 */
    }
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
        scheduleLoadGuard(sessionId);
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
      logWarn('compaction service unavailable (ctx.get("compaction") returned nothing); reporting only');
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
      logInfo(
        `${decision.action} ok session=${sessionId.slice(0, 18)} seq=${sessionSeq(agent.session)} took=${tookMs}ms ` +
          `items=${result.shadowedSeqs?.length ?? 0} tokens=${result.shadowedTokenCount ?? 0}`,
      );
    } catch (err) {
      const code = errCode(err);
      wasBusy = code === 'busy';
      guard.noteResult(sessionId, { ok: false, code }, nowMs(), sessionSeq(agent.session));
      note({ event: 'compact-failed', sessionId, action: decision.action, code, why: errText(err) });
      logWarn(`${decision.action} failed session=${sessionId.slice(0, 18)} code=${code ?? '?'}: ${errText(err)}`);
    } finally {
      clearTimeout(timer);
      // 只有**真的跑完了一次 measure**（成功或非 busy 的失败）才算这个 Session 已经预热。
      // busy 表示核心拒绝了本次调用，冷重放代价尚未支付 —— 此时标记预热会让冷会话
      // 错过抢跑，用户的第一个回合照样卡死。busy 的重试由 guard 的冷却与 busyStreak 上限约束。
      if (!wasBusy) {
        guard.markWarm(sessionId);
        warmed.add(agent.session);
      }
      busy.delete(sessionId);
    }
  }

  /**
   * 载入完成后的抢跑入口。**与 `agent/status` 相互独立**：两者谁先到都行，靠 guard 的
   * 冷却与 `coldGuardDone` 保证只真正执行一次。这是本插件最关键的一个时机 ——
   * 抢在用户首个回合之前把那笔代价付掉。
   */
  function scheduleLoadGuard(sessionId) {
    const timer = setTimeout(() => {
      const agent = ctx.agents?.get?.(sessionId);
      if (agent) void maybeAct(agent);
    }, cfg.loadGuardDelayMs);
    if (typeof timer.unref === 'function') timer.unref();
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
      cold: !warmed.has(session),
      idle: true,
      now: nowMs(),
    });
    if (decision.action === ACTION.NONE) return;
    logInfo(
      `decision=${decision.action} reason=${decision.reason} session=${sessionId.slice(0, 18)} ` +
        `seq=${decision.seq} growth=${decision.growth}`,
    );
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
    logInfo(
      `loaded: enabled=${cfg.enabled} warnSeq=${cfg.warnSeq} dangerSeq=${cfg.dangerSeq} minGrowthSeq=${cfg.minGrowthSeq}`,
    );
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
        `· ${sessionId.slice(0, 22)} ${st.warm ? '已处理（本进程内压缩过）' : '未处理（本次载入尚未压缩）'}｜preStep 最近 ${pre}／冷启动 ${coldPre}｜尝试 ${st.attempts}`,
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
