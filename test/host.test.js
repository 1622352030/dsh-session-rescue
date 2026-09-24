import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, name, inject } from '../src/host.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 最小 cordis ctx 假体：只实现本插件用到的面。
 * 注意忠实模拟 cordis 的 `ctx.effect()`：支持「返回 disposer 的函数」与「generator」两种形态
 * （官方 `dsh-command-compact` 用的就是 generator：`ctx.effect(function* () { yield ctx.commands.register(…, "label") })`）。
 */
function fakeCtx() {
  const handlers = new Map();
  const effects = [];
  const commands = [];
  const cancelled = [];
  const resumed = [];
  const disposed = [];
  const liveSessions = new Set();
  let liveAgent = true;
  let resumeThrows = false;

  const ctx = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    effect(fn) {
      effects.push(fn);
      return { dispose() {} };
    },
    sessions: {
      get(id) {
        return liveSessions.has(id) ? { id } : undefined;
      },
    },
    agents: {
      get(id) {
        if (!liveAgent) return undefined;
        return {
          cancel(cause, opts) {
            cancelled.push({ id, cause, opts });
          },
        };
      },
      async resume(options) {
        resumed.push(options);
        if (resumeThrows) throw new Error('cannot prepare session while it is live');
        return { agent: { id: options.resumeSessionId }, dispose: async () => disposed.push(options.resumeSessionId) };
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
    cancelled,
    resumed,
    disposed,
    setLiveAgent(v) { liveAgent = v; },
    setLiveSession(id, v) { if (v) liveSessions.add(id); else liveSessions.delete(id); },
    setResumeThrows(v) { resumeThrows = v; },
    /** 启动插件：忠实模拟 cordis effect 的两种形态 */
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
    emit(event) {
      for (const fn of handlers.get('session/event') ?? []) fn({ id: 'sess-1' }, event);
    },
    /** 造一条"挂住"的事件序列：用户消息 + turn/start，之后没有 step */
    emitStall() {
      const t = Date.now();
      this.emit({ type: 'agent/inbox/spliced', time: t, data: { inserted: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }] } });
      this.emit({ type: 'turn/start', time: t, data: { turn: 7 } });
    },
  };
}

const FAST = { stallMs: 10, pollMs: 5, cooldownMs: 0, retirementTimeoutMs: 120, retirementPollMs: 10 };

test('导出形状符合契约：具名 name / inject / apply（非 default）', () => {
  assert.equal(name, 'session-rescue');
  assert.ok(Array.isArray(inject));
  for (const svc of ['agents', 'commands', 'sessions']) assert.ok(inject.includes(svc), 'inject 应含 ' + svc);
  assert.equal(typeof apply, 'function');
});

test('apply 后订阅 session/event 并注册 /rescue 命令', () => {
  const f = fakeCtx();
  apply(f.ctx, FAST);
  f.start();

  assert.equal(f.handlers.get('session/event')?.length, 1, '必须只通过 session/event 订阅（帧类型名不是事件名）');
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0].desc.name, 'rescue');
});

test('默认 dry-run：判定为挂住也绝不执行任何动作', async () => {
  const f = fakeCtx();
  apply(f.ctx, { ...FAST });
  const stop = f.start();

  f.emitStall();
  await sleep(80);

  assert.equal(f.cancelled.length, 0, 'dry-run 下不得 cancel');
  assert.equal(f.resumed.length, 0, 'dry-run 下不得 resume');
  stop();
});

test('apply 模式：release 必须 keepInbox=true（消息不丢）', async () => {
  const f = fakeCtx();
  apply(f.ctx, { ...FAST, dryRun: false });
  const stop = f.start();

  f.emitStall();
  await sleep(80);

  assert.equal(f.cancelled.length, 1);
  assert.equal(f.cancelled[0].id, 'sess-1');
  assert.equal(f.cancelled[0].cause.kind, 'hook');
  assert.equal(f.cancelled[0].opts.keepInbox, true);
  stop();
});

