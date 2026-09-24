import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStallDetector,
  STALL_NEVER_STARTED,
  STALL_MID_TURN,
} from '../src/detect.js';

/** 可注入时钟：避免真的等待，保证判定确定性。 */
function clock(t0 = 1_000_000) {
  let t = t0;
  return {
    now: () => t,
    at: () => t,
    set: (v) => { t = v; },
    advance: (d) => { t += d; },
  };
}

const T0 = 1_000_000;
const STALL = 45_000;

test('turn/start 之后一直没有 step ⇒ never-started（阈值边界：恰好达到即判定）', () => {
  const c = clock(T0);
  const d = createStallDetector({ stallMs: STALL, now: c.now });

  assert.equal(d.observe({ type: 'turn/start', turn: 7, time: T0 }), null);
  assert.equal(d.check(T0 + STALL - 1), null, '差 1ms 不应触发');

  const v = d.check(T0 + STALL);
  assert.ok(v, '恰好达到阈值应触发');
  assert.equal(v.kind, STALL_NEVER_STARTED);
  assert.equal(v.turn, 7);
  assert.equal(v.waitedMs, STALL);
});

test('turn/start → step/start 后停住 ⇒ mid-turn（阈值按最后一次活动算）', () => {
  const c = clock(T0);
  const d = createStallDetector({ stallMs: STALL, now: c.now });

  d.observe({ type: 'turn/start', turn: 3, time: T0 });
  d.observe({ type: 'step/start', turn: 3, time: T0 + 100 });

  assert.equal(d.check(T0 + 100 + STALL - 1), null);
  const v = d.check(T0 + 100 + STALL);
  assert.ok(v);
  assert.equal(v.kind, STALL_MID_TURN);
  assert.equal(v.waitedMs, STALL);
});

test('轮内持续有 assistant/tool 事件 ⇒ 不判定', () => {
  const c = clock(T0);
  const d = createStallDetector({ stallMs: STALL, now: c.now });

  d.observe({ type: 'turn/start', turn: 1, time: T0 });
  for (let i = 0; i < 10; i++) {
    const t = T0 + i * (STALL - 1_000);
    d.observe({ type: 'step/start', turn: 1, time: t });
    d.observe({ type: 'assistant/chunk', turn: 1, time: t + 10 });
    d.observe({ type: 'tool/call', turn: 1, time: t + 20 });
    assert.equal(d.check(t + 20), null, `第 ${i} 次活动后不应判定`);
  }
});

test('turn/end 清除挂起状态（含冷载入补写的合成收尾帧）', () => {
  const c = clock(T0);
  const d = createStallDetector({ stallMs: STALL, now: c.now });

  d.observe({ type: 'turn/start', turn: 5, time: T0 });
  d.observe({ type: 'turn/end', turn: 5, time: T0 + 1 }); // 时间戳抄自最后一条真实事件，故可能几乎相同

  assert.equal(d.pending(), null);
  assert.equal(d.check(T0 + 10 * STALL), null, '已闭合的轮不应再被判定为挂住');
});

test('session/end-seed 清除挂起状态（会话被冷重建过）', () => {
  const c = clock(T0);
  const d = createStallDetector({ stallMs: STALL, now: c.now });

  d.observe({ type: 'turn/start', turn: 9, time: T0 });
  d.observe({ type: 'session/end-seed', time: T0 + 6_000 });

  assert.equal(d.pending(), null);
  assert.equal(d.check(T0 + 10 * STALL), null);
});

test('上一轮未闭合就来了新 turn/start ⇒ 记入 abandonedTurns', () => {
  const c = clock(T0);
  const d = createStallDetector({ stallMs: STALL, now: c.now });

  d.observe({ type: 'turn/start', turn: 2, time: T0 });
  d.observe({ type: 'turn/start', turn: 3, time: T0 + 500 });

  const p = d.pending();
  assert.equal(p.turn, 3);
  assert.deepEqual(p.abandonedTurns, [2]);
});

test('非工作帧推进活动时间但不把轮标记为“已干活”', () => {
  const c = clock(T0);
  const d = createStallDetector({ stallMs: STALL, now: c.now });

  d.observe({ type: 'turn/start', turn: 4, time: T0 });
  d.observe({ type: 'user/message', turn: 4, time: T0 + 5_000 });

  assert.equal(d.pending().sawWork, false);
  // 判定用「自开轮起」的时长 ⇒ 仍在未开始阈值之前
  assert.equal(d.check(T0 + STALL - 1), null);
  const v = d.check(T0 + STALL);
  assert.ok(v);
  assert.equal(v.kind, STALL_NEVER_STARTED);
});

test('resolve() 清空状态并计数；stats() 反映观测与清除', () => {
  const c = clock(T0);
  const d = createStallDetector({ stallMs: STALL, now: c.now });

  d.observe({ type: 'turn/start', turn: 8, time: T0 });
  d.check(T0 + STALL);          // 1 次判定
  assert.ok(d.resolve());
  assert.equal(d.pending(), null);
  assert.equal(d.check(T0 + 99 * STALL), null);

  const s = d.stats();
  assert.equal(s.observed, 1);
  assert.equal(s.verdicts, 1);
  assert.ok(s.cleared >= 1);
});

test('忽略形状不对的输入', () => {
  const c = clock(T0);
  const d = createStallDetector({ now: c.now });
  assert.equal(d.observe(null), null);
  assert.equal(d.observe({}), null);
  assert.equal(d.observe({ type: 123 }), null);
  assert.equal(d.stats().observed, 0);
});

// ★下面两组用例对应回放实测踩到的两个陷阱（见 src/detect.js 顶部注释）

test('陷阱①：合成收尾帧若被照单全收，会把挂住误读为正常闭合', () => {
  const c = clock(T0);
  const d = createStallDetector({ stallMs: STALL, now: c.now });

  d.observe({ type: 'turn/start', turn: 18, time: T0 });
  // 冷载入补写的合成 closer：time 抄自最后一条真实事件 ⇒ 只晚 1ms
  d.observe({ type: 'turn/end', turn: 18, time: T0 + 1 });

  assert.equal(d.check(T0 + 10 * STALL), null, '这就是「漏报」的形态：调用方必须自己剔除合成帧');
});

test('陷阱②：时钟为 NaN 时不得静默失效（回放第二版 0/3 漏报的根因）', () => {
  const c = clock(T0);
  const d = createStallDetector({ stallMs: STALL, now: c.now });

  d.observe({ type: 'turn/start', turn: 1, time: T0 });
  assert.equal(d.check(NaN), null, 'NaN 不应崩溃');
  assert.equal(d.check(undefined), null);

  // 时钟恢复为有限值后，判定必须立即生效（而非永久失效）
  const v = d.check(T0 + STALL);
  assert.ok(v, 'NaN 之后仍应能正常判定');
  assert.equal(v.kind, STALL_NEVER_STARTED);
});

test('没有 time 字段的帧使用注入时钟', () => {
  const c = clock(T0);
  const d = createStallDetector({ stallMs: STALL, now: c.now });

  d.observe({ type: 'turn/start', turn: 2 }); // 无 time
  assert.equal(d.pending().startedAt, T0);
  assert.ok(d.check(T0 + STALL));
});
