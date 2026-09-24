import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, inject, name } from '../src/host.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CFG = {
  enabled: true,
  pollMs: 3_600_000, // 测试里不靠巡检，靠 agent/status 与显式调用
  cooldownMs: 0,
  warnSeq: 40_000,
  dangerSeq: 80_000,
  minGrowthSeq: 20_000,
  maxAttemptsPerSession: 6,
  maxBusyStreak: 5,
};

/** 最小 cordis ctx 假体：只实现本插件用到的面，并忠实模拟 ctx.effect 的两种形态。 */
function fakeCtx({ seq = 200_000, impl } = {}) {
  const handlers = new Map();
  const effects = [];
  const commands = [];
  const calls = [];
  const session = { id: 'sess-1', seq };
  const agent = { session, status: 'idle' };
  const service = {
    async compactNow(a, signal, commandId) {
      calls.push({ agent: a, signal, commandId });
      if (impl) return impl(a, signal, commandId);
      return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1234, summarySeq: 99 };
    },
  };
  const ctx = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    effect(fn) {
      effects.push(fn);
      return { dispose() {} };
    },
    get(serviceName) {
      return serviceName === 'compaction' ? service : undefined;
    },
    agents: {
      get(id) {
        return id === 'sess-1' ? agent : undefined;
      },
    },
    commands: {
      register(desc, label) {
        commands.push({ desc, label });
        return { dispose() {} };
      },
    },
  };
  return {
    ctx,
    handlers,
    effects,
    commands,
    session,
    agent,
    calls,
    /** 忠实驱动 cordis effect：支持「返回 disposer」与「generator」两种形态 */
    start() {
      const disposers = [];
      for (const fn of effects) {
        const r = fn();
        if (r && typeof r.next === 'function') {
          let step = r.next();
          while (!step.done) {
            const v = step.value;
            if (typeof v === 'function') disposers.push(v);
            else if (v && typeof v.dispose === 'function') disposers.push(() => v.dispose());
            step = r.next(v);
          }
        } else if (typeof r === 'function') {
          disposers.push(r);
        }
      }
      return () => disposers.forEach((d) => d());
    },
    emitSession(event) {
      for (const fn of handlers.get('session/event') ?? []) fn(session, event);
    },
    emitIdle() {
      for (const fn of handlers.get('agent/status') ?? []) fn({ agent, status: 'idle' });
    },
  };
}

test('导出形状符合契约：具名 name / inject / apply（非 default）', () => {
  assert.equal(name, 'session-rescue');
  assert.ok(Array.isArray(inject));
  for (const svc of ['agents', 'commands']) assert.ok(inject.includes(svc), 'inject 应含 ' + svc);
  assert.ok(!inject.includes('compaction'), '压缩服务必须可选获取（ctx.get），不能进 inject 否则无压缩的组合会装载失败');
  assert.equal(typeof apply, 'function');
});

test('只通过 session/event 与 agent/status 订阅，并注册 /rescue 命令', () => {
  const f = fakeCtx();
  apply(f.ctx, CFG);
  f.start();
  assert.equal(f.handlers.get('session/event')?.length, 1, '帧类型名不是 cordis 事件名，必须走 session/event');
  assert.equal(f.handlers.get('agent/status')?.length, 1);
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0].desc.name, 'rescue');
});

test('★冷会话已达危险线 ⇒ 在用户首个回合之前抢跑压缩一次', async () => {
  const f = fakeCtx({ seq: 200_000 });
  const api = apply(f.ctx, CFG);
  const stop = f.start();

  f.emitSession({ type: 'session/end-seed', time: Date.now() });
  f.emitIdle();
  await sleep(20);

  assert.equal(f.calls.length, 1, '应当恰好压缩一次');
  assert.match(f.calls[0].commandId, /^session-rescue-guard-/, '必须是 GUARD 路径');
  assert.equal(api.guard.get('sess-1').warm, true);
  assert.ok(f.calls[0].signal, '必须传 AbortSignal');
  stop();
});

