/**
 * dsh-session-rescue —— 会话日志（只读）解析
 *
 * 宿主插件需要它做两件事：
 *  1) **复核**：实时检测说"这一轮挂住了"时，从磁盘日志确认该轮确实没有被处理；
 *  2) **补什么**：取出那条**未被处理**的用户消息，供 `redeliver-message` 动作使用。
 *
 * 安全边界：只读文件；默认只读尾部窗口；返回值里可能含消息文本，但**本模块不打印任何正文**。
 *
 * 帧格式（实测）：`session.jsonl.zstd` 是「每次追加一个 zstd 帧」，
 * 因此必须按魔数 `28 B5 2F FD` 切帧后逐帧解压（整文件一次性解压会失败）。
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export const FRAME = {
  SESSION: 'session',
  INBOX: 'agent/inbox/spliced',
  TURN_START: 'turn/start',
  TURN_END: 'turn/end',
  STEP_START: 'step/start',
  ASSISTANT_MESSAGE: 'assistant/message',
  END_SEED: 'session/end-seed',
  USER_MESSAGE: 'user/message',
};

/**
 * 纯函数：把一段字节切成 zstd 帧并解析成对象数组（不可解开的帧会被跳过并计数）。
 * @param {Buffer} buf
 * @returns {{frames: object[], undecodable: number, frameCount: number}}
 */
export function decodeFrames(buf) {
  const offsets = [];
  for (let i = 0; ;) {
    const j = buf.indexOf(ZSTD_MAGIC, i);
    if (j < 0) break;
    offsets.push(j);
    i = j + 4;
  }
  const frames = [];
  let undecodable = 0;
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    let text = '';
    try {
      text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    } catch {
      undecodable += 1;
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        /* 忽略无法解析的行 */
      }
    }
  }
  return { frames, undecodable, frameCount: offsets.length };
}

/**
 * 只读读取会话日志。默认只读**尾部窗口**，避免整份读入一个大文件。
 * @param {string} filePath
 * @param {{windowBytes?: number}} [opts]
 */
export function readSessionFrames(filePath, opts = {}) {
  const windowBytes = Number.isFinite(opts.windowBytes) ? opts.windowBytes : 2 * 1024 * 1024;
  const st = fs.statSync(filePath);
  const start = Math.max(0, st.size - windowBytes);
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, len, start);
  } finally {
    fs.closeSync(fd);
  }
  const decoded = decodeFrames(buf);
  return { ...decoded, size: st.size, mtime: st.mtimeMs, windowOffset: start };
}

/**
 * ★合成收尾帧判据（实测）：`turn/end {reason:{kind:"interrupted"}}` 的**下一帧是 `session/end-seed`**
 * ⇒ 该帧由冷载入/resume 补写，其 `time` 抄自最后一条真实事件（所以看起来"只晚 1 ms"）。
 * 它表示「上一段挂住了，重启时被修好」，**不是**运行时真的中止。
 */
export function isSyntheticCloser(frames, index) {
  const f = frames[index];
  return (
    f?.type === FRAME.TURN_END &&
    f.data?.reason?.kind === 'interrupted' &&
    frames[index + 1]?.type === FRAME.END_SEED
  );
}

/** 从 `agent/inbox/spliced` / `user/message` 帧里取出「用户消息」的文本与 id（可能为 null）。 */
export function extractUserMessage(frame) {
  if (!frame) return null;
  if (frame.type === FRAME.INBOX) {
    const item = frame.data?.inserted?.[0];
    const src = item?.source;
    if (!item || (src && src.kind !== 'user')) return null;
    const text = item.content?.find?.((c) => c.type === 'text')?.text;
    if (typeof text !== 'string') return null;
    return { text, id: item.id ?? null, at: frame.time ?? null, rpcId: src?.rpcId ?? null };
  }
  if (frame.type === FRAME.USER_MESSAGE) {
    const text = frame.data?.content?.find?.((c) => c.type === 'text')?.text;
    if (typeof text !== 'string') return null;
    return { text, id: frame.data?.id ?? null, at: frame.time ?? null, rpcId: frame.data?.source?.rpcId ?? null };
  }
  return null;
}

/**
 * 纯函数：分析一组帧，回答「历史挂住过几次」「当前有没有未闭合的轮」「最后一条用户消息处理了没有」。
 *
 * 语义区分（重要）：
 *  - `stalledTurns`：被**合成收尾帧**收尾的轮 ⇒ 历史上挂住过（已被冷重建修好）；
 *  - `pendingTurn`：**未闭合**的轮（没有 turn/end，也没有 end-seed）。
 *    ★**`pendingTurn` 非空 ≠ 挂住**：一轮正常执行期间同样是"未闭合"的。
 *    实测（本仓库当前会话）：`pendingTurn=19` 时该轮正在正常产出。
 *    ⇒ **是否挂住必须由 `src/detect.js`（带时长/缺失信号）判定**，本模块只回答"结构上有没有闭合"；
 *  - `pendingUserMessage`：最后一条用户消息之后**没有任何 assistant 输出** ⇒ 这条消息没被处理。
 *    （注意：它也可能只是"刚开始跑、还没输出"，因此同样应由 detect 的时长判据把关。）
 */
export function analyzeFrames(frames) {
  const synthetic = [];
  const stalledTurns = [];
  let pendingTurn = null;
  let lastUser = null;
  let assistantsAfterLastUser = 0;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const syntheticHere = isSyntheticCloser(frames, i);
    if (syntheticHere) synthetic.push(i);

    if (f.type === FRAME.INBOX || f.type === FRAME.USER_MESSAGE) {
      const msg = extractUserMessage(f);
      if (msg) {
        lastUser = msg;
        assistantsAfterLastUser = 0;
      }
      continue;
    }

    if (f.type === FRAME.TURN_START) {
      pendingTurn = { turn: f.data?.turn ?? null, seq: f.seq ?? null, startedAt: f.time ?? null, steps: 0 };
      continue;
    }

    if (pendingTurn && f.type === FRAME.STEP_START) {
      pendingTurn.steps += 1;
      continue;
    }

    if (f.type === FRAME.ASSISTANT_MESSAGE) {
      assistantsAfterLastUser += 1;
      continue;
    }

    if (f.type === FRAME.TURN_END) {
      if (syntheticHere && pendingTurn) stalledTurns.push({ ...pendingTurn, closedBy: 'synthetic' });
      pendingTurn = null;
      continue;
    }

    if (f.type === FRAME.END_SEED) {
      pendingTurn = null;
      continue;
    }
  }

  return {
    syntheticClosers: synthetic.length,
    stalledTurns,
    pendingTurn,
    lastUserMessage: lastUser,
    pendingUserMessage: lastUser && assistantsAfterLastUser === 0 ? lastUser : null,
    assistantsAfterLastUser,
  };
}
