/**
 * guard.js —— 「何时主动压缩」的纯决策状态机（无 I/O、无定时器、可离线单测）
 *
 * 两种触发时机，对应两种代价位置：
 *   ① GUARD（载入后、用户首个回合之前）
 *      冷启动的同步全量重放本来就是**躲不掉**的一笔代价；区别只在于付在哪里。
 *      付在用户回合里 = 永久转圈；付在载入后的空闲期 = 启动慢一次。
 *      所以：会话刚载入（本进程第一次见到该 Session 对象）且规模已达危险线时，
 *      抢在用户发消息之前把压缩跑掉。
 *   ② COMPACT（回合之间、agent 空闲）
 *      使 surface 保持小，从而让**下一次**冷启动的重放停留在秒级。
 *
 * 反抖动：seq 单调不减（压缩只追加），所以判据一律用 **增量**
 * `seq - lastCompactedSeq >= minGrowthSeq`，否则会在每次空闲反复触发。
 */

import { DEFAULTS, LEVEL, levelOf } from './size.js';

/** 决策结果 */
export const ACTION = {
  /** 什么都不做 */
  NONE: 'none',
  /** 载入后抢跑：在用户首个回合之前压缩 */
  GUARD: 'guard',
  /** 回合间主动压缩 */
  COMPACT: 'compact',
};

function stateFor(states, sessionId) {
  let st = states.get(sessionId);
  if (!st) {
    st = {
      loadedAt: null,
      loadedSeq: null,
      /** 本进程是否已见过该 Session 对象 ⇒ token meter 是否已预热 */
      warm: false,
      /** 已抢跑过的危险载入（按 Session 对象身份，不按 seq） */
      coldGuardDone: false,
      /** 上次成功压缩时的 seq（seq 不回落，所以这是"增量"的基准） */
      lastCompactedSeq: null,
      lastAttemptAt: null,
      attempts: 0,
      /** 连续 busy 次数（busy ≠ 已支付重放代价，所以不计入 attempts，但要有上限） */
      busyStreak: 0,
      lastResult: null,
      /** 本插件的自观测：最近一次 turn/start → 首个 step/start 的耗时 */
      lastPreStepMs: null,
      coldPreStepMs: null,
    };
    states.set(sessionId, st);
  }
  return st;
}

/**
 * 创建守卫。全部副作用由调用方执行；此处只做判定。
 * @param {object} cfg - 见 size.js DEFAULTS 与下面 host.js 的插件配置
 */
export function createGuard(cfg = {}) {
  const c = { ...DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  /** @type {Map<string, object>} */
  const states = new Map();
  const totals = { guarded: 0, compacted: 0, failed: 0, skippedBusy: 0 };

  /** 首次在本进程看到该 Session 对象：标记"冷"，并记录载入规模。 */
  function observeLoad(sessionId, seq, warm, now) {
    const st = stateFor(states, sessionId);
    if (st.warm === true && warm === true) return st;
    st.loadedAt = now;
    st.loadedSeq = seq;
    st.warm = warm === true;
    if (!st.warm) st.coldGuardDone = false;
    return st;
  }

  /** 记录本插件实测的 preStep 窗口耗时（turn/start → 首个 step/start）。 */
  function observePreStep(sessionId, ms) {
    const st = stateFor(states, sessionId);
    st.lastPreStepMs = ms;
    if (!st.warm && (st.coldPreStepMs === null || ms > st.coldPreStepMs)) st.coldPreStepMs = ms;
  }

  /**
   * 判定此刻该不该动作。
   * @param {{sessionId:string, seq:number|null, cold:boolean, idle:boolean, now:number}} input
   * @returns {{action:string, reason:string, seq:number|null, growth:number|null}}
   */
  function decide(input) {
    const { sessionId, seq, cold, idle, now } = input;
    const none = (reason) => ({ action: ACTION.NONE, reason, seq, growth: null });
    if (!sessionId) return none('no-session');
    if (!Number.isFinite(seq)) return none('unknown-seq');
    if (!idle) return none('agent-not-idle');

    const st = stateFor(states, sessionId);
    if (st.attempts >= c.maxAttemptsPerSession) return none('max-attempts');
    if (st.busyStreak >= c.maxBusyStreak) return none('busy-streak');
    if (Number.isFinite(st.lastAttemptAt) && now - st.lastAttemptAt < c.cooldownMs) return none('cooldown');

    const growth = Number.isFinite(st.lastCompactedSeq) ? seq - st.lastCompactedSeq : seq - (st.loadedSeq ?? 0);

    // ① 载入后抢跑：只在"本进程首次见到该 Session 且规模已达危险线"时做一次。
    if (cold && !st.coldGuardDone && levelOf(seq, c) === LEVEL.DANGER) {
      return { action: ACTION.GUARD, reason: 'cold-load-danger', seq, growth };
    }
    // ② 回合间主动压缩：按增量触发（seq 永不回落，用增量才不会反复触发）。
    if (seq >= c.warnSeq && growth >= c.minGrowthSeq) {
      return { action: ACTION.COMPACT, reason: 'growth-since-last-compaction', seq, growth };
    }
    return none('below-threshold');
  }

  /**
   * 记录一次尝试的结果。
   * @param {string} sessionId
   * @param {{ok:boolean, code?:string|null, shadowedTokenCount?:number|null, shadowedSeqs?:number|null}} result
   * @param {number} now
   * @param {number|null} seq
   */
  function noteResult(sessionId, result, now, seq) {
    const st = stateFor(states, sessionId);
    const busy = result.code === 'busy';
    if (busy) {
      // busy＝核心侧已有并发压缩或 agent 不空闲：**我们并没有付掉冷重放代价**，
      // 所以不计入 attempts、也绝不能让调用方把该会话标记成"已预热"；
      // 但仍需有上限，否则会和冷却一起变成无限重试。
      st.busyStreak += 1;
      totals.skippedBusy += 1;
      st.lastResult = { at: now, ok: false, code: result.code };
      return st;
    }
    st.busyStreak = 0;
    st.attempts += 1;
    st.lastAttemptAt = now;
    st.lastResult = {
      at: now,
      ok: result.ok === true,
      code: result.code ?? null,
      items: result.shadowedSeqs ?? null,
      tokens: result.shadowedTokenCount ?? null,
    };
    if (result.ok === true) {
      // 不论返回是否真的削减了内容，都把基准推到当前 seq：
      // seq 不回落，只有推基准才能保证"下一次"仍按增量触发。
      if (Number.isFinite(seq)) st.lastCompactedSeq = seq;
      st.coldGuardDone = true;
      if (st.lastResult.tokens === null && result.shadowedSeqs === null) totals.guarded += 1;
      else totals.compacted += 1;
    } else {
      totals.failed += 1;
    }
    return st;
  }

  /** 该 Session 对象已被本插件确认为"热"（重放已完成）。 */
  function markWarm(sessionId) {
    const st = stateFor(states, sessionId);
    st.warm = true;
    st.coldGuardDone = true;
    return st;
  }

  function get(sessionId) {
    return states.get(sessionId) ?? null;
  }

  function stats() {
    return { ...totals, sessions: states.size };
  }

  return { config: () => ({ ...c }), observeLoad, observePreStep, decide, noteResult, markWarm, get, stats, states };
}
