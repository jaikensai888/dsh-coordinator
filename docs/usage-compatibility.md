# 用量采集与 SQLite 兼容性验证（Task 0）

日期：2026-10-23。范围：本机（Windows x64）上的 DSH 宿主、两个实现仓库的 Node 版本、
SQLite 驱动可用性，以及 DSH runtime 的模型调用入口。本文只记录**实际执行过的检查**；
未执行的项明确写“未验证”。

## 1. 环境矩阵

| 项目 | 值 | 取得方式 |
|---|---|---|
| 本机 CLI Node | `v24.11.1` | `node -v` |
| pnpm | `11.5.1` | `pnpm -v` |
| DSH Desktop | Electron `44.7.0` | `ELECTRON_RUN_AS_NODE=1 "E:\DSH2\DeepSeek Harness.exe" -e "process.versions"` |
| DSH 宿主 Node | `24.21.0` | 同上 |
| DSH 宿主 ABI | `modules: 149` | 同上 |
| dsh-node / dsh-coordinator `engines` | `node >= 20`（未修改） | 两个 `package.json` |
| 服务器发布基线 | Node `24.12.0` / pnpm `10.30.3` | `docs/fabu.md`（文档基线，本轮未 SSH 登录核验） |

宿主探测命令与输出（只读，不启动应用窗口）：

```
$env:ELECTRON_RUN_AS_NODE="1"
& 'E:\DSH2\DeepSeek Harness.exe' -e "console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,modules:process.versions.modules}))"
{"node":"24.21.0","electron":"44.7.0","modules":"149","platform":"win32","arch":"x64"}
```

## 2. SQLite 驱动

### 2.1 `better-sqlite3`（契约中的候选）

- 候选版本 `12.4.1`，`package.json` 有原生 install 脚本。
- **本机无法安装**：`https://registry.npmjs.org/better-sqlite3` 与
  `https://registry.npmmirror.com/better-sqlite3` 均连接失败（`基础连接已经关闭: 接收时发生错误`），
  本地 pnpm store 与 `node_modules` 中也没有该包。没有网络就没有预编译包，也没有编译工具链下载，
  因此“干净安装 + 加载”这一项**未验证**，不能假装通过。
- 结论：**不把 `better-sqlite3` 作为硬依赖**。代码在它存在时优先使用（Coordinator），
  不存在时回退到 `node:sqlite`；Node 插件因架构约束只用 `node:sqlite`（见 2.3）。

### 2.2 `node:sqlite`

在本机 Node 24.11.1 与 DSH 宿主 Node 24.21.0 上都能加载，实测：

| 能力 | 结果 |
|---|---|
| `new DatabaseSync(file)` | 通过 |
| `PRAGMA journal_mode=WAL` | 返回 `wal` |
| `PRAGMA synchronous=FULL` / `foreign_keys=ON` / `busy_timeout=1000` | 通过 |
| `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` | 通过（事务回滚后无残留表） |
| INTEGER 64 位写入 `9223372036854775807n` | 通过 |
| `setReadBigInts(true)` 读回 | `9223372036854775807n`，无精度损失 |
| 写入 `9223372036854775808n` | 拒绝（`ERR_INVALID_ARG_VALUE`），未静默截断 |
| 关闭后重开、WAL 数据可见 | 通过 |

`node:sqlite` 在 Node 中仍标记为 Experimental，会打印一次 `ExperimentalWarning`；
本轮不把它写进 `engines` 下限，也不升级用户宿主。

### 2.3 版本边界（明确的兼容性事实）

`node:sqlite` 从 Node 22.5 起提供，而两个仓库仍声明 `node >= 20`。因此在 Node 20 上：

- Coordinator 打开数据库会以 `coordinator/sqlite-unavailable` 失败，服务拒绝启动，
  不会退化成“空状态继续运行”；
- Node 插件会以 `nodeUsage/storage-unavailable` 报告采集不可用，Gateway 与节点连接仍照常工作。

