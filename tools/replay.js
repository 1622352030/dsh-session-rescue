/**
 * tools/replay.js —— 用**真实历史会话日志**回放验证挂住检测器（只读，不打印正文）
 *
 * 为什么要它：`src/detect.js` 的判据来自取证结论（「turn/start 之后没有 step/start」），
 * 必须用真实日志验证它**能命中已知挂住的轮**、且**不在正常轮上误报**。
 *
 * 用法：
 *   node tools/replay.js <会话目录名或日志绝对路径> [stallMs=20000] [--window 2097152]
 *
 * 安全边界：只读；默认只读文件尾部窗口；只输出类型/时间/计数，**不打印任何正文**。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { createStallDetector, FRAME } from '../src/detect.js';
import { createRepairPlanner } from '../src/repair-plan.js';
import { analyzeFrames } from '../src/frames.js';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const stallMs = Number(args.find((a) => /^\d+$/.test(a)) ?? 20000);
const winIdx = args.indexOf('--window');
const WINDOW = winIdx >= 0 ? Number(args[winIdx + 1]) || 2 * 1024 * 1024 : 2 * 1024 * 1024;
const DEBUG = args.includes('--debug');
const PLANNER = args.includes('--plan');

const root = path.join(
  process.env.DSH_HOME ?? path.join(process.env.APPDATA ?? '', 'dsh-desktop', 'harness'),
  'sessions',
);

function resolveLog(t) {
  if (t && fs.existsSync(t) && fs.statSync(t).isFile()) return t;
  for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(root, proj.name);
    for (const s of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      if (s.name === t || s.name.startsWith(t)) {
        const f = path.join(dir, s.name, 'session.jsonl.zstd');
        if (fs.existsSync(f)) return f;
      }
    }
  }
  return null;
}

const file = resolveLog(target);
if (!file) {
  console.log('NOT FOUND: ' + target);
  process.exit(1);
}
const st = fs.statSync(file);
const start = Math.max(0, st.size - WINDOW);
const len = st.size - start;
const buf = Buffer.alloc(len);
const fd = fs.openSync(file, 'r');
fs.readSync(fd, buf, 0, len, start);
fs.closeSync(fd);

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const idxs = [];
for (let i = 0; ;) {
  const j = buf.indexOf(MAGIC, i);
  if (j < 0) break;
  idxs.push(j);
  i = j + 4;
}
const frames = [];
for (let k = 0; k < idxs.length; k++) {
  const a = idxs[k];
  const b = k + 1 < idxs.length ? idxs[k + 1] : buf.length;
  let txt = '';
  try {
    txt = zlib.zstdDecompressSync(buf.subarray(a, b)).toString('utf8');
  } catch {
    continue;
  }
  for (const line of txt.split('\n')) {
    if (!line) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      /* 忽略损坏行 */
    }
  }
}

const local = (ms) => (Number.isFinite(ms) ? new Date(ms + 8 * 3600e3).toISOString().slice(11, 23) : 'n/a');

/**
 * ★关键：识别「冷载入补写的合成收尾帧」并在回放中跳过。
 *
 * 实测（见 docs/DESIGN.md）：会话被冷重建时，harness 会为**未闭合的轮**补写
 * `turn/end {reason:{kind:"interrupted"}}`（必要时还有 `step/end`），且该帧的
 * **time 抄自最后一条真实事件** —— 于是它在日志里看起来"只比开轮晚 1 ms"，
 * 紧跟在 `turn/start` 之后、`session/end-seed` 之前。
 *
 * 如果不跳过它，回放就会把每一次挂住都看成"正常闭合"，必然全部漏报
 * （本脚本第一版就是这样：命中 0/3）。运行时不会有这个帧 —— 它只在下次冷载入时产生。
 */
const synthetic = new Set();
frames.forEach((f, i) => {
  if (f.type === FRAME.TURN_END && f.data?.reason?.kind === 'interrupted' && frames[i + 1]?.type === FRAME.END_SEED) {
    synthetic.add(i);
  }
});
const replayFrames = frames.filter((_, i) => !synthetic.has(i));

// ---- 1) 结构统计：每轮的 step/assistant 数与结束原因（用于得到"已知挂住轮"） ----
const turns = new Map();
let cur = null;
for (const f of frames) {
  const t = f.type;
  if (t === FRAME.TURN_START) {
    cur = { turn: f.data?.turn ?? null, t0: f.time, steps: 0, asst: 0, reason: null };
    turns.set(cur.turn, cur);
  } else if (cur && t === 'step/start') cur.steps += 1;
  else if (cur && t === 'assistant/message') cur.asst += 1;
  else if (t === FRAME.TURN_END && cur) cur.reason = f.data?.reason?.kind ?? '?';
}

const knownStalls = [...turns.values()].filter((r) => r.reason === 'interrupted' && r.steps === 0);

