#!/usr/bin/env node
/**
 * tools/measure-replay.js —— 直接用**真实的 TokenMeter 代码**量「冷启动全量重放」的代价。
 *
 * 为什么需要它：README/DESIGN 里那条因果链（冷重放 ⇒ preStep 卡死）有一个反例 ——
 * `/compact` 的第一步就是 `tokenMeter.measure(session)`（`dsh-compaction-basic:935`），
 * 而实测两次 `/compact` 从 command/run 到 compaction/start 只用了 1,013 ms / 1,117 ms
 * （seq 388,770 / 446,452）。本脚本用同一份日志、同一份产品代码，把"重放到底多贵"直接量出来。
 *
 * 做法：
 *   1. 只读解析真实会话日志（zstd 逐帧）。
 *   2. 把批记录还原成逐条 chunk 事件：
 *      `{type:'reasoning-chunks'|'tool-call-chunks'|'text-chunks', seq0, time0, data:{dt:[…]}}`
 *      中 `dt` 是**时间增量**，批内第 i 个分片占 seq = seq0 + i。
 *      展开后 seq 空间应当变稠密 —— 这本身就是格式模型的自我验证。
 *   3. 用 `Object.create(TokenMeter.prototype)` 造一个真 TokenMeter 实例（绕过 cordis 的 Service 构造），
 *      喂一个只实现 `seq` / `eventAt` 的假 session，量冷 `_sync` 与热 `measure()`。
 *
 * 只读；只写 stdout；不打印消息正文。
 * 用法: node tools/measure-replay.js <日志绝对路径> [maxSeqCap]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const FILE = process.argv[2];
const CAP = Number(process.argv[3] || 0); // >0 时只重建前 CAP 个 seq，用于量增长曲线
if (!FILE) {
  console.log('usage: node tools/measure-replay.js <log> [maxSeqCap]');
  process.exit(1);
}

const METER_PATH =
  'C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js';

// ── 1) 读日志 ────────────────────────────────────────────────────────────────
const st = fs.statSync(FILE);
const buf = Buffer.alloc(st.size);
const fd = fs.openSync(FILE, 'r');
fs.readSync(fd, buf, 0, buf.length, 0);
fs.closeSync(fd);

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const idxs = [];
for (let i = 0; ;) {
  const j = buf.indexOf(MAGIC, i);
  if (j < 0) break;
  idxs.push(j);
  i = j + 4;
}
const records = [];
let undecodable = 0;
for (let k = 0; k < idxs.length; k++) {
  const a = idxs[k];
  const b = k + 1 < idxs.length ? idxs[k + 1] : buf.length;
  let txt = '';
  try {
    txt = zlib.zstdDecompressSync(buf.subarray(a, b)).toString('utf8');
  } catch {
    undecodable += 1;
    continue;
  }
  for (const line of txt.split('\n')) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* 忽略损坏行 */
    }
  }
}

// ── 2) 还原成逐条事件 ────────────────────────────────────────────────────────
const BATCH = new Set(['reasoning-chunks', 'tool-call-chunks', 'text-chunks']);
const CHUNK_KIND = {
  'reasoning-chunks': 'reasoning-delta',
  'tool-call-chunks': 'tool-call-delta',
  'text-chunks': 'text-delta',
};
const TEXT_KEY = { 'reasoning-chunks': 'texts', 'tool-call-chunks': 'args', 'text-chunks': 'texts' };

// ── 1b) 展开 sourceEventSeqs 区间 ─────────────────────────────────────────────
// 磁盘上 `sourceEventSeqs` 是**区间数组**，例如 `[[16,72],[74,1473]]`；
// 内存里的 session 才是扁平的逐条 seq 列表（`_estimateProviderAssistant` 就是这么用的，
// 它会逐条 eventAt 并要求每个都是 assistant/chunk —— 这同时是一个免费的校验器）。
function flattenRanges(v) {
  if (!Array.isArray(v)) return v;
  const out = [];
  for (const item of v) {
    if (Array.isArray(item) && item.length === 2 && typeof item[0] === 'number' && typeof item[1] === 'number') {
      for (let s = item[0]; s <= item[1]; s += 1) out.push(s);
    } else if (typeof item === 'number') out.push(item);
  }
  return out;
}
const chunkSeqSet = new Set();
for (const r of records) {
  if (r.sourceEventSeqs === undefined) continue;
  const flat = flattenRanges(r.sourceEventSeqs);
  r.sourceEventSeqs = flat;
  if (Array.isArray(flat)) for (const s of flat) chunkSeqSet.add(s);
}

let maxSeq = 0;
for (const r of records) {
  if (typeof r.seq === 'number' && r.seq > maxSeq) maxSeq = r.seq;
  if (typeof r.seq0 === 'number') {
    const n = r.data?.dt?.length ?? 0;
    if (r.seq0 + n - 1 > maxSeq) maxSeq = r.seq0 + n - 1;
  }
}
const seqCap = CAP > 0 ? Math.min(CAP, maxSeq + 1) : maxSeq + 1;

const events = new Array(seqCap).fill(undefined);
let placed = 0;
let outOfRange = 0;
let curTurn = 0;
let curStep = 0;