这是**已知边界**：要支持 Node 20 必须引入原生 `better-sqlite3` 并解决离线安装/构建问题，
属于需要单独授权的依赖决策，本轮没有擅自修改 `engines` 或宿主版本。

Node 插件的架构守卫（`test/integration.test.ts`）禁止 `require`、`createRequire`、
动态模块加载、`eval` 与进程派生。因此插件内的驱动只通过
`process.getBuiltinModule('node:sqlite')` 获取内置模块——它只能解析 Node 内置名，
不构成任意代码加载通道。

## 3. 真实 DSH runtime 的采集入口

DSH 桌面安装包内的 `@deepseek-ai/dsh-llm`（`E:\DSH2\resources\app.asar\dsh\node_modules\...`）
中确认了以下实现（读取发布产物，不是本地源码猜测）：

```js
// lib/types/index.js
streamWithRegistration(options, prepared) {
  return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))
}
```

- `GenerateOptions` 声明：`provider: string`、`model: string`、`sessionId?: SessionId`、
  `purpose?: 'compaction' | 'session-title'`。观察器因此能拿到真实 provider/model 与用途。
- `StreamChunk` 含 `{ type: 'usage'; usage: TokenUsage }` 与
  `{ type: 'finish'; reason: FinishReason }`，且协议规定 usage 先于 finish、finish 是最后一个 chunk。
- `TokenUsage`：`inputTokens`、`outputTokens`、`totalTokens?`、`cacheReadTokens?`、
  `cacheWriteTokens?`、`reasoningTokens?`。
- DeepSeek 适配器把 `input_tokens→inputTokens`、`cache_read_input_tokens→cacheReadTokens`、
  `cache_creation_input_tokens→cacheWriteTokens`，并计算
  `totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`。
  这就是契约把 `inputTokens` 解释为“未缓存输入”、四个桶互斥的原因。
- `FinishReasonMap`：`stop` / `tool-calls` / `max-tokens` / `aborted` / `error`。
  映射为 `completed` / `cancelled` / `failed`，与契约一致。

覆盖范围（按该实现推断并写入契约）：

- 所有经 `ctx.llm.stream()` 的调用都会经过 `llm/stream` waterfall：agent loop、压缩
  （`purpose: 'compaction'`）、标题生成（`purpose: 'session-title'`）、原生子代理调用。
- 重试由 `dsh-llm-retry` 在同一 agent step 重新发起 `stream()`，因此每次重试是新的 attempt，
  观察器会看到多次调用——符合“重试按调用计”。
- 观察器包装的是返回的 async iterable，逐 chunk 原样 yield，异常照常抛出，消费者
  `return()` 会关闭底层迭代器；存储失败只上报告 issue，不改变流内容。

**未验证项**：本轮没有真实 provider 凭据，也没有制造真实模型调用；上述结论来自
发布产物的实现阅读 + fixture 级观察器测试（`N/test/usage-collector.test.ts`）。
“在真实会话里跑一次 DeepSeek 调用并看到 usage 落库”需要在有凭据的机器上补做，
不能用 fixture 代替。

## 4. 结论与最小调整

1. 使用 `node:sqlite` 作为实际驱动（本机与 DSH 宿主均已验证），`better-sqlite3` 保留为可选优先项；
   离线环境无法安装后者，属于原计划 Task 0 允许的“有界选择”结果。
2. 不修改两个仓库的 `engines`，不升级用户 DSH；Node < 22.5 的行为已定义为明确错误。
3. 发布流程必须确认目标服务器 Node ≥ 22.5（文档基线 24.12.0 满足），
   并在 `pnpm install --ignore-scripts` 之后检查 `node -e "process.getBuiltinModule('node:sqlite')"`
   可用；不需要为新依赖放宽全部 install 脚本。
4. 真实 provider 调用与跨机器 ABI 仍需在部署机器上按本文第 2、3 节命令复核一次。
