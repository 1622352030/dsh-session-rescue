#!/usr/bin/env node
/**
 * dsh-session-rescue —— 只读扫描 CLI
 *
 * 用途：**不需要把插件装进 DSH**，直接扫本机会话日志，回答三个问题：
 *   1) 哪些会话**历史上挂住过**（被冷载入补写的合成收尾帧收尾的轮）；
 *   2) 哪些会话**当前有未闭合的轮**（可能正在挂住，也可能只是正在正常执行）；
 *   3) 哪些会话**有一条没被处理的用户消息**。
 *
 * 安全边界：只读；默认每个文件只读**尾部窗口**；**不打印任何消息正文**（只给长度）。
 *
 * 用法：
 *   node bin/dsh-session-rescue.mjs scan [--window 262144] [--stalled-only] [--json] [--all]
 *   默认只看本机 `$DSH_HOME/sessions` 下的当前工作区 bucket；`--all` 扫所有 bucket。
 */

import fs from 'node:fs';
import path from 'node:path';

import { readSessionFrames, analyzeFrames } from '../src/frames.js';

const DEFAULT_WINDOW = 256 * 1024;
const BUCKET = '--D-English_path-deepseek_harness-ddt-36--';

function parseArgs(argv) {
  const opts = { cmd: 'scan', window: DEFAULT_WINDOW, stalledOnly: false, json: false, all: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'scan') opts.cmd = 'scan';
    else if (a === '--window') opts.window = Number(argv[++i]) || DEFAULT_WINDOW;
    else if (a === '--stalled-only') opts.stalledOnly = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--help' || a === '-h') opts.cmd = 'help';
  }
  return opts;
}

function sessionsRoot() {
  const home = process.env.DSH_HOME
    || path.join(process.env.APPDATA ?? '', 'dsh-desktop', 'harness');
  return path.join(home, 'sessions');
}

function findSessionFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const bucket of fs.readdirSync(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    const bucketDir = path.join(root, bucket.name);
    for (const s of fs.readdirSync(bucketDir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const dir = path.join(bucketDir, s.name);
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (f.isFile() && f.name.startsWith('session.jsonl.zstd')) {
          out.push({ bucket: bucket.name, sessionDir: s.name, file: path.join(dir, f.name), offline: f.name.endsWith('.offline') });
        }
      }
    }
  }
  return out;
}

const localTime = (ms) => (Number.isFinite(ms)
  ? new Date(ms + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19)
  : 'n/a');
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

function scanOne(entry, windowBytes) {
  try {
    const { frames, size, mtime, undecodable } = readSessionFrames(entry.file, { windowBytes });
    const a = analyzeFrames(frames);
    return {
      id: entry.sessionDir,
      bucket: entry.bucket,
      offline: entry.offline,
      size,
      mtime,
      undecodable,
      frames: frames.length,
      syntheticClosers: a.syntheticClosers,
      stalledTurns: a.stalledTurns.map((t) => t.turn),
      pendingTurn: a.pendingTurn ? a.pendingTurn.turn : null,
      pendingSteps: a.pendingTurn ? a.pendingTurn.steps : null,
      hasUnprocessedMessage: Boolean(a.pendingUserMessage),
      unprocessedLength: a.pendingUserMessage ? a.pendingUserMessage.text.length : 0,
    };
  } catch (err) {
    return { id: entry.sessionDir, bucket: entry.bucket, offline: entry.offline, error: String(err?.message ?? err) };
  }
}

const HELP = `dsh-session-rescue — 只读扫描本机会话日志，找出「挂住过」与「当前未闭合」的会话

用法：
  node bin/dsh-session-rescue.mjs scan [选项]

选项：
  --window <bytes>   每个会话只读尾部多少字节（默认 ${DEFAULT_WINDOW}）
  --stalled-only     只列出「历史挂住过」或「当前未闭合」的会话
  --all              扫描所有工作区 bucket（默认只扫本项目的 bucket）
  --dir <path>       指定 sessions 根目录
  --json             以 JSON 输出（便于脚本消费）

说明：全程只读；不打印任何消息正文。`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cmd === 'help') {
    console.log(HELP);
    return 0;
  }

  const root = opts.dir ? path.resolve(opts.dir) : sessionsRoot();
  if (!fs.existsSync(root)) {
    console.error('找不到 sessions 目录：' + root);
    return 2;
  }

  let entries = findSessionFiles(root);
  if (!opts.all && !opts.dir) entries = entries.filter((e) => e.bucket === BUCKET);
  if (entries.length === 0) {
    console.error('该目录下没有会话日志：' + root);
    return 2;
  }

  const rows = entries.map((e) => scanOne(e, opts.window));
  const interesting = rows.filter((r) => r.syntheticClosers > 0 || r.pendingTurn !== null || r.error);
  interesting.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  const shown = opts.stalledOnly ? interesting : rows;

  if (opts.json) {
    console.log(JSON.stringify({ root, scanned: rows.length, interesting: interesting.length, rows: shown }, null, 2));
    return 0;
  }

  console.log('sessions 根目录：' + root);
  console.log(`扫描 ${rows.length} 个会话（每个只读尾部 ${opts.window} 字节）｜其中"有情况"的 ${interesting.length} 个\n`);
  const head = ['会话', '大小', '最后写入', '历史挂住', '轮号', '当前未闭合', '未处理消息'];
  console.log(head.join('\t'));
  for (const r of shown) {
    if (r.error) {
      console.log([r.id, '—', '—', '—', '—', '读取失败', r.error.slice(0, 40)].join('\t'));
      continue;
    }
    console.log([
      r.id.replace(/^session-/, '').slice(0, 12) + (r.offline ? '(offline)' : ''),
      mb(r.size),
      localTime(r.mtime),
      r.syntheticClosers || '',
      r.stalledTurns.length ? r.stalledTurns.join(',') : '',
      r.pendingTurn === null ? '' : `turn ${r.pendingTurn} (step=${r.pendingSteps})`,
      r.hasUnprocessedMessage ? `有(len=${r.unprocessedLength})` : '',
    ].join('\t'));
  }

  console.log('\n提示：');
  console.log('  · "历史挂住"= 曾被冷载入补写的合成收尾帧收尾的轮（= 重启时被修好的挂住）。');
  console.log('  · "当前未闭合" **不等于** 正在挂住——正常执行中的轮同样未闭合，');
  console.log('    是否挂住需由插件的时长判据（turn/start 后无 step）在运行时判定。');
  return 0;
}

process.exitCode = main();
