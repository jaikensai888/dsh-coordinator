# GROUND-TRUTH — dsh-coordinator

> 这份文件只记**能被复现的事**。每条结论都带标记：
>
> - `[实测]` —— 我在某个时刻真的跑过，命令与输出可复现；写明环境与时间。
> - `[源码]` —— 从读代码得出，未运行。
> - `[待验证]` —— 推断，**不要当事实用**。
>
> 环境（2026-09-20）：Windows、Node v24.11.1、pnpm 11.8.0、`ws` 8.18.0、
> 对端 DSH Desktop 2.0.13（`@deepseek-ai/*` 0.1.5-rc.2）、`dsh-node` 0.1.0。
> 仓库：本仓库 `G:\claude_project\code-agent\dsh-coordinator`，
> 节点侧 `G:\claude_project\code-agent\dsh-node`。

---

## §0 现在的状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| Phase 1 | 出站 WS + 握手 + unary 转发 + 重连心跳（`dsh-node`） | 完成，355 测试 |
| Phase 2 | stream 转发（`dsh-node`） | 完成，已并入上述测试数 |
| Phase 3 | `nodeAdmin/*` 管理 Remote（`dsh-node`） | 完成，已并入上述测试数 |
| Phase 4 | **Coordinator 服务端（本仓库）** | 代码完成；自测见 §1；与真 DSH 联调见 §2 `[实测]` |

Phase 4 的验收基准是 `dsh-node/docs/COORDINATOR.md` §2 的 8 条契约。逐条对应关系：

| # | 契约 | 本实现 | 证据 |
| --- | --- | --- | --- |
| 1 | 接受节点主动发起的 WS 连接 | `server.ts` 的 `WebSocketServer`（只监听回环） | §2.1（真节点）+ §1.1（夹具） |
| 2 | 验证 `protocolVersion` / token / `nodeId` / `mode` | `frame-codec.ts` + `node-registry.ts` | §1.5、§3.1 |
| 3 | `hello.ok` 带 connection ID、心跳间隔、帧/并发上限 | `session.ts#acceptHello` | §1.1（帧逐字输出）+ §2.1 |
| 4 | 能发 `rpc.request` / `stream.open` / 取消 / 心跳 | `session.ts#invoke` / `#openStream` / `#startHeartbeat` | §2.1（真 unary + 真 stream） |
| 5 | 能处理 unary result、stream data/end/error | `request-table.ts` / `stream-hub.ts` | §1.2、§1.3、§2.1 |
| 6 | 不要求节点监听入站端口 | 节点侧无任何监听（`dsh-node` 自身测试断言） | `dsh-node` 架构守卫 |
| 7 | 不把 `nodeName` 当安全身份 | `node-registry.ts#authenticate` 只读 `nodeId` + token | §1.5 |
| 8 | 断线要有明确状态 | `session.ts#teardown` → `offline`，`unbind` 保留 `lastSeenAt` | §1.6、§2.1 |
| — | Node 视图（`/api/nodes`、`/api/node`、`/api/capabilities`） | `node-registry.ts#view` | §2.2 |
| — | Session 视图（只读，`/api/sessions`、`/api/session/page`） | `server.ts#listSessions` / `#pageSessions` | §2.2（130 条真会话） |

---

## §1 `[实测]` 端到端自测：两个真实进程，真实 loopback socket

命令（三个终端，或 §2 里用的后台作业）：

```powershell
node lib/cli.js --port 39480 --enroll-token e2e-secret-token-1 --log-level debug
node tools/fake-node.mjs --url ws://127.0.0.1:39480/node --node-id fake-node-e2e --token e2e-secret-token-1 --log
curl.exe -s http://127.0.0.1:39480/api/nodes
```

`tools/fake-node.mjs` 是**节点侧**的最小实现。它的作用是**归因**：
它和真 `dsh-node` 行为不一致 ⇒ 协议问题；一致 ⇒ Coordinator 问题。

### §1.1 握手与登记 `[实测]`

节点侧日志（逐帧，凭据已脱敏）：

```
frame/out {"type":"hello","nodeId":"fake-node-e2e","mode":"full-access","auth":{"type":"bearer","token":"«redacted»"}}
frame/in  {"type":"hello.ok","nodeId":"fake-node-e2e","connectionId":"fake-node-e2e:mu991fam:i9qc2yvv",
           "heartbeatIntervalMs":30000,"maxFrameBytes":4194304,"acceptedMode":"full-access"}
frame/out {"type":"ready","connectionId":"fake-node-e2e:mu991fam:i9qc2yvv","capabilities":{…}}
```

`GET /api/nodes`（此时该 `nodeId` **从未被预先登记**，是共享密钥登记路径）：

```json
{"ok":true,"value":[{"nodeId":"fake-node-e2e","state":"ready",
  "connectionId":"fake-node-e2e:mu990qrm:5rfp4yru",
  "connectedAt":"2026-09-20T03:20:27.013Z","lastSeenAt":"2026-09-20T03:20:27.013Z",
  "remoteSurfaceHash":"fake-node-surface-1","capabilityCount":2,
  "inFlightRequests":0,"activeStreams":0,"revoked":false}]}
```

结论：契约 1、2、3 成立；`connectionId` 确实下发；能力摘要被缓存（`capabilityCount=2`）。

### §1.2 unary 转发 `[实测]`

```
POST /api/invoke {"nodeId":"fake-node-e2e","endpoint":"demo/echo","args":{"text":"hello-coordinator","n":42}}
→ {"ok":true,"value":{"echoed":{"text":"hello-coordinator","n":42},"at":1789874437239}}
```

节点侧同时收到 `rpc.request`，`payload.args` **逐字一致**（`{"text":"hello-coordinator","n":42}`）——
这是 Typert `assertExactArguments` 要求的形状。

失败路径：

