import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTION, createGuard } from '../src/guard.js';

const CFG = {
  warnSeq: 40_000,
  dangerSeq: 80_000,
  minGrowthSeq: 20_000,
  cooldownMs: 0,
  maxAttemptsPerSession: 3,
  maxBusyStreak: 3,
};

const T = 1_000_000;
/** 默认场景：冷会话、agent 空闲、规模 20 万（本机实测的真实量级） */
function ask(g, over = {}) {
  return g.decide({ sessionId: 's', seq: 200_000, cold: true, idle: true, now: T, ...over });
}

test('冷会话且已达危险线 ⇒ GUARD（抢在用户首个回合之前压缩）', () => {
  const g = createGuard(CFG);
  g.observeLoad('s', 200_000, false, T);
  const d = ask(g);
  assert.equal(d.action, ACTION.GUARD);
  assert.equal(d.reason, 'cold-load-danger');
});

test('★反抖动：压缩成功后同一 seq 不再触发（seq 永不回落，只能用增量判据）', () => {
  const g = createGuard(CFG);
  g.observeLoad('s', 200_000, false, T);
  g.noteResult('s', { ok: true, shadowedSeqs: 10, shadowedTokenCount: 100 }, T, 200_000);
  g.markWarm('s');
  // 即便仍然把会话当"冷"传进来，coldGuardDone 也必须挡住第二次抢跑
  assert.equal(ask(g, { cold: true }).action, ACTION.NONE);
  assert.equal(ask(g, { cold: false }).action, ACTION.NONE);
});

test('增长达到最小增量 ⇒ COMPACT（回合间主动压缩）', () => {
  const g = createGuard(CFG);
  g.observeLoad('s', 200_000, false, T);
  g.noteResult('s', { ok: true, shadowedSeqs: 1, shadowedTokenCount: 1 }, T, 200_000);
  g.markWarm('s');
  assert.equal(ask(g, { cold: false, seq: 219_999 }).action, ACTION.NONE);
  assert.equal(ask(g, { cold: false, seq: 220_000 }).action, ACTION.COMPACT);
});

test('成功压缩把增量基准推到当前 seq（这是反抖动的根据）', () => {
  const g = createGuard(CFG);
  g.observeLoad('s', 100_000, false, T);
  g.markWarm('s');
  g.noteResult('s', { ok: true, shadowedSeqs: 5, shadowedTokenCount: 50 }, T, 500_000);
  assert.equal(g.get('s').lastCompactedSeq, 500_000);
  assert.equal(ask(g, { cold: false, seq: 510_000 }).action, ACTION.NONE, '仅增长 1 万，不达标');
  assert.equal(ask(g, { cold: false, seq: 525_000 }).action, ACTION.COMPACT, '增长 2.5 万，达标');
});

test('规模未达提醒线 ⇒ 什么都不做', () => {
  const g = createGuard(CFG);
  g.observeLoad('s', 10_000, false, T);
  g.markWarm('s');
  assert.equal(ask(g, { seq: 10_000, cold: false }).action, ACTION.NONE);
});

test('非空闲 / 未知 seq / 无 sessionId ⇒ 一律 NONE 并给出理由', () => {
  const g = createGuard(CFG);
  g.observeLoad('s', 200_000, false, T);
  assert.equal(ask(g, { idle: false }).reason, 'agent-not-idle');
  assert.equal(ask(g, { seq: null }).reason, 'unknown-seq');
  assert.equal(ask(g, { sessionId: '' }).reason, 'no-session');
});

test('冷却期内不重复动作', () => {
  const g = createGuard({ ...CFG, cooldownMs: 60_000 });
  g.observeLoad('s', 200_000, false, T);
  g.noteResult('s', { ok: false, code: 'summary' }, T, 200_000);
  assert.equal(g.decide({ sessionId: 's', seq: 200_000, cold: true, idle: true, now: T + 1_000 }).reason, 'cooldown');
  assert.notEqual(g.decide({ sessionId: 's', seq: 200_000, cold: true, idle: true, now: T + 60_000 }).action, ACTION.NONE);
});

test('★busy 不计入尝试额度（我们并没有付掉冷重放代价），但连续 busy 有上限', () => {
  const g = createGuard(CFG);
  g.observeLoad('s', 200_000, false, T);
  for (let i = 0; i < CFG.maxBusyStreak; i += 1) g.noteResult('s', { ok: false, code: 'busy' }, T + i, 200_000);
  assert.equal(g.get('s').attempts, 0, 'busy 不得消耗尝试额度');
  assert.equal(g.stats().skippedBusy, CFG.maxBusyStreak);
  assert.equal(ask(g).reason, 'busy-streak', '连续 busy 到上限后必须放弃，不能无限重试');
});

test('busy 之后仍允许再次抢跑（会话必须保持"冷"）', () => {
  const g = createGuard(CFG);
  g.observeLoad('s', 200_000, false, T);
  g.noteResult('s', { ok: false, code: 'busy' }, T, 200_000);
  assert.equal(g.get('s').warm, false);
  assert.equal(ask(g).action, ACTION.GUARD);
});

test('尝试次数达上限 ⇒ 放弃并如实停下', () => {
  const g = createGuard(CFG);
  g.observeLoad('s', 200_000, false, T);
  for (let i = 0; i < CFG.maxAttemptsPerSession; i += 1) g.noteResult('s', { ok: false, code: 'summary' }, T + i, 200_000);
  assert.equal(ask(g).reason, 'max-attempts');
});

test('preStep 自观测：冷启动值不会被后续热轮覆盖', () => {
  const g = createGuard(CFG);
  g.observeLoad('s', 200_000, false, T);
  g.observePreStep('s', 16_008); // 本机实测的冷启动首轮
  assert.equal(g.get('s').coldPreStepMs, 16_008);
  g.markWarm('s');
  g.observePreStep('s', 231); // 同进程热轮
  assert.equal(g.get('s').lastPreStepMs, 231);
  assert.equal(g.get('s').coldPreStepMs, 16_008);
});

test('多会话互不影响', () => {
  const g = createGuard(CFG);
  g.observeLoad('a', 200_000, false, T);
  g.observeLoad('b', 1_000, false, T);
  assert.equal(g.decide({ sessionId: 'a', seq: 200_000, cold: true, idle: true, now: T }).action, ACTION.GUARD);
  assert.equal(g.decide({ sessionId: 'b', seq: 1_000, cold: true, idle: true, now: T }).action, ACTION.NONE);
  assert.equal(g.stats().sessions, 2);
});
