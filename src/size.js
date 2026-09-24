/**
 * size.js —— 会话「危险规模」的度量与分级（纯函数，无 I/O，可离线单测）
 *
 * 为什么用 `session.seq` 当驱动量：
 *   DSH 的 token meter 在冷启动时执行
 *     while (state.consumedEvents < session.seq) { fold(eventAt(n)); consumedEvents = n + 1 }
 *   （`@deepseek-ai/dsh-token-meter/lib/index.js:691`）——它**按整数 seq 空间逐格推进**。
 *   而该状态挂在 `WeakMap<Session, state>`（同文件 `:589`）上：进程重启 / 会话载入会产生
 *   新的 Session 对象 ⇒ 状态为空 ⇒ 从 0 重放整份日志。⇒ **seq 的大小就是重放的迭代次数。**
 *
 * ★重要事实：压缩**不会**缩短 seq 空间（会话日志是只追加的，压缩本身还要追加
 *   compaction/start + compaction/summary + compaction/end 三条记录）。所以「seq 超过阈值就压缩」
 *   会反复触发却永远不会让 seq 回落 —— 触发条件必须改成**「自上次压缩以来的增长量」**。
 *
 * 阈值标定（本机实测，会话 session-db08f763，出处见 docs/DESIGN.md）：
 *   seq  35,236  同进程热轮      preStep =    231 ms
 *   seq  45,585  冷启动首轮      preStep = 16,008 ms   ← 已在悬崖边
 *   seq  93,333  冷启动首轮      永不返回（用户等 22~45s 后放弃）
 *   seq 388,757  冷启动首轮      永不返回（用户等 32~47s 后放弃）
 *   seq 446,442  冷启动首轮      永不返回（用户等 41s 后放弃）
 * ⇒ 提醒线取 40,000（冷启动约十几秒，已明显可感），危险线取 80,000（进入"永不返回"区间）。
 */

/** 规模分级 */
export const LEVEL = {
  OK: 'ok',
  WARN: 'warn',
  DANGER: 'danger',
};

/** 默认阈值。全部可被插件配置覆盖。 */
export const DEFAULTS = {
  /** ≥ 此 seq 视为已明显拖慢冷启动 */
  warnSeq: 40_000,
  /** ≥ 此 seq 视为"冷启动首轮可能永不返回" */
  dangerSeq: 80_000,
  /** 自上次压缩以来至少增长这么多 seq 才再次压缩（压缩不缩短 seq，必须用增量判定） */
  minGrowthSeq: 20_000,
  /** 两次压缩尝试之间的最短间隔 */
  cooldownMs: 60_000,
  /** 单会话压缩尝试次数上限（含失败），防止和核心压缩服务互相打架 */
  maxAttemptsPerSession: 6,
  /** 连续被核心以 busy 拒绝的次数上限。busy ≠ 我们付掉了代价，所以不能算作尝试，
   *  但也不能无限重试——超过此值即放弃并如实报告。 */
  maxBusyStreak: 5,
};

/** 读取会话的 seq；不是有限数时返回 null（不猜、不折算）。 */
export function sessionSeq(session) {
  const n = session?.seq;
  return Number.isFinite(n) ? n : null;
}

/** 按 seq 分级。seq 未知时一律 OK —— 宁可不动，也不在信息不足时压缩别人的会话。 */
export function levelOf(seq, cfg = DEFAULTS) {
  if (!Number.isFinite(seq)) return LEVEL.OK;
  if (seq >= cfg.dangerSeq) return LEVEL.DANGER;
  if (seq >= cfg.warnSeq) return LEVEL.WARN;
  return LEVEL.OK;
}

/** 人类可读的规模描述，用于 /rescue status 与日志。 */
export function describe(seq, cfg = DEFAULTS) {
  const lv = levelOf(seq, cfg);
  if (!Number.isFinite(seq)) return 'seq=?';
  const tag = lv === LEVEL.DANGER ? '危险' : lv === LEVEL.WARN ? '提醒' : '正常';
  return `seq=${seq}（${tag}）`;
}