```
POST /api/invoke {"endpoint":"demo/refuse"}  → HTTP 200 {"ok":false,"error":{"code":"session/not-found",…}}
POST /api/invoke {"endpoint":"nope/missing"} → HTTP 409 {"code":"coordinator/capability-mismatch",…}
POST /api/invoke {"endpoint":"justone"}      → HTTP 400 {"code":"coordinator/invalid-arguments",…}
POST /api/invoke {"nodeId":"ghost"}          → HTTP 404 {"code":"coordinator/node-unknown",…}
```

**节点报的业务码原样保留，并且是 HTTP 200**：调用方要靠 code 决定是否重试，
把它埋进 5xx 就丢掉了这个信息（`http-api.ts` 的 catch 分支按 `coordinator/` 前缀分流）。

> ⚠️ 这条是**跑出来才发现**的：初版把 `session/not-found` 映射成了 502。

### §1.3 stream 转发 `[实测]`

```
POST /api/stream {"nodeId":"fake-node-e2e","endpoint":"demo/tick","args":{"limit":3}}
→ {"type":"open","streamId":"s-1-igv2ot","endpoint":"demo/tick"}
  {"type":"data","value":{"tick":1}}
  {"type":"data","value":{"tick":2}}
  {"type":"data","value":{"tick":3}}
  {"type":"end","count":3}
```

请求前后 `GET /api/stats` 的 `activeStreams` 都是 0（已释放）。节点侧日志显示
`stream.ready` → `stream.data`(seq 1,2,3) → `stream.end`，参数 `{"limit":3}` 原样抵达。

### §1.4 心跳与半开检测 `[实测]`

节点侧每秒发 `ping`，Coordinator 每条都回 `pong`（节点日志逐条可见）。
Coordinator 侧同时按自己的节奏发 `ping`（默认 30 s），节点回 `pong`。
两端都实现了「容忍 2 个周期后判定半开」——**双向**都有探活。

### §1.5 身份绑定与拒绝语义 `[实测]`

| 场景 | 对外结果 |
| --- | --- |
| 共享密钥匹配、`nodeId` 未知 | 登记并接受（日志 `coordinator/enrollment-secret-in-use` 提醒轮换） |
| 共享密钥关闭（默认）| `coordinator/auth-rejected`，关闭码 `node/auth-failed` + WS `4401` |
| token 不匹配 | 同上（**对外与「未知 nodeId」完全一致**，避免 nodeId 枚举） |
| 已撤销 | 同上 + `details.reason: revoked`（只在本地日志） |

### §1.6 重复连接与撤销 `[实测]`

同一个 `nodeId` 第二次连上时：

- 旧连接收到 `close {code:"node/protocol-invalid", reason:"a newer connection replaced this one", reconnect:false}`，
  socket 关闭码 1000；
- `GET /api/nodes` 里始终只有 **1** 个 `ready`（新 `connectionId`），`stats.sessions = 1`。

`POST /api/nodes/revoke`：

```
→ {"ok":true,"value":{…,"state":"closing","revoked":true}}
撤销后 stats: {"nodes":1,"ready":0,"revoked":1,"sessions":0}
节点收到： close {code:"node/auth-failed", reconnect:false} + socket close 4401
之后 invoke: 409 {"code":"coordinator/node-offline", … "state":"offline"}
```

`4425`/`4401` 这类私有码是**故意的**：`dsh-node` 的 `AUTH_WEBSOCKET_CODES = {4401, 4403}` 命中后走
「慢速且有限」的凭据重试路径，而不是热重连风暴。

### §1.7 运维 API 的鉴权 `[实测]`

`--api-token` 打开后：

```
无 token      → 401
错误 token    → 401
正确 token    → 200
```

非回环绑定且没有 `apiToken` ⇒ **整块 API 不安装**（不是「装上了但没鉴权」）。
非回环绑定且没有 `allowInsecureBind` ⇒ 启动即拒绝（`coordinator/invalid-arguments`）。

### §1.8 一键验证驱动 `[实测]`

```
node tools/verify-live.mjs --api http://127.0.0.1:39482 --api-token verify-api-token \
  --wait 10000 --unary demo/echo --expect-denied 'demo/refuse:{}' --stream demo/tick
```

```
PASS a ready node appeared — fake-node-driver after 34 ms
PASS the node handshake produced a connectionId — fake-node-driver:mu993lm3:bimxqka2
PASS the node advertised capabilities — count=2 hash=fake-node-surface-1
PASS the capability surface is readable — 2 endpoints
PASS at least one stream Remote is advertised — demo/tick
PASS unary demo/echo succeeded — object{echoed,at}
PASS unary demo/refuse was refused with a code — {"code":"session/not-found",…}
PASS stream endpoint under test — demo/tick
PASS stream demo/tick opened — {"type":"open","streamId":"s-1-hxiifh","endpoint":"demo/tick"}
PASS stream demo/tick produced values — values=2
PASS stream demo/tick reached a terminal frame — {"type":"end","count":2}
PASS the node is still ready after every call — ready
PASS no request or stream leaked — {"inFlightRequests":0,"activeStreams":0}

all checks passed (129 ms)
```

这个脚本是**与真 DSH 联调用的同一个脚本**（§3），所以「自测通过」和「真机通过」在方法上是同一件事。

---

## §2 `[实测]` 与真 DSH 节点的联调（2026-09-20 完成）

**怎么做的不重要，结论重要**：用一个**第二个真 DSH 实例**跑通了全链路，不需要动你正在用的
desktop 实例，也不需要重启它。方法（可复现）：

```powershell
# 1) 把插件挂进 web profile（一次性；用完删掉这个 junction）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-node" `
  -Target 'G:\claude_project\code-agent\dsh-node'
