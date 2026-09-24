# dsh-session-rescue

> **状态：v0.2.0 —— 预防型，不是检测型。** 故障机制已定位到具体源码行，并在真实 5.9 MB 会话日志上实测；
> 插件逻辑有 **55 项测试**覆盖。**尚未在活体 Harness 上跑通端到端**，且有一个机制环节（压缩为何让下一次
> 冷启动变便宜）在形式上仍未证明 —— 见下文「已知边界」。

一个用于 DeepSeek Harness 的插件，用来消除**冷启动首轮卡死**：重启或载入会话之后，第一个回合可能永久卡住，
界面一直转圈、日志里没有任何报错。本插件通过**在会话规模进入危险区之前主动压缩**来阻止它发生。

## 问题本身（精确定位）

卡死的会话日志长这样，而且全程**没有任何错误**：

```
agent/inbox/spliced     ← 用户消息被接收
turn/start              ← 回合打开
                        ← 然后永远没有下文：没有 step/start，没有任何 assistant 帧
```

这段静默正好落在 `preStep` 窗口内，即 `turn/start` 与 `step/start` 之间。原因**不是缺超时、也不是网络**，
而是**在窗口内同步重放了整份会话日志**：

| 环节 | 出处 |
|---|---|
| 重启 / 载入会话会创建**新的 `Session` 对象** | `@deepseek-ai/dsh-session/lib/index.js:1322` 在载入时补写 `session/end-seed` |
| token meter 的重放状态挂在 `WeakMap<Session, state>` 上 | `@deepseek-ai/dsh-token-meter/lib/index.js:589` |
| 新对象 ⇒ 状态为空 ⇒ 从 0 重放 | `dsh-token-meter/lib/index.js:679-697`：`while (state.consumedEvents < session.seq)` |
| 而它在**每个** pre-step 都被调用 | `dsh-compaction-basic/lib/index.js:782`（挂 `agent/pre-step`）→ `:862` `meter.measure(session)` |
| 于是重放正好跑在 `turn/start` 与 `step/start` 之间 | `dsh-agent-loop/lib/index.js:528` → `:539` → `:553` |

这个循环是**同步**的：它阻塞事件循环，所以 `step/start` 永远写不出来，`while (await this.turn())` 永不返回。
界面就一直转圈。

在同一个真实会话上实测（`session-db08f763`，5.9 MB，seq 空间约 51.7 万）：

| 回合 | 开轮时 seq | 冷/热 | `preStep` 耗时 |
|---|---|---|---|
| 2 | 35,236 | 热（同进程） | **231 ms** |
| 5 | 45,585 | **冷**（进程刚重启） | **16,008 ms** |
| 7 / 28–30 / 34–35 | 9.3 万 / 38.9 万 / 44.6 万 | **冷** | 永不返回（用户等 20–47 秒后放弃） |
| 8 / 31 / 36 | 同样规模，但**在 `/compact` 之后** | 冷 | 1.6 s / 10.1 s / 4.7 s ✅ |

由此得到三个可直接对照日志验证的性质：

- **重启没用，而且更糟** —— 每次重启都是对一个更长的日志再做一次冷重放。
- **`/compact` 有用** —— 这是唯一真正救回过这些会话的操作。
- **单纯"大"不是触发条件** —— 同样 23.3 万 token，一个温热回合成功、一个冷启动回合失败。
  **决定生死的是重放发生在什么时候，不是会话有多大。**

## 插件怎么修

重放躲不掉 —— 但**这笔账付在哪里是可以选的**。付在用户第一个回合里就是永久卡死；付在载入后的空闲期
就只是启动慢一次。而一旦压缩跑过，之后的冷启动就会一直保持便宜。

1. **GUARD（抢跑）**：当会话被载入本进程、且 `seq` 已越过危险线时，在**用户第一个回合之前**
   （`agent/status → idle`）把它压缩掉。把躲不掉的代价从回合里挪出去，同时把 surface 变小。
2. **COMPACT（回合间主动压缩）**：回合之间、agent 空闲时，只要自上次压缩以来的增长达到配置值就压缩，
   使未来的冷启动保持在秒级。
3. **报告**：`/rescue status` 给出每个会话的 `seq`、本进程是否已经付过重放代价（热/冷），
   以及插件自测的 `preStep` 窗口耗时（`turn/start` → 首个 `step/start`），冷热分开记。

动作只走一个官方接口：压缩服务的 `ctx.compaction.compactNow(agent, signal, commandId)`
（契约出处：`@deepseek-ai/dsh-command-compact/lib/index.js:8,54`）。该服务用 `ctx.get('compaction')`
**可选获取**而非 `inject`，因此在没有压缩服务的组合里插件仍能装载并如实报告。

### 反抖动（为什么触发条件是"增量"）