test('★反抖动：同一规模下反复空闲不会反复压缩', async () => {
  const f = fakeCtx({ seq: 200_000 });
  apply(f.ctx, CFG);
  const stop = f.start();

  f.emitSession({ type: 'session/end-seed', time: Date.now() });
  f.emitIdle();
  await sleep(20);
  f.emitIdle();
  f.emitIdle();
  await sleep(20);

  assert.equal(f.calls.length, 1, 'seq 不回落，第二次空闲不得再压缩');
  stop();
});

test('会话继续增长并越线 ⇒ 回合之间主动压缩', async () => {
  const f = fakeCtx({ seq: 200_000 });
  apply(f.ctx, CFG);
  const stop = f.start();

  f.emitSession({ type: 'session/end-seed', time: Date.now() });
  f.emitIdle();
  await sleep(20);

  f.session.seq = 225_000; // 增长 2.5 万 ≥ minGrowthSeq
  f.emitIdle();
  await sleep(20);

  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].commandId, /^session-rescue-compact-/, '第二次必须是 COMPACT 路径');
  stop();
});

test('enabled=false ⇒ 只观测，绝不调用压缩', async () => {
  const f = fakeCtx({ seq: 200_000 });
  apply(f.ctx, { ...CFG, enabled: false });
  const stop = f.start();

  f.emitSession({ type: 'session/end-seed', time: Date.now() });
  f.emitIdle();
  await sleep(20);

  assert.equal(f.calls.length, 0);
  stop();
});

test('★核心报 busy ⇒ 不标记预热（冷重放代价尚未支付），且仍可再次尝试', async () => {
  const busy = async () => {
    const e = new Error('busy');
    e.code = 'busy';
    throw e;
  };
  const f = fakeCtx({ seq: 200_000, impl: busy });
  const api = apply(f.ctx, CFG);
  const stop = f.start();

  f.emitSession({ type: 'session/end-seed', time: Date.now() });
  f.emitIdle();
  await sleep(20);
  assert.equal(f.calls.length, 1);
  assert.equal(api.guard.get('sess-1').warm, false, 'busy 后会话必须仍为"冷"，否则用户首轮照样卡死');

  f.emitIdle();
  await sleep(20);
  assert.equal(f.calls.length, 2, 'busy 应允许再次尝试');

  const status = await f.commands[0].desc.handler({ rawInput: 'status' });
  assert.match(status.text, /忙跳过/);
  stop();
});

test('非 busy 失败 ⇒ 如实登记；该 Session 的重放代价已支付，不重复砸', async () => {
  const bad = async () => {
    const e = new Error('no useful summary');
    e.code = 'summary';
    throw e;
  };
  const f = fakeCtx({ seq: 200_000, impl: bad });
  const api = apply(f.ctx, CFG);
  const stop = f.start();

  f.emitSession({ type: 'session/end-seed', time: Date.now() });
  f.emitIdle();
  await sleep(20);
  f.emitIdle();
  await sleep(20);

  assert.equal(f.calls.length, 1, 'measure 已经跑过（代价已付），同一规模不再重试');
  assert.equal(api.guard.get('sess-1').warm, true);
  const status = await f.commands[0].desc.handler({ rawInput: 'status' });
  assert.match(status.text, /失败\(summary\)/);
  stop();
});

test('有未结束的回合 ⇒ 不动手（压缩要求 agent 空闲）', async () => {
  const f = fakeCtx({ seq: 200_000 });
  apply(f.ctx, CFG);
  const stop = f.start();

  const t = Date.now();
  f.emitSession({ type: 'turn/start', time: t, data: { turn: 5 } });
  f.emitIdle();
  await sleep(20);
  assert.equal(f.calls.length, 0, 'turn 未结束不得压缩');

  f.emitSession({ type: 'turn/end', time: t, data: { turn: 5, reason: { kind: 'completed' } } });
  f.emitIdle();
  await sleep(20);
  assert.equal(f.calls.length, 1, '回合结束后即可抢跑');
  stop();
});