# 2) 一份临时 overlay：自带身份文件与一次性 token，allowedRoots 指向插件 checkout
#    （文件在 dsh-coordinator/.tmp/web-verify-overlay.yml）
# 3) 起真 Coordinator（共享密钥登记，待验证）
node lib/cli.js --port 39471 --enroll-token verify-live-token-2 --log-level debug
# 4) 起第二个真 DSH（纯 Node，无 GUI，独立端口）
$env:ELECTRON_RUN_AS_NODE="1"
& "E:\DSH\DSH Desktop\DSH Desktop.exe" --expose-internals `
  "E:\DSH\DSH Desktop\resources\app\lib\desktop-cli.js" `
  --profile web --patch <overlay.yml> --port 43999 --no-open
```

节点侧日志与 Coordinator 侧状态一致：节点**主动连出**并完成 `hello` → `hello.ok` → `ready`，
Coordinator 侧 `GET /api/nodes` 显示：

```json
{"nodeId":"node-742588c3a1c9a1f6d3004caa40c8a4a9","state":"ready",
 "connectionId":"node-742588c3a1c9a1f6d3004caa40c8a4a9:mu99n51p:fx2uo2bj",
 "remoteSurfaceHash":"sha256:e75efd007fdf153a9a7df7efd0b90d44c152019d3a2625c936d79ecac62ec408",
 "capabilityCount":97,"inFlightRequests":0,"activeStreams":0,"revoked":false}