// ---- 2) 检测器回放：按文件顺序"实时到达"，每条事件前先用当前时刻 check() ----
// ★时钟初值必须取「第一个带 time 的帧」：会话首帧是 {"type":"session",…}，**没有 time**，
//   若直接取 replayFrames[0].time 会得到 undefined ⇒ Math.max(undefined, x) = NaN ⇒
//   之后所有比较恒为 false ⇒ 检测器**静默失效**（本脚本第二版就是这样在 C 会话上 0/3 漏报）。
let vnow = replayFrames.find((f) => Number.isFinite(f.time))?.time ?? Date.now();
const det = createStallDetector({ stallMs, now: () => vnow });
// --plan：把每个判定交给策略层，看它在**真实时序**下会做什么（回放一律 dry-run，不产生副作用）
const sessionId = path.basename(path.dirname(file));
const planner = PLANNER
  ? createRepairPlanner({ dryRun: !args.includes('--plan-live'), now: () => vnow })
  : null;
const plans = [];
const hits = [];
for (const f of replayFrames) {
  if (typeof f.time === 'number') vnow = Math.max(vnow, f.time); // 单调，防止回填时间戳让时钟倒退
  const v = det.check(vnow); // 事件之间的"沉默"在这里被判定
  if (v) {
    hits.push({ ...v, at: vnow });
    if (planner) {
      const plan = planner.plan(v, { sessionId, hasPendingMessage: true });
      plans.push({ at: vnow, plan });
      // 回放里把 auto-repair 计划记为"已执行"，以验证冷却/次数上限在真实时序下的行为
      if (plan.reason === 'auto-repair') planner.noteApplied(sessionId);
    }
  }
  if (DEBUG) {
    if (f.type === FRAME.TURN_START) {
      console.log('  [dbg] turn/start turn=' + (f.data?.turn ?? '?') + ' @' + local(vnow) + ' seq=' + f.seq);
    } else if (f.type === FRAME.TURN_END || f.type === FRAME.END_SEED) {
      const p = det.pending();
      if (p) {
        console.log('  [dbg] clear by ' + f.type + ' @' + local(vnow) + ' (pending turn=' + p.turn +
          ' waited=' + Math.round(p.waitedMs / 1000) + 's sawWork=' + p.sawWork + ' seq=' + f.seq + ')');
      }
    }
  }
  det.observe({
    type: f.type,
    time: f.time,
    turn: f.data?.turn ?? null,
  });
}
const tail = det.check(vnow + stallMs * 10);
if (tail) hits.push({ ...tail, at: vnow + stallMs * 10 });

console.log('FILE   ' + file);
console.log('SIZE   ' + st.size + ' B  窗口 offset=' + start + ' bytes=' + len);
console.log('FRAMES ' + frames.length + '（其中合成收尾帧 ' + synthetic.size + ' 个已跳过）→ 回放 ' + replayFrames.length + ' 帧  stallMs=' + stallMs);
console.log('已知挂住轮（step=0 且 reason=interrupted）: ' + knownStalls.length);
for (const r of knownStalls) console.log('   turn ' + r.turn + ' @ ' + local(r.t0));
console.log('检测器判定（' + hits.length + ' 次）:');
for (const h of hits) console.log('   ' + local(h.at) + '  kind=' + h.kind + '  turn=' + h.turn + '  waited=' + Math.round(h.waitedMs / 1000) + 's');

// ---- 3) 命中率与误报 ----
const stallStarts = new Set(knownStalls.map((r) => r.t0));
const detected = new Set();
for (const h of hits) {
  // 检测时刻落在某轮开轮之后、且该轮 step=0 ⇒ 视为命中该轮
  for (const r of turns.values()) {
    if (r.t0 <= h.at && h.at - r.t0 <= 15 * 60 * 1000 && r.steps === 0) detected.add(r.t0);
  }
}
const missed = [...stallStarts].filter((s) => !detected.has(s));
const falsePos = [...detected].filter((s) => !stallStarts.has(s));
console.log('命中已知挂住轮: ' + (stallStarts.size - missed.length) + '/' + stallStarts.size +
  (missed.length ? '  漏报=' + missed.map(local).join(',') : ''));
console.log('疑似误报（在 step>0 的轮上触发，或与已知轮不对应）: ' + falsePos.length +
  (falsePos.length ? '  ' + falsePos.map(local).join(',') : ''));
console.log('检测器统计: ' + JSON.stringify(det.stats()));
// 交叉验证 src/frames.js：它读的是**同一份真实日志**，结论应与上面"合成收尾帧"数一致
const a = analyzeFrames(frames);
console.log('日志分析(frames.js): syntheticClosers=' + a.syntheticClosers +
  ' stalledTurns=' + a.stalledTurns.length + ' [' + a.stalledTurns.map((t) => t.turn).join(',') + ']' +
  ' pendingTurn=' + (a.pendingTurn ? a.pendingTurn.turn : 'none') +
  ' pendingUserMessage=' + (a.pendingUserMessage ? 'yes(len=' + a.pendingUserMessage.text.length + ')' : 'no'));
if (planner) {
  console.log('策略层计划（dry-run，按真实时刻）:');
  for (const { at, plan } of plans) {
    console.log('   ' + local(at) + '  ' + plan.reason + '  [' + plan.actions.map((a) => a.kind).join(' → ') + ']' +
      (plan.giveUp ? '  giveUp=' + plan.giveUp : ''));
  }
  console.log('策略层统计: ' + JSON.stringify(planner.stats()));
}
