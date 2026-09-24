import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  decodeFrames,
  analyzeFrames,
  isSyntheticCloser,
  extractUserMessage,
  FRAME,
} from '../src/frames.js';

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';

// ---------- 构造帧的工具 ----------
const inbox = (text, t, kind = 'user') => ({
  type: FRAME.INBOX,
  seq: 1,
  time: t,
  data: { target: 'next-turn', start: 0, inserted: [{ id: 'm-' + t, source: { kind, rpcId: 'r' + t }, content: [{ type: 'text', text }] }] },
});
const turnStart = (turn, t) => ({ type: FRAME.TURN_START, seq: 2, time: t, data: { turn } });
const stepStart = (turn, t) => ({ type: FRAME.STEP_START, seq: 3, time: t, data: { turn, step: 1 } });
const assistant = (turn, t) => ({ type: FRAME.ASSISTANT_MESSAGE, seq: 4, time: t, data: { turn, step: 1, message: { role: 'assistant', content: [] } } });
const turnEnd = (turn, t, kind = 'completed') => ({ type: FRAME.TURN_END, seq: 5, time: t, data: { turn, reason: { kind } } });
const endSeed = (t) => ({ type: FRAME.END_SEED, seq: 6, time: t, data: {} });

// ---------- decodeFrames ----------

test('decodeFrames：按 zstd 魔数切帧并逐帧解压', { skip: !HAS_ZSTD && '本机 node 无 zstd 支持' }, () => {
  const f1 = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', id: 's' }) + '\n', 'utf8'));
  const f2 = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'turn/start', time: 1, data: { turn: 1 } }) + '\n', 'utf8'));
  const { frames, frameCount, undecodable } = decodeFrames(Buffer.concat([f1, f2]));

  assert.equal(frameCount, 2);
  assert.equal(undecodable, 0);
  assert.deepEqual(frames.map((f) => f.type), ['session', 'turn/start']);
});

test('decodeFrames：遇到不可解开的帧只计数、不抛出', { skip: !HAS_ZSTD && '本机 node 无 zstd 支持' }, () => {
  const ok = zlib.zstdCompressSync(Buffer.from('{"type":"session"}\n', 'utf8'));
  const junk = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('not-a-real-frame')]);
  const { frames, undecodable } = decodeFrames(Buffer.concat([ok, junk]));

  assert.equal(frames.length, 1);
  assert.ok(undecodable >= 1);
});

// ---------- 合成帧判据 ----------

test('isSyntheticCloser：interrupted 且下一帧是 end-seed ⇒ 合成收尾帧', () => {
  const frames = [turnStart(18, 1000), turnEnd(18, 1001, 'interrupted'), endSeed(2000)];
  assert.equal(isSyntheticCloser(frames, 1), true);
});

test('isSyntheticCloser：正常 completed 轮不算合成帧', () => {
  const frames = [turnStart(1, 1000), stepStart(1, 1010), assistant(1, 1020), turnEnd(1, 1030, 'completed')];
  assert.equal(isSyntheticCloser(frames, 3), false);
});

// ---------- analyzeFrames ----------

test('正常完成的轮：没有挂起轮，也没有未处理消息', () => {
  const a = analyzeFrames([inbox('你好', 1000), turnStart(1, 1010), stepStart(1, 1020), assistant(1, 1030), turnEnd(1, 1040)]);

  assert.equal(a.pendingTurn, null);
  assert.equal(a.stalledTurns.length, 0);
  assert.equal(a.pendingUserMessage, null);
  assert.equal(a.assistantsAfterLastUser, 1);
  assert.equal(a.lastUserMessage.text, '你好');
});

test('挂住的轮（运行时形态）：有 turn/start、无 step，仍未闭合 ⇒ pendingTurn 且消息未处理', () => {
  const a = analyzeFrames([inbox('帮我跑一下', 1000), turnStart(7, 1010)]);

  assert.equal(a.pendingTurn.turn, 7);
  assert.equal(a.pendingTurn.steps, 0);
  assert.ok(a.pendingUserMessage);
  assert.equal(a.pendingUserMessage.text, '帮我跑一下');
});