```

能力面（来自真 Typert Gateway）：**93 个 unary + 4 个 stream**，20 个命名空间，
其中 `nodeAdmin/*` 13 个（Phase 3 的管理面）全在表里；4 个 stream 端点是
`session/control`、`session/follow`、`workspace/follow`、`workspaceFiles/changes`。

### §2.1 `[实测]` 逐项检查（`tools/verify-live.mjs`，全部 PASS）

```
PASS a ready node appeared — node-742588c3a1c9a1f6d3004caa40c8a4a9 after 39 ms
PASS the node handshake produced a connectionId — node-742588c3a1c9a1f6d3004caa40c8a4a9:mu99n51p:fx2uo2bj
PASS the node advertised capabilities — count=97 hash=sha256:e75efd007…
PASS the capability surface is readable — 97 endpoints
PASS at least one stream Remote is advertised — session/control, session/follow, workspace/follow, workspaceFiles/changes
PASS unary pluginInventory/list succeeded — object{entries,agentPresets}          ← Phase 1/2 真 unary
PASS unary nodeAdmin/describe succeeded — object{nodeId,nodeName,role,mode,…}     ← Phase 3 诊断
PASS unary nodeAdmin/audit succeeded — object{records,capacity}                   ← Phase 3 审计
PASS unary nodeAdmin/fsList succeeded — object{path,entries}                      ← 路径策略放行
PASS unary nodeAdmin/fsList was refused with a code —
     {"code":"nodeAdmin/path-denied","message":"path is outside every allowed root on this node",
      "details":{"reason":"outside-roots"}}                                       ← 路径策略拒绝（红线）
PASS stream session/follow opened — {"type":"open","streamId":"s-2-c7j0mq","endpoint":"session/follow"}
PASS stream session/follow produced values — values=1                              ← Phase 2 真流
PASS stream session/follow was stopped after 5000 ms — cancelled from the client side  ← stream.cancel 生效
PASS the node is still ready after every call — ready
PASS no request or stream leaked — {"inFlightRequests":0,"activeStreams":0}

all checks passed (5065 ms)
```

关键的**否定性**证据（比"成功"更重要）：`nodeAdmin/fsList` 打 `C:\Windows` 时返回的是
`nodeAdmin/path-denied` + `reason: outside-roots`，**不是**权限错误、超时或空目录 ——
说明「默认开启全部管理能力」这一步是被**路径策略**兜住的，而不是靠运气。

### §2.1.1 `[实测]` Phase 3 的读写与 skill 路径（`tools/verify-admin.mjs`，18 项全 PASS）

```
PASS skill roots are reported as layers — layers=2
PASS the skill listing exposes layer labels, not host paths
PASS skills are listed — 40: dbs, dbs-action, dbs-agent-migration, …
PASS nodeAdmin/status succeeded — object{state,nodeId,reconnectAttempt,…}  (state=ready)
PASS nodeAdmin/fsWrite landed inside an allowed root — object{path,bytes}
PASS nodeAdmin/fsRead read it back / content round-tripped unchanged — 60 bytes
PASS nodeAdmin/fsRemove deleted it again — object{path,removed,kind}
PASS a write outside every allowed root was refused with a code — nodeAdmin/path-denied (outside-roots)
PASS removing a skill that does not exist was refused with a documented code
     → {"code":"nodeAdmin/not-found","message":"skill \"…\" does not exist","details":{"reason":"not-found"}}
PASS the refusal uses nodeAdmin/not-found, not a raw gateway/internal
PASS the refusal does not leak an absolute host path
```

**这一跑抓到了 Phase 3 的一个真实缺陷并已修**（详见 `dsh-node/docs/GROUND-TRUTH.md` §0.5.3）：
修之前 `nodeAdmin/skillRemove` 打一个不存在的名字，返回的是

```
{"code":"gateway/internal",
 "message":"ENOENT: no such file or directory, lstat 'C:\\Users\\<user>\\.dsh\\skills\\…'"}
```

两个问题：码是 `gateway/internal`（而 `nodeAdmin/not-found` 本来就在文档的词汇表里），
以及**消息里带着本机绝对路径** —— 而 skill 面明确承诺只回层标签、不回主机路径。
现在文件系统层与 skill 层的 errno 统一映射成 `nodeAdmin/*`，消息只用调用方已知的
名字/路径重建，不再回显 OS 原文。修完在同一环境下重跑，18 项全 PASS。

### §2.2 `[实测]` Node / Session 视图（Phase 4 的最后一项）

```
GET /api/nodes        → 1 个 ready 节点，带 connectionId / remoteSurfaceHash / capabilityCount
GET /api/capabilities → 97 个端点的完整表（含 mode）
GET /api/sessions?nodeId=node-742588c3…  → ok=true，items=130 个真会话
                        （sessionId / running / cwd / updatedAt 都是真的）
```

`/api/sessions` 这一条同时验证了「会话视图」和「参数形状只在配置里」的设计：
它发出的就是 `session/list` + `{_request:{}}`，返回值 130 条真会话。

### §2.3 清理

- 第二实例已停止（端口 43999 已释放），desktop 实例未被触碰（pid 47276 起始时间不变）；
- `profiles/web/node_modules/dsh-node` 联接已删除；
- desktop profile 的 `cordis.patch.yml` 里那段**临时 config 已换成注释模板**
  （节点回到 `unconfigured`，这是「没有真 Coordinator 时的正确状态」），
  并写清了启用步骤与路径策略的位置。

---

## §3 `[实测]` 单元与跨实现测试

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # exit 0
node node_modules/vitest/vitest.mjs run                          # 10 files, 219 tests, all pass
pnpm --config.verify-deps-before-run=false build                 # exit 0
```

`[实测]` 2026-09-20 11:35，219 tests / 10 files 全绿；`dsh-node` 侧同期 356 tests / 8 files 全绿。
（11:46 复查：节点侧因真机联调发现的缺陷加了 4 条回归测试 → **360**；本仓库仍是 219，
连跑 3 次结果一致。）

> **确定性修缮**：本套件里 `test/server.test.ts`、`test/session-views.test.ts`、
> `test/http-api.test.ts`、`test/cross-implementation.test.ts` 都会绑真实回环 listener，
> 而跨实现测试**故意重绑它刚释放的那个端口**（节点的 Coordinator URL 是固定的，
> 只有同端口才能观察到「重启」）。文件并行跑时，别的文件可能在这条缝里被 OS 分配到同一个
> 端口，重绑就会 `EADDRINUSE` —— 实测大约十次里撞到一次。
> 修法不是在测试里加重试，而是让文件**串行**（`vitest.config.ts` 的 `fileParallelism: false`），
> 从根上消除竞争；整套仍只需约 4 秒。

| 文件 | 数量 | 覆盖的行为 |
| --- | --- | --- |
| `frame-codec.test.ts` | 34 | 端点解析、逐类型结构校验、方向/版本拒绝、UTF-8 字节上限、拒绝时不回显凭据 |
| `node-registry.test.ts` | 33 | 身份与 token 绑定、撤销/恢复/轮换、登记策略、能力摘要与载具裁决、陈旧连接不被误删、视图不含 token |
| `request-table.test.ts` | 15 | 单次结算门、超时、取消、并发上限、计时器与监听器释放 |
| `stream-hub.test.ts` | 26 | `seq` 校验、恰好一个终态、有界缓冲与背压、空闲超时、取消帧、异步迭代器语义 |
| `session.test.ts` | 31 | 握手顺序、`hello.ok` 字段、心跳半开、断线、逐帧派发、帧上限 |
| `server.test.ts` | 13 | 真实 loopback 绑定、幂等 `start()`、重复连接替换、撤销、`stop()` 释放端口 |
| `http-api.test.ts` | 27 | 路由、鉴权、状态码映射、节点错误码透传、NDJSON 流、body 上限 |
| `session-views.test.ts` | 14 | 只读会话视图：包装参数、端点可配置、节点权威、失败码保留、禁用后 404 |
| `cli.test.ts` | 15 | 参数解析、`--node-env` 读取、`--nodes-file` 加载与错误 |
| `cross-implementation.test.ts` | 11 | **真 `dsh-node` 连真 Coordinator**（见下） |

### §3.1 `[实测]` 跨实现测试发现了什么

`test/cross-implementation.test.ts` 把 `dsh-node`（devDependency，`link:../dsh-node`，
用真 `DshNodeHost` + 真 `ws` + 假 Typert Gateway）连到本仓库真的 `Coordinator` 上。
它值钱的地方不是覆盖率，而是**两份独立实现只有在协议真的精确时才会一致**。
它抓到了三个不一致：

1. **`undefined` 结果编码**（`[实测]` 已修）：Remote 返回 `undefined` 时，节点写
   `{ok:true, value: undefined}`，`JSON.stringify` 把 `value` 丢掉 → 线上是 `{ok:true}`。
   初版 Coordinator **拒绝**该帧（自己声明的类型里 `value` 是必需字段），而在 `ready`
   连接上被拒的帧只会被忽略 —— 于是调用方等满整个 deadline，拿到
   `coordinator/request-timeout`，**而那次调用其实成功了**。
   结论：JSON 表达不了 `undefined`，所以「空成功」只能是 `{ok:true}`；缺 `value` 键
   **就是** `undefined`（`frame-codec.ts#validateBody`，`stream.data` 同规则）。
   把 `undefined` 变成 `null` 会改变值语义，不是修法。
2. **`dshNode.status().lastError` 丢失断线原因**（`[实测]`，**节点侧已修**）：
   撤销后节点状态是 `auth_failed`，但 `lastError` 是 `undefined` —— 因为
   `DshNodeHost.status` 只读 `currentError`（只有 host 级失败才写），从不回退到
   `connector.snapshot.lastError`（那里明明有 `node/auth-failed`）。
   于是「被撤销」和「崩溃循环」在操作者能读到的**唯一**表面上长得一样
   （`ctx.dshNode.status()` / `nodeAdmin/status` / `nodeAdmin/describe`）。
   节点侧改为 `this.currentError ?? snapshot?.lastError`，并加了一条回归测试。
3. **`capabilities.namespaces` 的文档与实现不符**（`[实测]`，**改文档、不改行为**）：
   节点发的是**全部**可派发命名空间，而两份 `protocol.ts` 的注释写成「无法枚举方法的
   那些」。后果是 Coordinator 的「命名空间在表里 ⇒ 交给节点裁决」分支覆盖面更大：
   `demo/nonexistent` 会被转发（节点答 `node/capability-unavailable`）而不是本地
   `coordinator/capability-mismatch`。**行为更安全**（节点仍是权威），所以修的是注释：
   该字段保证的是**否定命题** —— 不在表里的命名空间一定不会被派发。

另外 `[实测]` 被钉住的一致点：能力摘要哈希跨进程一致且等于按文档规则独立重算的值；
`hello.ok.connectionId` 被 `ready.connectionId` 回显；`ready.dsh.remoteSurfaceHash` 与
`ready.capabilities.remoteSurfaceHash` 同值；双向心跳互为应答；撤销关闭
（`node/auth-failed` + WS `4401` + `reconnect:false`）确实让节点走慢速有限重试；
重复连接被替换而不是并存；`stream.ready → seq 1..n → stream.end(count)` 逐帧一致。

---

## §4 `[推断]` 未被验证的部分

- **多节点并发压力**：并发上限（`maxInFlightRequests` / `maxStreams`）有单元测试，
  但没有在真机上跑过「几十个节点同时上报」的场景。
- **背压的真实阈值**：`maxBufferedValues`（默认 256）在真 DSH 的流速率下是否合适，**没测过**；
  触发时是**主动掉流**（`coordinator/backpressure` + `stream.cancel`），不是无限缓冲。
- **`ws` 的 `maxPayload` 与协议上限的交互**：两端都设了上限，超限帧由 `ws` 先拒。
  未验证 `ws` 拒绝时对端看到的具体关闭码。
- **时钟/调度假设**：半开检测用 `Date.now()` 差值。系统睡眠（笔记本合盖）会让差值突然变大，
  可能误判断线。**未验证**，但后果只是重连一次。
- **TLS**：只支持 `ws://` 直连；`wss://` 需要由反向代理终止（文档已写明，未实测）。

---

## §5 与 `dsh-node` 的行为对齐清单（读两侧源码得到）

| 项 | `dsh-node` 侧 | 本实现 | 一致 |
| --- | --- | --- | --- |
| `hello.ok` 缺 `connectionId` | **致命**，进 `stopped` 不重试 | 必发 | ✅ |
| 帧的 `nodeId` 校验 | 不匹配则**忽略**该帧 | 每帧都填对端 `nodeId` | ✅ |
| `ping` 应答 | 任何状态都回 `pong` | 任何状态都回 `pong` | ✅ |
| 半开判定 | 容忍 2 个周期 | 容忍 2 个周期（按**任意入站帧**计） | ✅ |
| 凭据被拒 | `close.code ∈ {auth-failed, node/auth-failed, unauthorized, forbidden, invalid-token, token-invalid}` 或 WS `4401/4403` → 慢速有限重试 | 发 `node/auth-failed` + WS `4401` | ✅ |
| `reconnect: false` | 非凭据场景进 `stopped` | 只用于「版本不兼容」与「被新连接替换」 | ✅ |
| 版本不匹配 | 自身致命停止 | 不回重试，`close{reconnect:false}` | ✅ |
| unary 重复在途 id | `node/protocol-invalid` | 本地保证唯一（计数器 + 随机） | ✅ |
| stream `seq` | 从 1 起、每流独立 | 严格校验缺口/重复 | ✅ |
| 载具与 mode | unary 用 `rpc.*`、stream 用 `stream.*` | 按 `capabilities.remotes[].mode` 选择，不匹配直接拒 | ✅ |

---

## §6 已知缺口

1. **真机联调已完成**（§2），但有两点仍是 `[待验证]`：
   - 真机上的**背压**与**并发上限**没有压到阈值（单元测试覆盖，真机只跑了正常速率）；
   - **desktop 实例**里的真机联调没有单独跑过 —— 用的是第二个 `web` profile 实例
     （同一份插件构建、同一个真 Gateway，端口独立）。desktop 侧要跑的话，
     把 `cordis.patch.yml` 里那段注释模板打开即可（§2.3）。
2. **注册表不持久化**：进程重启后登记信息消失（设计选择，见 README §2）。
   `onRecordsChanged` 是给嵌入方用的挂钩。对 CLI 用户来说，这意味着每次重启都要重新给
   `--node`/`--enroll-token` —— 尚未提供「从文件自动加载 + 轮换」的完整运维流程。
3. **编排层（`docs/COORDINATOR.md` §8 第 6–7 条）没做**：写操作的人工确认、项目经理 Agent 的任务拆分。
   会话的**调用面**已经做了（README §5.1），但如果要跑真节点，先读 §7.4 的警告。
4. **CLI 没有守护化/服务化**：没有 Windows 服务、没有 systemd unit、没有自动重启。

---

## §7 `[实测]` 会话调用面与内置 UI（2026-09-21）

### §7.1 做了什么

三条**写**接口 + 两条只读接口（`src/sessions.ts`），加一个由本服务自己托管的单页（`ui/index.html`）：

| 路由 | 载具 | 转发到 | 包装参数 |
| --- | --- | --- | --- |
| `POST /api/session/create` | unary | `session/create` | `request` |
| `POST /api/session/prompt` | unary | `session/prompt` | `request` |
| `POST /api/session/follow` | **stream** | `session/follow` | `request` |
| `GET\|POST /api/sessions` | unary | `session/list` | **`_request`** |
| `GET\|POST /api/session/page` | unary | `session/page` | `request` |

§7.2 的驱动（`tools/verify-sessions.mjs`，只走 `/api`）跑通全链路 **17 项全 PASS**：
建会话 → 列表里能看到 → 开 follow 流 → 发 prompt → **用户消息与助手消息都从流里回来了** →
跑完 `activeStreams=0`（没有泄漏）。

浏览器侧用 CDP 实测（同一台机器、`fake-node` 作对端）：点节点 → 点「＋新建」→
`chatTitle` 变成 `消息 · fake-session-1`、流连上（`已连接 · s-1-…`）→ 输入并发送 →
日志依次出现 `本地`(快照) / `事件 session-created` / `我 → demo-node` / `事件 user-message` /
`事件 assistant-message`。两端都对上了。

### §7.2 参数名不一致：一个单元测试**永远测不出来**的真实缺陷 `[实测]`

**`session/list` 的参数叫 `_request`，`session/page` 的叫 `request`。** 逐字核对自
`@deepseek-ai/dsh-api-session-controller` **0.1.5-rc.2**：

- `lib/typert.host.js` L903 `name: '_request'`（list）vs L970 `name: 'request'`（page）；
- `@deepseek-ai/dsh-client-connection/lib/client.js` L6092 `sessionApi.list(args._request)`
  vs L6103 `const page = request`。

而初版用一个共享的 `sessionViews.requestArgument` 同时喂两条路由，于是：

- 用默认 `_request` → `session/page` 必然被节点网关拒成 `gateway/arguments-invalid`；
- 改成 `request` → `session/list` 挂；
- **没有任何配置能让两条同时正确。**

为什么没被测出来：`session-views.test.ts` 只断言**它自己配置的**那个包装名，
`cross-implementation.test.ts` 根本没碰会话视图，而真机联调（§2.2）只验证了
`/api/sessions`（list）—— page 从来没在真节点上跑过。
**测试断言的是「我传了什么」，不是「节点要什么」；只有读节点侧 descriptor 才能发现这类错误。**

已修：拆成 `listRequestArgument`（默认 `_request`）与 `pageRequestArgument`（默认 `request`），
两条路由各用各的。

### §7.3 `resolveSessionsOptions` 缺默认值 `[实测]`

`promptMode` 没有「缺省即取默认值」的分支，直接把它送进了校验函数，
于是**任何不显式传 `promptMode` 的构造都会抛** `coordinator/invalid-arguments`。
tsc 不会发现（校验函数吃 `unknown`），而这个缺陷是被 §7.2 的**真机驱动**第一次运行抓到的
（`lib/cli.js` 启动即退出），不是被单元测试抓到的 —— 因为本次会话里 vitest 跑不起来（§7.5）。

教训与 §1.2 的 502 那条同类：**类型检查通过 + 单测逻辑正确，仍然可能有一个只在实际构造
对象时才暴露的缺陷。** 新增的 `resolveSessionsOptions()` 断言正是为它写的。

### §7.4 ⚠️ `promptSession` 会**真的**驱动节点

`session/prompt` 不是只读的：它会让节点跑一轮真实的 Agent turn。在真 DSH 上，
这意味着**真的发 prompt、真的改文件、真的花钱**。`tools/verify-sessions.mjs` 打真节点时同理。
本服务没有加「测试模式」开关 —— 谁调用谁负责，这是有意的（README §5.1）。
要试就指向一个可丢弃的 profile。

### §7.5 `[实测]` 本次会话**没能重跑** vitest

`node node_modules/vitest/vitest.mjs run` 在文件沙箱下失败：Vite 用 esbuild 的服务进程加载
`vitest.config.ts`，而该进程通过 **piped stdio**（Windows 上是命名管道）通信，
被沙箱以 `spawn EPERM` 拦下。这与本项目无关，是环境限制。

因此本轮的质量证据是：
- `tsc -p tsconfig.json --noEmit` → exit 0（`[实测]`）；
- `test/session-api.test.ts` **新增但未执行**（其断言按源码逐条核对过）；
- §7.2 的 17 项端到端驱动 `[实测]` 全 PASS —— 它覆盖的是真实的进程、真实的 loopback socket、
  真实的 NDJSON 分帧，比单测更接近用户路径。

**待办：在没有沙箱的环境里跑一次 `pnpm test`，确认 219 + 新增用例全绿。**
把这条当作已知的欠账，而不是「应该没问题」。

---

## §8 `[实测]` 真机测试：本机 DSH 节点 → Coordinator → 建会话 → 发消息 → 收消息（2026-09-21）

### §8.1 结论：通了

用一个**真 DSH 实例**接上真 Coordinator，走完整链路：

| 步骤 | 结果 |
| --- | --- |
| 节点拨入 | `state=ready`，`capabilityCount=97`，`remoteSurfaceHash=sha256:e75efd007…`（与 §2 同一份 surface） |
| `POST /api/sessions` | HTTP 200，**133 条真会话**（`sessionId` / `running` / `cwd` / `updatedAt` / `projections` 都真） |
| `POST /api/session/create` | `{sessionId: 'session-9e814a24-…', agentPreset: 'standard'}` |
| `POST /api/session/follow` | `200`，`application/x-ndjson` |
| `POST /api/session/prompt` | `{accepted: true}` |
| 流里回来的事件 | `turn/start` → `step/start` → `system/message` → `user/message`×4 → `request/header` → `request/context` → `session/title` → **`assistant/message`** → `step/end` → `turn/end` |
| 助手的实际回复 | **`收到。`** —— 与提示词要求完全一致 |
| 副作用 | `stats.activeStreams = 0`，流干净释放；DSH 自己还给会话生成了标题「回复确认无需工具」 |

快照共 **20 条记录**，`projections.values` 有 18 个域（`title` / `goal` / `tokenUsage` /
`contextPressure` / `todos` / `plan` / `modelSelection` …）—— 比 §2 时看到的更丰富。

### §8.2 ⚠️ desktop profile 的 `patchReload: live` **没有生效** `[实测]`

`profiles/desktop/package.json` 明确写了 `dsh.profile.patchReload: "live"`，
而 `dsh-app-boot` 的实现（`lib/index.js` L1109 `watchUserPatches`）确实会用
HMR 的 `registerConfig` 监听 `cordis.patch.yml`。但实测：

```
配置写入时间            ： 09:52（YAML 已验证可解析，id 覆盖正确）
host 日志最后一条时间    ： 09:12:40  ← 启动那一刻，之后再没有新行
最后一条 dsh-node 日志   ： {"state":"unconfigured","reason":"coordinatorUrl or token is not configured"}
Coordinator 侧           ： 该 nodeId 始终 offline，从未拨入
```

也就是说**改 profile patch 没有触发任何重载**，节点仍是 `unconfigured`。

值得注意的实现细节：设置 live reload 的那段代码整块包在
`try { … } catch (error) { suppressShutdownError(...) }` 里
（`dsh/lib/profile-boot-Dk-7KqJc.js` L339）——**live reload 装配失败是静默的**。
所以「配了 live 却没重载」不会在日志里留下任何痕迹，只能靠「日志时间戳没动」推断。

**未验证**（没有深挖）：是 HMR 服务没起来、是文件监听没触发，还是
`entry.update()` 抛错被吞。要确认需要看 `ctx.get('hmr')` 是否存在。

**实用结论：改 desktop profile 的节点配置，需要重启 DSH 才生效。**
本轮为避免中断正在使用的 desktop 实例（也就是当前这个会话），
改用 §2 的**第二个实例**办法：`web` profile + 临时 overlay，独立端口 43999。

### §8.3 真节点的事件词汇与一个真实的 UI 缺陷 `[实测]`

真 DSH 的 `session/follow` 帧形状（从 `dsh-api-session-controller` 0.1.5-rc.2 的
类型声明 + 实测负载核对）：

```
SessionFollowFrame = { type:'snapshot', header, cursor, records, hasMore, projections, assistantStream? }
                   | { type:'event', event: {type, seq, time, data} }
                   | { type:'assistant-stream', frame: {type:'start'|'chunk'|'end', …} }
```

而 `data` 里的文本位置是：

```
user/message      → data.content[].text              （数组！）
assistant/message → data.message.content[].text      （外面还裹一层 message）
system/message    → data.message.content[].text
```

**UI 初版找的是 `data.text` / `data.content`（字符串）/ `data.message`（字符串）——
三者都不匹配，于是每一条真实消息都会退化成 JSON blob。**

这正是 §7.2 的同类错误：**假节点的事件是照着渲染器写的，所以掩盖了渲染器不认识真节点这件事。**
夹具迁就了消费者，就等于没测。

已修（`ui/index.html`）：按真词汇解析 `message.content[]` / `content[]`，
内务事件（`turn/start`、`request/header` 等 12 种）渲染成紧凑暗色一行而不是大块 JSON，
并加了 `assistant-stream` 的实时打字渲染。

**验证方式**（`[实测]`）：把 `ui/index.html` 里**真实的** `<script>` 取出来，
在一个最小 DOM stub 上求值，再把真节点产出的真实事件喂给它的 `describeEvent`：

```
PASS assistant/message renders as assistant text — assistant
PASS assistant text is prose, not JSON — "收到。"
PASS user/message renders as user text — user
PASS the user prompt text survived — "请只回复两个字：收到。…"
PASS no prose-bearing event fell back to raw JSON — prose types=system/message,user/message,session/title,assistant/message; blobbed=none
PASS housekeeping events still render (compactly) — 12 internal events
```

（跑的是文件里的代码，不是重写一份 —— 重写一份只能证明重写的那份对。）

### §8.4 本轮**没有**验证的

- **浏览器里的目视确认**：Chrome MCP 桥接在本轮后半段持续超时，
  所以「页面在真节点上长什么样」只有 DOM/逻辑层证据（§8.3），没有截图。
- **`assistant-stream` 的真实 chunk 形状**：协议里它是不透明的 `JsonValue`，
  本轮没有抓到活跃生成中的帧（会话已经跑完）。`chunkText()` 因此写成**容错**的：
  接受 `text` / `delta` / `texts[]` / `block.text` 四种已知形状，
  认不出来就丢弃而不是渲染成 `[object Object]`。**这是推断，不是实测。**
- **`patchReload: live` 失效的根本原因**（见 §8.2）。

### §8.5 本轮留下的东西

- Coordinator 仍在 39472 运行，注册了两个 nodeId（desktop 的处于 offline）；
- 第二个 DSH 实例仍在 43999 运行（`web` profile + `.tmp/web-verify-overlay.yml`）；
- `profiles/desktop/cordis.patch.yml` **已改成启用状态**，备份在
  `cordis.patch.yml.bak-2026-09-21` —— 它会在**下次重启 DSH 时**生效；
- `profiles/web/node_modules/dsh-node` 联接已建立（用完删）。

---

## §9 `[实测]` 可持久化的登记密钥（2026-09-21）

### §9.1 做了什么

按操作者要求：**登记密钥能在 UI 里改、能持久化、重启后未知节点仍能用它连上**。

| 层 | 内容 |
| --- | --- |
| `src/state-file.ts`（新） | 状态文件：读 / 原子写 / 权限 / 版本，含节点记录与登记密钥 |
| `src/node-registry.ts` | `setEnrollment()`（运行时可改）+ `enrollmentOpen`（只报事实）+ `onStateChanged` 钩子 |
| `src/server.ts` | `stateFile` 选项、启动时 `#restore()`、变更时 `#persist()`、`setEnrollmentSecret()` |
| `src/http-api.ts` | `GET` / `POST /api/enrollment` |
| `ui/index.html` | 顶栏「登记设置」→ 只写输入框 + 保存 + 关闭登记 |
| `src/cli.ts` | `--state-file` / `--no-state-file`；启动横幅打印状态文件路径 |

### §9.2 `[实测]` 端到端：19 项全 PASS

脚本起真实进程、真 socket、真重启：

```
PASS a fresh run starts with enrollment closed
PASS the API reports persistence is on
PASS a node is refused while no secret is configured
PASS a node presenting "secret" enrolled itself — persist-check-node
PASS the enrolled node advertised capabilities — 7
PASS the secret reached the state file
--- restart with no --enroll-token ---
PASS the secret survived the restart — {"open":true,"persisted":true}
PASS the node record survived the restart
PASS a restored node is offline until it dials in, not pretend-ready
PASS a wrong secret is still refused after the restart
PASS the restored secret still admits an unknown node — no --enroll-token needed
PASS enrollment can be closed again
PASS a closed enrollment refuses the secret

all checks passed (19 total)
```

### §9.3 刻意选的几件事

1. **没有任何接口能读回密钥。** `/api/enrollment` 只回 `{open, persisted, stateFile?}`。
   `NodeRegistry` 上也没有返回密钥的 getter —— 不是「记得脱敏」，而是**没有可泄露的东西**。

2. **改密钥 ≠ 撤销。** 换密钥后用旧密钥登记过的节点**继续能连**（它的 token 已经独立了），
   只是旧密钥不能再登记新节点。撤销是单独的动作。

3. **持久化默认开启**，因为那正是需求；但路径会打印在启动横幅上，
   且 `--no-state-file` 可以完全关掉。一个「配了却不说存在哪」的凭据文件才是真的坑。

4. **优先级：命令行赢。** 给了 `--enroll-token` 就用它并**覆盖写回**文件（所以它仍是一个
   可用的「重置」）；不给就用文件里的。避免「启动参数悄悄把 UI 的设置改回去」。

5. **密钥短只告警不拒绝**（阈值 16）。它只是共享口令，而本服务也要能用于本机试用；
   一个把操作者选的值直接拒掉的校验器，只会让人把功能整个关掉。告警里写清了风险。

### §9.4 `[实测]` 又一次是「测试写错了」

第一遍跑出 1 个 FAIL：*the restored secret still admits a node*。
原因是我在脚本前半段把那个节点**轮换成了独立 token**，所以它之后不再吃共享密钥 ——
**这是正确行为**，错的是断言。改成用一个**从未见过的新 nodeId** 去验证，
并且此后所有「应该被拒」的检查也换成新 id（否则它们会因为「token 不匹配」而通过，
根本没有测到登记这条路）。

教训与 §7.2 同类：**断言要通过，先确认它测的是你想测的那条路径。**

### §9.5 未验证

- **vitest 仍未重跑**（沙箱限制，同 §7.5）。新增 `test/state.test.ts` **未执行过**；
  本轮的质量证据是 §9.2 的真进程驱动 + `tsc --noEmit` exit 0。
- **Windows 上的文件权限**：`chmod 0600` 在 Windows 上走 ACL，脚本跳过了那条断言。
  文件落在 `G:\claude_project\...`（NTFS），实际保护等级**未核实**。

---

## 修订记录

- 2026-09-20 初版：§1 端到端自测 `[实测]`；§2 真机联调待重启；§3 测试落地后补齐。
- 2026-09-20 11:31：§3 补齐（9 文件 / 205 测试全绿，`dsh-node` 356 全绿）。
  跨实现测试抓到三处不一致，其中两处已修：Coordinator 的 `undefined` 结果编码、
  节点 `status.lastError` 丢失断线原因（节点侧）。
  另修：背压/消费方离开时**不发 `stream.cancel`**（节点会继续往没人读的 socket 里生产）、
  `registry.bind` 丢掉上一次的能力摘要导致 `surfaceChanged` 永远为 false、
  `resolveCapability` 对「已登记但从未连接」的节点报 `node-unknown`（应为 `node-offline`）。
- 2026-09-20 11:35：补 Node/Session 视图（+14 测试 → 10 文件 / 219 测试）。
- 2026-09-20 11:41：**§2 真机联调完成**。用一个独立的第二真 DSH 实例（`web` profile +
  临时 overlay，不碰 desktop 实例、不需要重启）跑通：97 个真 Remote 的能力面、
  真 unary（`pluginInventory/list`、`nodeAdmin/describe`、`nodeAdmin/audit`）、
  真路径策略拒绝（`nodeAdmin/path-denied` / `outside-roots`）、
  真 stream（`session/follow` 出值后被 `stream.cancel` 干净终止）、
  真 Session 视图（130 条会话）。清理已完成（第二实例停止、临时联接删除、
  desktop patch 的临时 config 换成注释模板）。
- 2026-09-20 11:46：真机联调**又抓到 Phase 3 一个真实缺陷**（`skillRemove` 对不存在的名字
  回 `gateway/internal` 且消息里带本机绝对路径），已在节点侧修（errno → `nodeAdmin/*` 映射 +
  消息不回显 OS 原文），回归测试 4 条，节点侧 356 → **360**；真机重跑 18 项全 PASS。
  另外把测试文件改成串行，消掉一处约 1/10 概率的端口竞争抖动。
- 2026-09-21：**加会话调用面（create / prompt / follow）与内置 UI `/ui`**，见 §7。
  抓到并修掉两处：`session/page` 的包装参数名与 `session/list` 不同却共用一个配置（§7.2，
  只有读节点侧 descriptor 才能发现）、`promptMode` 缺默认值导致任何构造都抛（§7.3，
  被真机驱动首次运行抓到）。新增 `tools/verify-sessions.mjs`（17 项全 PASS）、
  `test/session-api.test.ts`、`ui/index.html`，并把 `fake-node.mjs` 扩成带内存会话的节点。
  本轮 vitest 因沙箱限制未能重跑，见 §7.5。
- 2026-09-21 稍后：**真机测试跑通**（§8）。用一个真 DSH 实例接上 Coordinator，
  建会话 → 发消息 → 收到 `收到。`，133 条真会话、97 个真能力。
  抓到两处：desktop profile 的 `patchReload: live` **没有生效**（改配置需重启 DSH，§8.2）；
  以及 UI 的事件渲染只认假节点的事件形状，**真节点的每条消息都会退化成 JSON**（§8.3，已修，
  并用「取出真实 `<script>` 跑真实负载」的方式验证）。