test('apply 模式：会话已退场 ⇒ 走公开 resume 冷重建，且用 resumeSessionId', async () => {
  const f = fakeCtx();
  f.setLiveSession('sess-1', false); // 已退场
  apply(f.ctx, { ...FAST, dryRun: false });
  const stop = f.start();

  f.emitStall();
  await sleep(120);

  assert.equal(f.resumed.length, 1, '应当尝试一次 resume');
  assert.equal(f.resumed[0].resumeSessionId, 'sess-1');
  stop();
});

test('apply 模式：会话迟迟不退场 ⇒ 有界放弃，绝不无限等（也不调用 resume）', async () => {
  const f = fakeCtx();
  f.setLiveSession('sess-1', true); // 一直 live
  apply(f.ctx, { ...FAST, dryRun: false });
  const stop = f.start();

  const t0 = Date.now();
  f.emitStall();
  await sleep(200);
  const elapsed = Date.now() - t0;

  assert.equal(f.resumed.length, 0, '未退场时不得 resume（否则会撞上无超时的 waitForRetirement）');
  assert.ok(elapsed < 1000, '必须在有界时间内返回，实测耗时 ' + elapsed + 'ms');
  stop();
});

test('apply 模式：resume 抛错 ⇒ 不崩、如实登记', async () => {
  const f = fakeCtx();
  f.setResumeThrows(true);
  apply(f.ctx, { ...FAST, dryRun: false });
  const stop = f.start();

  f.emitStall();
  await sleep(120);

  assert.equal(f.resumed.length, 1);
  const status = f.commands[0].desc.handler({ rawInput: '' });
  assert.equal(status.kind, 'success', '抛错后插件仍应正常工作');
  stop();
});

test('rebuildAfterRelease=false ⇒ 只释放、不 resume', async () => {
  const f = fakeCtx();
  apply(f.ctx, { ...FAST, dryRun: false, rebuildAfterRelease: false });
  const stop = f.start();

  f.emitStall();
  await sleep(100);

  assert.equal(f.cancelled.length, 1);
  assert.equal(f.resumed.length, 0);
  stop();
});

test('mid-turn 默认不动作（实测该判据会在正常长静默上误报）', async () => {
  const f = fakeCtx();
  apply(f.ctx, { ...FAST, dryRun: false });
  const stop = f.start();

  const t = Date.now();
  f.emit({ type: 'turn/start', time: t, data: { turn: 2 } });
  f.emit({ type: 'step/start', time: t, data: { turn: 2 } });
  await sleep(80);

  assert.equal(f.cancelled.length, 0, 'mid-turn 只上报');
  assert.equal(f.resumed.length, 0);
  stop();
});

test('拿不到 live agent 时不抛错、不假装执行', async () => {
  const f = fakeCtx();
  f.setLiveAgent(false);
  apply(f.ctx, { ...FAST, dryRun: false });
  const stop = f.start();

  f.emitStall();
  await sleep(100);

  assert.equal(f.cancelled.length, 0);
  stop();
});

test('/rescue 命令：apply / dry-run / 状态 三个分支都返回成功', () => {
  const f = fakeCtx();
  apply(f.ctx, FAST);
  f.start();

  const handler = f.commands[0].desc.handler;
  assert.match(handler({ rawInput: 'apply' }).text, /apply/);
  assert.match(handler({ rawInput: 'dry-run' }).text, /dry-run/);
  assert.match(handler({ rawInput: '' }).text, /session-rescue/);
});

test('disposer 能停掉轮询（不残留定时器）', async () => {
  const f = fakeCtx();
  apply(f.ctx, { ...FAST, dryRun: false });
  const stop = f.start();
  stop();

  f.emitStall();
  await sleep(60);
  assert.equal(f.cancelled.length, 0, '停止后不应再有巡检动作');
});