test('历史挂住的轮（被冷载入合成收尾）：记入 stalledTurns，且该消息仍算未处理', () => {
  const a = analyzeFrames([inbox('历史消息', 1000), turnStart(18, 1010), turnEnd(18, 1011, 'interrupted'), endSeed(2000)]);

  assert.equal(a.syntheticClosers, 1);
  assert.equal(a.stalledTurns.length, 1);
  assert.equal(a.stalledTurns[0].turn, 18);
  assert.equal(a.stalledTurns[0].closedBy, 'synthetic');
  assert.equal(a.pendingTurn, null, '已被修好 ⇒ 运行时不存在挂起轮');
  assert.equal(a.pendingUserMessage.text, '历史消息', '但这条消息确实没被处理过');
});

test('只看最后一条用户消息：更早的轮已产出 assistant 不影响判定', () => {
  const a = analyzeFrames([
    inbox('第一问', 1000), turnStart(1, 1010), stepStart(1, 1020), assistant(1, 1030), turnEnd(1, 1040),
    inbox('第二问', 2000), turnStart(2, 2010), stepStart(2, 2020), assistant(2, 2030), turnEnd(2, 2040),
  ]);

  assert.equal(a.pendingUserMessage, null);
  assert.equal(a.lastUserMessage.text, '第二问');
});

test('最后一条用户消息之后只有 step、没有 assistant ⇒ 仍算未处理', () => {
  const a = analyzeFrames([inbox('第三问', 3000), turnStart(3, 3010), stepStart(3, 3020)]);
  assert.ok(a.pendingUserMessage);
  assert.equal(a.pendingUserMessage.text, '第三问');
  assert.equal(a.assistantsAfterLastUser, 0);
});

test('subagent/系统注入的 inbox 不算用户消息', () => {
  const a = analyzeFrames([
    inbox('父代理转达', 1000, 'agent'),
    inbox('系统提示', 1100, 'system'),
    turnStart(1, 1200),
  ]);
  assert.equal(a.lastUserMessage, null, '非 user 来源不计入');
  assert.equal(a.pendingUserMessage, null);
});

test('extractUserMessage：形状不对时返回 null', () => {
  assert.equal(extractUserMessage(null), null);
  assert.equal(extractUserMessage({ type: FRAME.INBOX, data: {} }), null);
  assert.equal(extractUserMessage({ type: FRAME.INBOX, data: { inserted: [{ source: { kind: 'user' }, content: [] }] } }), null);
});

test('analyzeFrames：空数组与缺 time 的帧都安全', () => {
  const empty = analyzeFrames([]);
  assert.equal(empty.pendingTurn, null);
  assert.equal(empty.pendingUserMessage, null);

  const noTime = analyzeFrames([
    { type: FRAME.INBOX, data: { inserted: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] } },
    { type: FRAME.TURN_START, data: { turn: 1 } },
  ]);
  assert.equal(noTime.pendingUserMessage.text, 'x');
  assert.equal(noTime.pendingTurn.startedAt, null);
});

// ★语义陷阱：正常执行中的轮同样"未闭合" ⇒ 本模块的 pendingTurn 不足以判挂住
test('陷阱③：正常执行中的轮也会 pendingTurn 非空 ⇒ 挂住必须由 detect 的时长判据判定', () => {
  const a = analyzeFrames([
    inbox('问', 1000),
    turnStart(19, 1010),
    stepStart(19, 1020),
    assistant(19, 1030), // 正在正常产出
    // 注意：还没有 turn/end
  ]);

  assert.ok(a.pendingTurn, '未闭合 ⇒ pendingTurn 非空');
  assert.equal(a.pendingTurn.steps, 1);
  assert.equal(a.pendingUserMessage, null, '已有 assistant 输出 ⇒ 消息其实被处理了');
});
