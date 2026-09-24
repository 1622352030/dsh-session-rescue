import test from 'node:test';
import assert from 'node:assert/strict';

import { STALL_NEVER_STARTED, STALL_MID_TURN } from '../src/detect.js';
import { createRepairPlanner, ACTION, MODE } from '../src/repair-plan.js';

function clock(t0 = 1_000_000) {
  let t = t0;
  return { now: () => t, advance: (d) => { t += d; } };
}

const NEVER = { kind: STALL_NEVER_STARTED, turn: 7, waitedMs: 51_000 };
const MID = { kind: STALL_MID_TURN, turn: 8, waitedMs: 130_000 };

test('never-started + 有未处理消息 ⇒ release → rebuild → redeliver', () => {
  const p = createRepairPlanner({ dryRun: false });
  const plan = p.plan(NEVER, { sessionId: 's1', hasPendingMessage: true });

  assert.equal(plan.mode, MODE.APPLY);
  assert.equal(plan.reason, 'auto-repair');
  assert.deepEqual(plan.actions.map((a) => a.kind), [ACTION.RELEASE, ACTION.REBUILD, ACTION.REDELIVER]);
  assert.equal(plan.giveUp, null);
});

test('未确认有未处理消息 ⇒ 不补投（避免重复执行）', () => {
  const p = createRepairPlanner({ dryRun: false });
  const plan = p.plan(NEVER, { sessionId: 's1' }); // hasPendingMessage 未给
  assert.deepEqual(plan.actions.map((a) => a.kind), [ACTION.RELEASE, ACTION.REBUILD, ACTION.NOTIFY]);
});

test('mid-turn 默认只上报，不产生任何修复动作', () => {
  const p = createRepairPlanner({ dryRun: false });
  const plan = p.plan(MID, { sessionId: 's1', hasPendingMessage: true });
  assert.equal(plan.reason, 'mid-turn-report-only');
  assert.deepEqual(plan.actions.map((a) => a.kind), [ACTION.NOTIFY]);
  assert.equal(plan.giveUp, null);
});

test('显式开启 allowMidTurn 后 mid-turn 才动作（供进阶用户）', () => {
  const p = createRepairPlanner({ dryRun: false, allowMidTurn: true });
  const plan = p.plan(MID, { sessionId: 's1', hasPendingMessage: true });
  assert.equal(plan.reason, 'auto-repair');
  assert.deepEqual(plan.actions.map((a) => a.kind), [ACTION.RELEASE, ACTION.REBUILD, ACTION.REDELIVER]);
});

test('dry-run（首版默认）标记模式但不改变动作内容', () => {
  const p = createRepairPlanner(); // dryRun 默认 true
  const plan = p.plan(NEVER, { sessionId: 's1', hasPendingMessage: true });
  assert.equal(plan.mode, MODE.DRY_RUN);
  assert.deepEqual(plan.actions.map((a) => a.kind), [ACTION.RELEASE, ACTION.REBUILD, ACTION.REDELIVER]);
});

test('冷却期内跳过自动动作', () => {
  const c = clock();
  const p = createRepairPlanner({ dryRun: false, cooldownMs: 120_000, now: c.now });

  p.plan(NEVER, { sessionId: 's1' });
  p.noteApplied('s1');

  c.advance(30_000);
  const plan = p.plan(NEVER, { sessionId: 's1' });
  assert.equal(plan.reason, 'cooldown');
  assert.deepEqual(plan.actions.map((a) => a.kind), [ACTION.NOTIFY]);

  c.advance(120_000); // 越过冷却
  assert.equal(p.plan(NEVER, { sessionId: 's1' }).reason, 'auto-repair');
});