test('自观测：从真实帧序里量出 preStep 窗口（turn/start → 首个 step/start）', async () => {
  const f = fakeCtx({ seq: 200_000 });
  const api = apply(f.ctx, CFG);
  const stop = f.start();

  const t0 = 1_700_000_000_000;
  f.emitSession({ type: 'turn/start', time: t0, data: { turn: 1 } });
  f.emitSession({ type: 'step/start', time: t0 + 16_008, data: { turn: 1, step: 1 } });

  assert.equal(api.guard.get('sess-1').lastPreStepMs, 16_008);
  assert.equal(api.guard.get('sess-1').coldPreStepMs, 16_008);

  f.emitSession({ type: 'turn/end', time: t0 + 20_000, data: { turn: 1, reason: { kind: 'completed' } } });
  f.emitSession({ type: 'turn/start', time: t0 + 30_000, data: { turn: 2 } });
  f.emitSession({ type: 'step/start', time: t0 + 30_231, data: { turn: 2, step: 1 } });
  assert.equal(api.guard.get('sess-1').lastPreStepMs, 231);
  assert.equal(api.guard.get('sess-1').coldPreStepMs, 16_008, '冷启动值不应被热轮覆盖');
  stop();
});

test('★载入完成即安排一次抢跑：不依赖 agent/status 是否触发', async () => {
  const f = fakeCtx({ seq: 200_000 });
  apply(f.ctx, { ...CFG, loadGuardDelayMs: 10 });
  const stop = f.start();

  // 故意**不**发 agent/status —— 只发一条 session/end-seed
  f.emitSession({ type: 'session/end-seed', time: Date.now() });
  await sleep(60);

  assert.equal(f.calls.length, 1, '仅凭 session/end-seed 也应触发 GUARD');
  assert.match(f.calls[0].commandId, /^session-rescue-guard-/);
  stop();
});

test('载入抢跑与 agent/status 谁先到都只执行一次', async () => {
  const f = fakeCtx({ seq: 200_000 });
  apply(f.ctx, { ...CFG, loadGuardDelayMs: 10 });
  const stop = f.start();

  f.emitSession({ type: 'session/end-seed', time: Date.now() });
  f.emitIdle();               // 先到
  await sleep(10);
  f.emitSession({ type: 'session/end-seed', time: Date.now() + 1 }); // 又一次载入事件
  await sleep(60);

  assert.equal(f.calls.length, 1, '两个入口都到齐也只能压一次');
  stop();
});

test('/rescue 命令：status / on / off / now 与用法提示', async () => {
  const f = fakeCtx({ seq: 200_000 });
  apply(f.ctx, CFG);
  f.start();
  const handler = f.commands[0].desc.handler;

  const status = await handler({ rawInput: '' });
  assert.equal(status.kind, 'success');
  assert.match(status.text, /阈值/);
  assert.match(status.text, /危险/);

  const off = await handler({ rawInput: 'off' });
  assert.match(off.text, /只观测/);
  const on = await handler({ rawInput: 'on' });
  assert.match(on.text, /自动预防/);

  const now = await handler({ rawInput: 'now', agent: f.agent });
  assert.equal(now.kind, 'success');
  assert.equal(f.calls.length, 1, '/rescue now 应立即压缩一次');
});

test('disposer 能停掉巡检定时器（不残留后台动作）', async () => {
  const f = fakeCtx({ seq: 200_000 });
  apply(f.ctx, { ...CFG, pollMs: 5 });
  const stop = f.start();

  f.emitSession({ type: 'session/end-seed', time: Date.now() });
  stop();
  await sleep(60);

  assert.equal(f.calls.length, 0, '停止后不应再有任何压缩动作');
});

test('没有 compaction 服务时：不崩、如实登记', async () => {
  const f = fakeCtx({ seq: 200_000 });
  f.ctx.get = () => undefined; // 模拟组合里没有压缩服务
  apply(f.ctx, CFG);
  const stop = f.start();

  f.emitSession({ type: 'session/end-seed', time: Date.now() });
  f.emitIdle();
  await sleep(20);
  assert.equal(f.calls.length, 0);

  const status = await f.commands[0].desc.handler({ rawInput: 'status' });
  assert.equal(status.kind, 'success', '缺服务也必须能正常应答');
  stop();
});