for (const r of records) {
  if (BATCH.has(r.type) && typeof r.seq0 === 'number') {
    const dt = r.data?.dt ?? [];
    const texts = r.data?.[TEXT_KEY[r.type]] ?? [];
    if (typeof r.data?.turn === 'number') curTurn = r.data.turn;
    if (typeof r.data?.step === 'number') curStep = r.data.step;
    let t = r.time0 ?? 0;
    for (let i = 0; i < dt.length; i += 1) {
      const seq = r.seq0 + i;
      t += dt[i] ?? 0;
      if (seq >= seqCap) {
        outOfRange += 1;
        continue;
      }
      events[seq] = {
        type: 'assistant/chunk',
        seq,
        time: t,
        data: {
          turn: curTurn,
          step: curStep,
          chunk: { type: CHUNK_KIND[r.type], index: r.data?.index ?? 0, text: texts[i] ?? '' },
        },
      };
      placed += 1;
    }
    continue;
  }
  if (typeof r.seq === 'number') {
    if (r.data && typeof r.data.turn === 'number') curTurn = r.data.turn;
    if (r.data && typeof r.data.step === 'number') curStep = r.data.step;
    if (r.seq >= seqCap) continue;
    events[r.seq] = r;
    placed += 1;
  }
}

const holes = [];
for (let i = 0; i < seqCap; i += 1) if (events[i] === undefined) holes.push(i);

// 空洞填充：批内事件数的模型不是逐位精确（实测稠密度 ≈97.7%），而 `_sync` 遇到 undefined 会直接抛。
// 填充时**沿用最近一条事件的 turn/step** —— 不是可有可无的讲究：`_estimateProviderAssistant`
// 会校验被引用的分片与 assistant/message 属于同一 turn 且同一 step，用 0/0 填会立刻抛错。
// 另外统计有多少空洞落在 sourceEventSeqs 区间内（那些是**确证**的分片，不是猜测）。
let lastTime = 0;
let fTurn = 0;
let fStep = 0;
let confirmedChunkHoles = 0;
for (let i = 0; i < seqCap; i += 1) {
  const e = events[i];
  if (e !== undefined) {
    if (typeof e.time === 'number') lastTime = e.time;
    if (e.data && typeof e.data.turn === 'number') fTurn = e.data.turn;
    if (e.data && typeof e.data.step === 'number') fStep = e.data.step;
    continue;
  }
  if (chunkSeqSet.has(i)) confirmedChunkHoles += 1;
  events[i] = {
    type: 'assistant/chunk',
    seq: i,
    time: lastTime,
    data: { turn: fTurn, step: fStep, chunk: { type: 'block-start', index: 0 } },
    __filler: true,
  };
}

console.log('================ measure-replay ================');
console.log('FILE ' + FILE);
console.log('SIZE ' + st.size + ' B  records=' + records.length + '  undecodableFrames=' + undecodable);
console.log('seq 空间 0..' + (maxSeq) + '（本次重建到 ' + seqCap + '）');
console.log('已放置事件 ' + placed + '；空洞 ' + holes.length + '/' + seqCap +
  '（稠密度 ' + (((seqCap - holes.length) / seqCap) * 100).toFixed(2) + '%，已用廉价占位事件补齐）' +
  (outOfRange ? '；越界丢弃 ' + outOfRange : ''));
if (holes.length) {
  console.log('  空洞样例(前 12): ' + holes.slice(0, 12).join(','));
  console.log('  其中落在 sourceEventSeqs 区间内（确证是分片、非猜测）: ' + confirmedChunkHoles + '/' + holes.length);
}
// 类型直方图（重建后）
const hist = {};
for (const e of events) {
  if (!e) continue;
  hist[e.type] = (hist[e.type] || 0) + 1;
}
console.log('--- 重建后类型直方图 ---');
Object.entries(hist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + String(v).padStart(7) + '  ' + k));

// ── 3) 真 TokenMeter × 假 session ────────────────────────────────────────────
let lastSeq = -1;
const session = {
  seq: seqCap,
  eventAt: (s) => {
    lastSeq = Number(s);
    return events[lastSeq];
  },
};

let TokenMeter;
try {
  ({ TokenMeter } = await import(pathToFileURL(METER_PATH).href));
} catch (err) {
  console.log('无法加载真实 TokenMeter：' + String(err && err.message ? err.message : err));
  process.exit(2);
}

const meter = Object.create(TokenMeter.prototype);
meter.states = new WeakMap();
meter.ctx = { get: () => undefined }; // measure() 只通过它取 llm 的图片计价，取不到即为 undefined

function timeIt(label, fn) {
  const t0 = process.hrtime.bigint();
  let out;
  try {
    out = fn();
  } catch (err) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`${label}: 抛错（${ms.toFixed(1)} ms）— ${String(err && err.message ? err.message : err)}`);
    const stack = String(err && err.stack ? err.stack : '').split('\n').slice(0, 6);
    for (const line of stack) console.log('    ' + line.trim());
    console.log(`  失败位置 lastSeq=${lastSeq}`);
    console.log(`  自检: typeof _sync=${typeof meter._sync} typeof eventAt=${typeof session.eventAt} session.seq=${session.seq}`);
    for (let i = Math.max(0, lastSeq - 2); i <= Math.min(seqCap - 1, lastSeq + 3); i += 1) {
      const e = events[i];
      console.log(`    seq ${i}: ${e ? e.type + (e.__filler ? '(占位)' : '') + ' dataKeys=' + Object.keys(e.data ?? {}).join(',') : 'undefined'}`);
    }
    return null;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${label}: ${ms.toFixed(1)} ms`);
  return { ms, out };
}

console.log('--- 冷重放（_sync 从 seq 0 走一遍）---');
const cold = timeIt('cold _sync', () => meter._sync(session));
if (cold) {
  console.log('  折算：' + (cold.ms * 1000 / seqCap).toFixed(2) + ' µs/seq');
  console.log('--- 热 measure()（状态已同步）---');
  timeIt('warm measure()', () => meter.measure(session));
}
console.log('================================================');