test('达到次数上限后放弃，并说明原因', () => {
  const c = clock();
  const p = createRepairPlanner({ dryRun: false, maxAttemptsPerSession: 2, cooldownMs: 0, now: c.now });

  p.plan(NEVER, { sessionId: 's1' });
  p.noteApplied('s1');
  p.plan(NEVER, { sessionId: 's1' });
  p.noteApplied('s1');

  const plan = p.plan(NEVER, { sessionId: 's1' });
  assert.equal(plan.giveUp, 'attempts-exhausted');
  assert.equal(plan.reason, 'attempts-exhausted');
  assert.deepEqual(plan.actions.map((a) => a.kind), [ACTION.NOTIFY]);
  assert.equal(p.remaining('s1'), 0);
});

test('计次按会话隔离，且窗口滑出后重新可用', () => {
  const c = clock();
  const p = createRepairPlanner({ dryRun: false, maxAttemptsPerSession: 1, cooldownMs: 0, windowMs: 60_000, now: c.now });

  p.plan(NEVER, { sessionId: 'a' });
  p.noteApplied('a');
  assert.equal(p.plan(NEVER, { sessionId: 'a' }).giveUp, 'attempts-exhausted');
  assert.equal(p.plan(NEVER, { sessionId: 'b' }).reason, 'auto-repair', '别的会话不受影响');

  c.advance(61_000);
  assert.equal(p.plan(NEVER, { sessionId: 'a' }).reason, 'auto-repair', '窗口滑出后恢复');
});

test('forget() 清理会话计次', () => {
  const p = createRepairPlanner({ dryRun: false, maxAttemptsPerSession: 1, cooldownMs: 0 });
  p.plan(NEVER, { sessionId: 'a' });
  p.noteApplied('a');
  p.forget('a');
  assert.equal(p.plan(NEVER, { sessionId: 'a' }).reason, 'auto-repair');
});

test('未知判据只上报，不动作', () => {
  const p = createRepairPlanner({ dryRun: false });
  const plan = p.plan({ kind: 'something-new', waitedMs: 1 }, { sessionId: 's1' });
  assert.equal(plan.reason, 'unknown-verdict');
  assert.deepEqual(plan.actions.map((a) => a.kind), [ACTION.NOTIFY]);
});

test('没有判据 ⇒ 空计划（不调用方不产生任何动作）', () => {
  const p = createRepairPlanner();
  const plan = p.plan(null, { sessionId: 's1' });
  assert.equal(plan.reason, 'no-verdict');
  assert.equal(plan.actions.length, 0);
});

test('stats 反映计划/跳过/放弃/已执行', () => {
  const c = clock();
  const p = createRepairPlanner({ dryRun: false, maxAttemptsPerSession: 1, cooldownMs: 0, now: c.now });
  p.plan(NEVER, { sessionId: 'a' });
  p.noteApplied('a');
  p.plan(NEVER, { sessionId: 'a' }); // giveUp
  p.plan(MID, { sessionId: 'a' });   // skip

  const s = p.stats();
  assert.equal(s.planned, 3);
  assert.equal(s.applied, 1);
  assert.equal(s.giveUps, 1);
  assert.equal(s.skipped, 1);
});

// ★运行期开关：config() 返回副本，改它不生效 —— 必须走 setDryRun（否则 /rescue apply 是空操作）
test('陷阱④：setDryRun 才真正切换模式（改 config() 的返回值无效）', () => {
  const p = createRepairPlanner({ dryRun: true });
  assert.equal(p.plan(NEVER, { sessionId: 's' }).mode, MODE.DRY_RUN);

  // 反例：改副本不生效
  p.config().dryRun = false;
  assert.equal(p.plan(NEVER, { sessionId: 's' }).mode, MODE.DRY_RUN, 'config() 是副本，改它无效');

  // 正解
  assert.equal(p.setDryRun(false), false);
  assert.equal(p.plan(NEVER, { sessionId: 's' }).mode, MODE.APPLY);
  assert.equal(p.setDryRun(true), true);
  assert.equal(p.plan(NEVER, { sessionId: 's' }).mode, MODE.DRY_RUN);
});
