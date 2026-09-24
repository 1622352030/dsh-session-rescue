import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, name, inject } from '../src/host.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 最小 cordis ctx 假体：只实现本插件用到的 4 个面。 */
function fakeCtx() {
  const handlers = new Map();
  const effects = [];
  const commands = [];
  const cancelled = [];
  let liveAgent = true;

  const ctx = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    effect(fn) {
      effects.push(fn);
      return { dispose() {} };
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
    setLiveAgent(v) { liveAgent = v; },
    /** 启动插件：忠实模拟 cordis 的 `ctx.effect`——支持「返回 disposer 的函数」与「generator」两种形态
     *  （官方 `dsh-command-compact` 用的就是 generator：`ctx.effect(function* () { yield ctx.commands.register(…, "label") })`） */
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
  };
}

test('导出形状符合契约：具名 name / inject / apply（非 default）', () => {
  assert.equal(name, 'session-rescue');
  assert.ok(Array.isArray(inject));
  assert.ok(inject.includes('agents'));
  assert.ok(inject.includes('commands'));
  assert.equal(typeof apply, 'function');
});

test('apply 后订阅 session/event 并注册 /rescue 命令', () => {
  const f = fakeCtx();
  apply(f.ctx, { stallMs: 10, pollMs: 5 });
  f.start();

  assert.equal(f.handlers.get('session/event')?.length, 1, '必须只通过 session/event 订阅（帧类型名不是事件名）');
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0].desc.name, 'rescue');
});

test('默认 dry-run：判定为挂住也绝不执行 cancel', async () => {
  const f = fakeCtx();
  apply(f.ctx, { stallMs: 10, pollMs: 5 });
  const stop = f.start();

  f.emit({ type: 'agent/inbox/spliced', time: Date.now(), data: { inserted: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }] } });
  f.emit({ type: 'turn/start', time: Date.now(), data: { turn: 1 } });
  await sleep(80);

  assert.equal(f.cancelled.length, 0, 'dry-run 下不得动任何东西');
  stop();
});

test('apply 模式：执行 release，且 cancel 必须 keepInbox=true（消息不丢）', async () => {
  const f = fakeCtx();
  apply(f.ctx, { stallMs: 10, pollMs: 5, dryRun: false, cooldownMs: 0 });
  const stop = f.start();

  f.emit({ type: 'agent/inbox/spliced', time: Date.now(), data: { inserted: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }] } });
  f.emit({ type: 'turn/start', time: Date.now(), data: { turn: 7 } });
  await sleep(80);

  assert.equal(f.cancelled.length, 1);
  assert.equal(f.cancelled[0].id, 'sess-1');
  assert.equal(f.cancelled[0].cause.kind, 'hook');
  assert.equal(f.cancelled[0].opts.keepInbox, true);
  stop();
});

test('mid-turn 默认不动作（实测该判据会在正常长静默上误报）', async () => {
  const f = fakeCtx();
  apply(f.ctx, { stallMs: 10, pollMs: 5, dryRun: false, cooldownMs: 0 });
  const stop = f.start();

  f.emit({ type: 'turn/start', time: Date.now(), data: { turn: 2 } });
  f.emit({ type: 'step/start', time: Date.now(), data: { turn: 2 } });
  await sleep(80);

  assert.equal(f.cancelled.length, 0, 'mid-turn 只上报');
  stop();
});

test('拿不到 live agent 句柄时不抛错、不假装执行', async () => {
  const f = fakeCtx();
  f.setLiveAgent(false);
  apply(f.ctx, { stallMs: 10, pollMs: 5, dryRun: false, cooldownMs: 0 });
  const stop = f.start();

  f.emit({ type: 'turn/start', time: Date.now(), data: { turn: 3 } });
  await sleep(80);

  assert.equal(f.cancelled.length, 0);
  stop();
});

test('/rescue 命令：apply / dry-run / 状态 三个分支都返回成功', () => {
  const f = fakeCtx();
  apply(f.ctx, { stallMs: 10, pollMs: 5 });
  f.start();

  const handler = f.commands[0].desc.handler;
  const a = handler({ rawInput: 'apply' });
  assert.equal(a.kind, 'success');
  assert.match(a.text, /apply/);

  const b = handler({ rawInput: 'dry-run' });
  assert.equal(b.kind, 'success');
  assert.match(b.text, /dry-run/);

  const c = handler({ rawInput: '' });
  assert.equal(c.kind, 'success');
  assert.match(c.text, /session-rescue/);
});

test('disposer 能停掉轮询（不残留定时器）', async () => {
  const f = fakeCtx();
  apply(f.ctx, { stallMs: 10, pollMs: 5, dryRun: false, cooldownMs: 0 });
  const stop = f.start();
  stop();

  f.emit({ type: 'turn/start', time: Date.now(), data: { turn: 4 } });
  await sleep(50);
  assert.equal(f.cancelled.length, 0, '停止后不应再有巡检动作');
});