压缩**不会**让 `session.seq` 回落 —— 会话日志是只追加的，压缩本身还要追加自己的记录。
所以"`seq` 超过阈值就压缩"这条规则会在每次空闲无限重复触发。真正的触发条件是
**"自上次压缩以来至少增长了 `minGrowthSeq`"**，并且一次成功的压缩会把基准推到当前 `seq`。
这两点都在 `test/guard.test.js` 里有专门的测试。

`busy` 也被单独对待：它表示核心拒绝了本次调用（已有并发压缩，或 agent 不空闲），
**我们并没有付掉重放代价**，因此插件**不会**把该会话标记为"已预热" —— 否则这个冷会话会错过抢跑，
用户的下一个回合照样卡死。重试频率由冷却时间与"连续 busy 上限"约束。

## 配置

```yaml
- insert:
    - id: session-rescue
      name: dsh-session-rescue
      config:
        enabled: true        # false = 只观测并报告，绝不压缩
        warnSeq: 40000       # 从这个规模开始提醒/压缩
        dangerSeq: 80000     # 越过此线，冷启动首轮可能永不返回
        minGrowthSeq: 20000  # 自上次压缩以来至少增长这么多才再压
        cooldownMs: 60000
        maxAttemptsPerSession: 6
        maxBusyStreak: 5
        pollMs: 30000
        compactionTimeoutMs: 600000
```

默认阈值按上表标定（`4 万` 处冷启动首轮已约 16 秒；`8 万` 处进入"永不返回"区间）。
阈值与机器和会话形态有关 —— 请用 `/rescue status` 量出你自己机器上的数再调。

## 仓库内容

| 路径 | 说明 |
|---|---|
| `src/host.js` | host 侧入口：`session/event` + `agent/status` 接线、GUARD/COMPACT 执行、`/rescue`。 |
| `src/guard.js` | 纯决策状态机 —— 何时抢跑、何时压缩、冷却、次数上限、`busy` 处理。 |
| `src/size.js` | 危险区的规模度量与阈值，标定数据写在注释里。 |
| `src/detect.js` | **仅离线使用**：会话事件上的挂住签名检测器（供回放工具使用）。 |
| `src/frames.js` | **仅离线使用**：只读日志分析 —— 逐帧 zstd 解码、合成收尾帧识别。 |
| `bin/dsh-session-rescue.mjs` | 只读扫描 CLI —— **不安装插件也能用**。 |
| `tools/replay.js` | 把真实会话日志回放给检测器，核对命中率与误报率。 |
| `test/*.test.js` | 55 项单元与集成测试（`node --test`），跑在伪造的 cordis ctx 上。 |
| `cordis.patch.yml` | 插件自带的装载补丁层（`dsh.bundle.patch`）。 |
| `tools/Install-Plugin.ps1` | 幂等安装 / 回滚 DSH profile —— 默认干跑、基于快照、自带离线自测。 |
| `docs/DESIGN.md` | 设计说明：带源码出处的机制、修复方式、边界与未决问题。 |

## 已知边界（先说清楚）

- **尚未在活体 Harness 上端到端验证。** 逻辑由针对伪造 `ctx` 的单元/集成测试覆盖；机制由源码阅读
  加上真实会话日志的实测支撑。**目前还没有受控复现。**
- **规模阈值是代理量。** 真正花时间的是重放的单事件代价，而那在不付代价的前提下无法从外部测到。
  `seq` 是这个循环的驱动量、且读取免费，所以用它作代理 —— 它是**标定**出来的，不是推导出来的。
- **有一个环节未证明。** 压缩在三次观测中都让下一次冷启动变便宜了（永不返回 → 1.6–10 秒），
  但**原因尚未确立**：它不可能来自"缩短重放"，因为 `seq` 不回落。插件依赖的是这个实测效果，
  该疑点记在 `docs/DESIGN.md` 的未决问题里。
- **压缩要花一次 LLM 调用**（在观测到的 30 万 token 会话上约 15–20 秒），并且会把历史改写成摘要 ——
  这是对会话的**真实改动**，与 `/compact` 的行为相同。只要报告不要动作就设 `enabled: false`。
- v0.1 的做法（检测挂住 → cancel → 冷重建）**已被移除**：这个卡死是同步 CPU 循环，
  `signal.throwIfAborted()` 根本没机会执行，取消无法打断它。

## 只读扫描 CLI（无需安装）

```sh
node bin/dsh-session-rescue.mjs scan --stalled-only     # 挂住过、或当前有未闭合回合的会话
node bin/dsh-session-rescue.mjs scan --all --json       # 所有工作区分组，机器可读
```

只读会话日志（尾部窗口，**绝不打印消息正文**）。

## 开发

```sh
node --test test/size.test.js test/guard.test.js test/host.test.js
node --test test/detect.test.js test/frames.test.js   # 离线取证
node tools/replay.js <session-id> 20000                # 用真实日志回放验证挂住判据
```

## 兼容性

针对 **DSH Desktop 0.8.2 + `@deepseek-ai/dsh@0.1.2-rc.1`** 开发 —— 上文所有行号都读自该安装版本。

## 许可

MIT
