# dsh-session-rescue

> **状态：开发中 —— 尚未在真实 harness 上验证。** host 侧插件本体、检测 / 策略 / 日志分析三个模块
> 以及一个只读扫描 CLI 已经实现，有 **46 个测试**覆盖；**尚未安装进任何 DSH profile**，
> client 侧状态界面未实现。本 README **只声明代码真正做到的事**。

一个用来**就地救回「挂住的会话轮次」**的 Harness 插件 —— 而不是让用户去重启整个应用。

## 它针对的问题

Harness 会话卡住时，日志的结尾是这样的：

```
agent/inbox/spliced     ← 用户消息被收下
turn/start              ← 轮次开起来了
                        ← 然后什么都没有：没有 step/start，也没有 assistant 帧
```

这条路径**没有超时**，`session/prompt` 这条调用**无法取消**，Web 客户端**也没有请求超时** ——
所以界面只会一直转圈且不报错。已被观察到能让这类会话恢复的动作是**从磁盘冷重建**（应用重启时会做：
补写收尾帧 + 写 `session/end-seed`），代价高且作用于所有会话；`/compact` 之后之所以能跑，
也是因为那时 agent 已经被冷重建、回到空闲。

## 设计行为

1. **检测**：`turn/start` 之后在可配置窗口内没有 `step/start`（或没有任何新活动）⇒ 判定挂住。
2. **释放**：取消该会话当前挂起的那一轮（公开链路 `ctx.agents.get(id).cancel(…, { keepInbox: true })`），
   **不重启应用**、**尽量不丢那条消息**。
3. **上报**：通过 `/rescue` 命令给出状态与最近事件。
4. **绝不**：修改 Harness 包、改写会话日志、影响其它会话、重启应用。

## 明确写在前面的限制

- **「就地重建会话」没有实现**。本机这个 harness 版本**没有**公开 API 能重载一个「活着的」会话，
  而唯一能 `dispose()` 活 agent 的句柄只交给创建它的消费方（见 `docs/DESIGN.md`）。
  因此插件**只释放挂起轮并保留待处理消息**，不会假装做过重建；`rebuild-session` 会以
  `no-public-api` 如实登记。
- 检测器的 `mid-turn` 判据默认**只上报**：在真实日志上它会在正常的长静默上误报（实测 31–119 s），
  而 `never-started`（开了轮就没动过）在全部已知挂住样本上命中且零误报。
- 尚未在真实 harness 上验证（见 `docs/DESIGN.md`）。

## 只读扫描 CLI（**不需要安装插件**）

```sh
node bin/dsh-session-rescue.mjs scan --stalled-only     # 只列出挂住过或当前有未闭合轮的会话
node bin/dsh-session-rescue.mjs scan --all --json        # 扫所有工作区 bucket，机器可读
node bin/dsh-session-rescue.mjs scan --window 2097152    # 每会话读更多历史（更慢）
```

只读会话日志（只读尾部窗口，**从不打印消息正文**），报告：被冷载入合成收尾帧收尾过多少轮、
当前是否有未闭合的轮、以及未处理消息的字节长度。
**「当前未闭合」不等于「挂住」** —— 正常执行中的轮同样未闭合。请在你自己的机器上跑一次，它只读日志。

## 开发

```sh
node --test test/detect.test.js test/repair-plan.test.js test/frames.test.js test/host.test.js
node tools/replay.js <session-id> 20000 --plan          # 用真实日志回放验证判据与策略
```

## 仓库内容

| 路径 | 说明 |
|---|---|
| `src/host.js` | host 侧插件入口：订阅 `session/event` → 轮询判定 → 出策略 → apply 模式下释放挂起轮 |
| `src/detect.js` | 挂住检测状态机（零依赖、时钟可注入） |
| `src/repair-plan.js` | 有界修复策略：每会话次数上限、冷却、默认 dry-run、保守补投 |
| `src/frames.js` | 只读日志分析：逐帧 zstd 解压、合成收尾帧判据、未处理消息定位 |
| `bin/dsh-session-rescue.mjs` | 只读扫描 CLI（可不装插件直接用） |
| `test/*.test.js` | 46 个单元/冒烟测试 |
| `cordis.patch.yml` | 插件自带的装载补丁层（`dsh.bundle.patch`） |
| `tools/Install-Plugin.ps1` | 幂等安装 / 回滚 DSH profile —— 默认干跑、基于快照、自带离线自测 |
| `docs/DESIGN.md` | 设计说明：针对的故障、为什么恢复需要谨慎、判据与边界 |
| `tools/Install-Plugin.ps1` | 幂等安装 / 回滚 DSH profile —— 默认干跑、基于快照、自带离线自测 |
| `docs/DESIGN.md` | 设计说明：针对的故障、为什么恢复需要谨慎、判据与边界 |

## 兼容性

针对 **DSH Desktop 0.8.2 + `@deepseek-ai/dsh@0.1.2-rc.1`**（本机实际安装的版本；
本机逐包实测）。peer 范围会在入口点定稿后声明。

## 许可

MIT
