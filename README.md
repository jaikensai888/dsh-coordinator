# dsh-coordinator

`dsh-node` 的**对端服务**：接受 DSH 节点**主动连出来**的 WebSocket，把结构化 Remote 调用
（unary / stream）转发回那条连接。

一句话：Coordinator 是「一组 DSH 节点的**协议适配层 + 身份登记处**」。

**它不连接节点、不要求节点监听端口、不解析业务语义。**

```
        ┌────────────── 单条出站 WS/WSS ──────────────┐
        │                                             │
   dsh-node (机器 A)                             dsh-coordinator
   dsh-node (机器 B)   ──►  hello/hello.ok/ready  ──►  ├─ 身份登记（nodeId + token 绑定）
   dsh-node (机器 C)   ◄──  rpc.request / stream.open ─┤─ 载具选择（unary vs stream）
                        ──►  rpc.result / stream.*  ────┤─ 有界消费 + 超时
                                                        └─ 运维 JSON API（/api）
```

配套仓库：`dsh-node`（**树外** DSH Host 插件）在 `G:\claude_project\code-agent\dsh-node`，
协议契约见其 `docs/COORDINATOR.md`，实测事实见其 `docs/GROUND-TRUTH.md`。

---

## 1. 快速开始

### 1.1 命令行

```powershell
# 建包（首次）
pnpm install
pnpm build

# 起服务：节点连 ws://127.0.0.1:39472/node
node lib/cli.js --port 39472 --enroll-token <一个共享密钥>
```

节点侧（`dsh-node` 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-node
      name: dsh-node
      config:
        coordinatorUrl: ws://127.0.0.1:39472/node
        nodeName: my-desktop
        auth: { token: <与 --enroll-token 相同的值> }
```

首次连接时节点会被**登记**（把 token 与它自报的 `nodeId` 绑定），此后该 token 只对该 `nodeId` 有效。
生产上应当立刻换成**每节点独立 token**（见 §4.3）。

### 1.2 当库用

```ts
import { Coordinator } from 'dsh-coordinator'

const coordinator = new Coordinator({
  port: 39472,
  records: [{ nodeId: 'node-1', token: process.env.NODE_TOKEN! }],
})
await coordinator.start()

const nodes = coordinator.listNodes()
const value = await coordinator.invoke('node-1', 'pluginInventory/list', {})
const stream = coordinator.openStream('node-1', 'session/watch', { sessionId: '…' })
for await (const event of stream) console.log(event)
await coordinator.stop()
```

---

## 2. 已实现范围（Phase 4）

| 能力 | 说明 |
| --- | --- |
| 出站连接的接收入口 | 只监听 127.0.0.1；非回环地址**必须**显式 `allowInsecureBind`（token 等价于该机器的完整控制权，明文暴露需要理由） |
| 握手鉴权 | `hello` → 校验 `protocolVersion` / `nodeId` / `token` / `mode` → `hello.ok`（**必带 `connectionId`**）→ `ready` |
| 身份与凭据绑定 | token 只对签发给它的 `nodeId` 有效；`nodeName` / `role` 永不参与鉴权（规格 §9.2） |
| 在线状态 | `connecting` / `authenticating` / `ready` / `closing` / `offline`；断开是**明确事件**，不可能永久显示在线 |
| 能力摘要 | 缓存 `ready.capabilities`，记录 `remoteSurfaceHash`，变化时发出事件（插件装卸/热重载会导致变化） |
| unary 转发 | `rpc.request` → 等待**恰好一个** `rpc.result`；超大/重复/超时/取消/断线都只结算一次 |
| stream 转发 | `stream.open` → `stream.ready/data/end/error`；`seq` 缺口检测、有界缓冲、空闲超时、`stream.cancel` |
| 心跳 | 主动 `ping`，回 `pong`；`heartbeatIntervalMs × 2` 内无任何入站帧即判定半开并断开 |
| 取消 | 调用方 `AbortSignal` 或超时 → 发 `rpc.cancel` / `stream.cancel`（断线时不发，链路已不在） |
| 节点管理 | 登记 / 轮换 token / 撤销 / 恢复；**撤销会立刻关闭在途连接**并以 `node/auth-failed`+WS `4401` 通知节点 |
| **会话接口** | `createSession` / `promptSession` / `followSession` + 只读的 `listSessions` / `pageSessions`：本服务唯一按名字认识业务 Remote 的地方，端点名与**每个端点各自的**包装参数名都是配置 —— 见 §5.1 |
| **内置 UI** | `GET /ui`：一个零构建的单页，选节点 → 建会话 → 发消息 → 实时收事件。由本服务自己托管，不引入第二个进程、第二个端口或 CORS |
| **登记密钥** | 共享密钥可在 UI 顶栏设置、也可命令行给；写在状态文件里，**重启后仍然有效**。API 只回「开/关」，永不回值 —— 见 §5.3 |
| **持久化** | 节点登记与登记密钥默认落在 `coordinator-state.json`（原子写、`0600`、已在 `.gitignore`）。`--state-file` 换位置，`--no-state-file` 完全不落盘 |
| 重连语义 | 新连接**替换**旧连接，旧连接被关闭 —— 同一个 `nodeId` 不可能有两个 `ready` 连接 |
| 运维 API | 同一个端口上的 `/api/*`（JSON，stream 用 NDJSON），仅回环或带 bearer token 时才安装 |
| 凭据卫生 | 日志、状态、API 响应、错误详情里**永不出现 token**；`close.reason` 等对端文本先脱敏再记录 |

**没做（有意不做）**

- **其余业务语义**：除 §5.1 那五个会话 Remote 外，不解析 Session / Prompt / 文件等概念。
  其他业务调用用 `/api/invoke` 直接调节点上已有的 Remote 即可。
- **断线重放 / 流续传**：节点已经把在途 unary 以 `node/connection-lost` 失败、把流释放掉了。
  重放会重复创建 Session、重复改文件；续传会重复调用方已经看过的值。协议 v1 没有 cursor。
- **多租户 / 权限模型**：`nodeAdmin/*` 这类能力的语义取决于节点，Coordinator 只做透传。
- **密钥轮换的自动化**：登记密钥可以随时改，但**改它不会撤销已经登记过的节点** ——
  撤销是单独的动作（`/api/nodes/revoke`）。「自动给所有节点换新 token」没有做。
- **协调者编排 / 项目经理 Agent**：`docs/COORDINATOR.md` §8 的第 7 条，必须建立在稳定调用语义之上，最后做。

---

## 3. 协议要点（实现时需要照做的部分）

| # | 约束 | 不照做的后果 |
| --- | --- | --- |
| 1 | `hello.ok` **必须**带 `connectionId` | 节点判为**致命**协议错误并停止重试（需要人工介入） |
| 2 | 发往节点的每一帧都要带**它自己的** `nodeId` | 节点静默丢弃 → 表现为「请求挂住」 |
| 3 | 收到 `ping` 必须回 `pong` | 节点容忍 2 个周期后判定半开并重连 |
| 4 | unary 必须用 `rpc.request`，stream 必须用 `stream.open` | 节点的 Gateway 返回 `gateway/signature-invalid` |
| 5 | `requestId` / `streamId` 在**在途**期间唯一 | 节点以 `node/protocol-invalid` 拒绝 |
| 6 | 终态**恰好一次**（`rpc.result` / `stream.end|error`） | 调用方收到两次结算或永远挂起 |
| 7 | `stream.data.seq` 从 1 起、每流独立、每次 +1 | 值序列被静默破坏 |
| 8 | 版本不匹配时不要重试到天荒地老 | 用 `close {code: node/protocol-invalid, reconnect: false}` 明确终止 |

载具选择**只看** `ready.capabilities.remotes[].mode`，不靠猜、不靠重试。
端点的 `namespaces` 字段表示「该命名空间的方法名节点无法枚举」（source-mode 插件），
这种情况下 Coordinator 放行、由节点裁决（未知方法返回 `node/capability-unavailable`）。

---

## 4. 安全模型

### 4.1 风险基线

节点侧是 `full-access`。**拿到 token 的人等效于拥有该 DSH profile 的全部能力**（包括 Phase 3 的
`nodeAdmin/*`：受路径策略约束的文件读写、skill 安装卸载）。因此：

- 回环绑定是默认值；非回环绑定要显式开关，并且**必须**把 TLS 放在前面（`wss://`）；
- 节点侧建议：专用操作系统账号、隔离工作区、限制出站目标、定期轮换 token。

### 4.1.1 两个权限是分开的：**节点接入** vs **管理**

这是本服务最容易搞混的一点，因为它曾经被合成一个决定：

| 权限 | 由什么决定 | 谁能行使 |
| --- | --- | --- |
| **作为节点接入**（`/node`） | 绑定地址 + 接入口令 | 任何能连到该地址、且出示正确接入口令的机器 |
| **管理**（`/api`、`/ui`） | 请求来源地址 + `--api-token` | **只有本机**；配了 `--api-token` 才允许远程 |

早先的规则是「非回环绑定且没有 `--api-token` ⇒ 整个 `/api` 不安装」。那等于说：
**想让别的机器当节点，就必须同时把管理面也交出去**，唯一的替代是再加一个凭据去保护它。
这两件事本来无关，于是操作者被迫接受一个他并不需要的凭据。

现在的规则：

- `/api` 和 `/ui` **永远安装**，但**只答来自本机的请求**（`127.0.0.0/8`、`::1`，含 IPv4-mapped 形式）；
- 局域网来的管理请求得到 **403**，消息写明原因和出路；
- 配了 `--api-token` 才允许远程管理，并改为要求 bearer token。

所以常见的部署是这样，**只需要一个凭据**（接入口令）：

```powershell
node lib/cli.js --port 39472 --host 0.0.0.0 --allow-insecure-bind
```

```
ready: listening on every interface, port 39472
  nodes on other machines dial one of: ws://192.168.0.10:39472/node
  operator API: http://127.0.0.1:39472/api; UI on http://127.0.0.1:39472/ui  (this machine only)
```

本机的浏览器打开 UI **不需要填任何东西**；别的机器能当节点，但打不开管理界面。

> 想要远程管理时才加 `--api-token`，那时它同时成为浏览器要填的那个值 —— 也就是两个凭据。
> 这就是为什么浏览器弹框现在会明确写「这是 `--api-token` 的值，**不是**节点用的接入口令」。

### 4.2 为什么「未知 nodeId」和「token 不对」对外是同一个失败

握手阶段若区分二者，任何能连上端口的人都能**枚举 nodeId**。所以两者对外的 `code` 都是
`coordinator/auth-rejected`，只有本机日志里的 `details.reason` 区分（`unknown-node` / `token-mismatch` / `revoked`）。

### 4.3 登记、轮换、撤销

```powershell
# 用环境变量给 token（推荐；--node 会把 token 写进进程命令行）
node lib/cli.js --node-env <nodeId>:NODE_TOKEN

# 或者用文件（权限由你负责）
node lib/cli.js --nodes-file .\nodes.json

# 撤销：立刻断开在途连接，并拒绝后续握手
curl -X POST http://127.0.0.1:39472/api/nodes/revoke -H 'content-type: application/json' -d '{"nodeId":"…"}'

# 轮换：换成每节点独立 token
curl -X POST http://127.0.0.1:39472/api/nodes/rotate -H 'content-type: application/json' -d '{"nodeId":"…","token":"…"}'
```

`--enroll-token` 是**共享密钥**：任何自报新 `nodeId` 并出示该密钥的机器都会被登记。
它存在的原因是节点自己生成 `nodeId`（持久化在节点身份文件里），操作者无法提前知道。
默认关闭；打开后服务会在日志里提醒「该密钥还能登记任意未知节点」，登记完请轮换。

**登记和密钥都会持久化**，默认写在 `coordinator-state.json`，重启后仍然有效 ——
所以「设一次就不用管了」是真的。细节（文件格式、权限、优先级）见 §5.3。

---

## 5. 运维 API

同一个端口，`/api/*`，JSON。失败分两类：

- **本服务的边界失败** → 真实 HTTP 状态（400 / 401 / 404 / 409 / 413 / 429 / 502 / 504）；
- **节点报的失败** → **HTTP 200** + `{"ok":false,"error":{"code":…}}`，节点的原始 code 原样保留
  （`session/not-found`、`node/backpressure`、`gateway/…`）。调用方要靠 code 决定是否重试，
  把它埋进 5xx 会丢掉这个信息。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 只报是否在监听 |
| GET | `/api/stats` | 节点数 / ready / 撤销 / 会话 / 在途请求 / 活动流 |
| GET | `/api/nodes` | 全部节点视图（**永不包含 token**） |
| GET | `/api/node?nodeId=…` | 单个节点视图 |
| GET | `/api/capabilities?nodeId=…` | 该节点上报的完整能力表（含 `mode`） |
| GET/POST | `/api/operator-token` | 查看或设置运营端 token；设置接口只允许 localhost |
| GET | `/ui` | 内置单页（见 §5.2），只允许 localhost |
| POST | `/api/invoke` | `{nodeId, endpoint, args?, timeoutMs?}` |
| POST | `/api/stream` | 同上；响应是 NDJSON：`open` → `data`×n → `end`/`error` |
| POST | `/api/streams/cancel` | `{nodeId, streamId, reason?}` |
| POST | `/api/nodes/add` \| `/rotate` \| `/revoke` \| `/restore` | 节点生命周期 |
| GET | `/api/enrollment` | `{open, persisted, stateFile?}` —— **只报事实，永不回密钥值**（见 §5.3） |
| POST | `/api/enrollment` | `{token: "新密钥"}` 开启自助登记；`{token: null}` 关闭。**会持久化** |
| GET/POST | `/api/sessions` | 会话列表（见 §5.1） |
| GET/POST | `/api/session/page` | 会话分页（见 §5.1） |
| POST | `/api/session/create` | `{nodeId, cwd?, sessionId?, agentPreset?, request?}` → 节点的 `{sessionId}` |
| POST | `/api/session/prompt` | `{nodeId, sessionId, text?, content?, mode?, requestId?}` → `{accepted:true}` |
| POST | `/api/session/follow` | `{nodeId, sessionId, …}` → **NDJSON 长流**：先一帧 `snapshot`（含历史 `records`），之后是增量 `event` |

例子（注意 Windows PowerShell 会吞掉传给原生程序的引号，用文件传 body）：

```powershell
'{"nodeId":"node-1","endpoint":"session/list","args":{}}' | Set-Content -Encoding utf8 body.json
curl.exe -s -X POST http://127.0.0.1:39472/api/invoke -H "content-type: application/json" --data-binary "@body.json"
```

运营端 token 可以通过启动参数 `--api-token` 或 `/ui` 顶栏的「运营端 token」设置。
首次未配置时，localhost 可以 POST `/api/operator-token` 完成 bootstrap；设置后每个
`/api/*` 请求都要 `Authorization: Bearer <token>`。轮换 token 必须携带旧 token，
接口永不返回 token 值。

### 5.1 会话：本服务唯一按名字认识业务 Remote 的地方

```powershell
# 列表（不带 request 就是"无过滤"）
curl.exe -s "http://127.0.0.1:39472/api/sessions?nodeId=node-1"
# 建会话
'{"nodeId":"node-1","cwd":"G:\\proj"}' | Set-Content -Encoding utf8 c.json
curl.exe -s -X POST http://127.0.0.1:39472/api/session/create --data-binary "@c.json"
# 发消息（会**真的**在节点上跑一轮）
'{"nodeId":"node-1","sessionId":"…","text":"帮我看下这个 bug"}' | Set-Content -Encoding utf8 p.json
curl.exe -s -X POST http://127.0.0.1:39472/api/session/prompt --data-binary "@p.json"
# 收消息（长流，NDJSON）
'{"nodeId":"node-1","sessionId":"…","assistantStream":true}' | Set-Content -Encoding utf8 f.json
curl.exe -s -N -X POST http://127.0.0.1:39472/api/session/follow --data-binary "@f.json"
```

为什么这里可以提业务端点，而别处不行？因为「让 UI 看到并驱动一个会话」是 Coordinator 的固有职责，
把这五个常量推到每个调用方只是把它们搬了个位置 —— 而且每一份拷贝都可能写错。代价被限制在三件事上：

1. **请求对象是调用方的**，本服务只加一层包装参数。唯一的例外是 `promptSession` 的 `text`
   便捷字段（节点要求 `{requestId, sessionId, mode, content:[{type:'text',text}]}`，其中
   `requestId` 必填），而 `content` / `request` 是保留的逃生口，原样透传；
2. 节点仍是权威：节点没这些 Remote 就回它自己的 `node/capability-unavailable`；
3. 端点名与参数名是**配置**，不是写死的逻辑。

> ⚠️ **每个端点的包装参数名不一样，而且不能共用一个。**
> `session/list` 的参数叫 `_request`；`session/page`、`session/create`、`session/prompt`、
> `session/follow` 都叫 `request`。这不是笔误 —— 在
> `@deepseek-ai/dsh-api-session-controller` 0.1.5-rc.2 的 descriptor 里逐字核对过
> （list 是 `name: '_request'`，page 是 `name: 'request'`），客户端代码也一致
> （`sessionApi.list(args._request)` vs `const page = request`）。
> 早期版本用一个共享的 `requestArgument` 同时喂这两条路由，结果 `/api/session/page`
> 在真节点上必然被网关拒成 `gateway/arguments-invalid` —— 而单元测试因为只断言自己配置的
> 那个名字，全都是绿的。现在拆成了 `listRequestArgument` / `pageRequestArgument`。

**全部可配置**：

```ts
new Coordinator({
  sessions: {
    listEndpoint: 'myNamespace/list',
    listRequestArgument: 'query',
    pageRequestArgument: 'request',
    createEndpoint: 'session/create',
    promptEndpoint: 'session/prompt',
    followEndpoint: 'session/follow',
    requestArgument: 'request',   // create / prompt / follow 共用
    promptMode: 'queue',          // 或 'steer'：打断当前回合
    followIdleTimeoutMs: 600_000, // 默认继承 streamIdleTimeoutMs
    enabled: true,
  },
})
```

`sessions.enabled: false` 会让这五条路由和 `/ui` 一起完全不存在（404），库侧调用返回
`coordinator/invalid-arguments`。

### 5.2 内置 UI

```
http://127.0.0.1:39472/ui
```

CLI 启动时会把这条地址打出来 —— 因为默认只绑回环，而 `localhost` 在部分机器上先解析到 IPv6，
所以**能用的那个地址值得直接告诉你**，而不是让你猜。

```
┌────────┬──────────────┬─────────────────────┐
│ 节点    │ 会话          │ 消息                 │
│● node-a│ abc123       │ 你：帮我看下…         │
│● node-b│ def456       │ AI：…                │
│        │ [＋ 新建]     │ ───────────────────  │
│        │              │ [输入框]      [发送]  │
└────────┴──────────────┴─────────────────────┘
```

三件事值得说明：

- **一个文件、零构建、零依赖**，由本服务自己托管。改一个标签不需要重新打包服务。
- **页面只允许 localhost 返回**，且页面在 token 校验之前返回，因为浏览器导航带不了
  `Authorization` 头。页面本身不含任何凭据；它发出的每一个 `/api/*` 调用仍要过校验，
  所以拿到 401 时它会就地弹出输入框问你。token 设置面板只允许本机浏览器使用。
- **`session/follow` 用 `fetch` + `ReadableStream` 逐行读**，不是 `EventSource`（那个只能 GET）。
  切换会话或节点时先 abort 旧流再开新流 —— 同时只允许一条 follow 流。

打开它就等于拿到「这台机器上所有已登记节点」的完整操作能力（`promptSession` 会真的发 prompt），
所以它的暴露面和 `/api` 完全一致，绑定策略也一致。

**顶栏的「运营端 token」**可以首次设置或轮换管理 token；**登记设置**可以设置登记密钥
（见 §5.3）。两个输入框都是**只写的**：
界面上任何地方都不显示当前密钥，因为 API 根本没有返回它的途径 ——
留空表示「不修改」，关闭登记是另一个显式按钮，不是"把框清空"。

### 5.3 登记密钥与持久化

节点自己生成 `nodeId`，所以操作者无法提前登记它。**登记密钥**（共享密钥）就是为此存在的：
任何出示它的未知节点当场被登记。

```powershell
# 方式一：命令行给（并会写入状态文件）
node lib/cli.js --port 39472 --enroll-token <密钥>

# 方式二：启动后通过 UI 顶栏「登记设置」，或直接调 API
curl.exe -s -X POST http://127.0.0.1:39472/api/enrollment `
  -H "content-type: application/json" -d '{"token":"<密钥>"}'

# 关闭自助登记（之后只有已登记的节点能连）
curl.exe -s -X POST http://127.0.0.1:39472/api/enrollment `
  -H "content-type: application/json" -d '{"token":null}'
```

**持久化**：默认写到工作目录的 `coordinator-state.json`，含节点 token 与登记密钥。
换位置用 `--state-file <path>`，完全不落盘用 `--no-state-file`。

```json
{
  "version": 1,
  "apiToken": "…",
  "enrollment": { "kind": "shared-secret", "token": "…" },
  "nodes": [{ "nodeId": "node-…", "token": "…", "nodeName": "…" }]
}
```

这个文件**是凭据**（每台机器的完整访问权 + 成为节点的权利），所以：

| 措施 | 说明 |
| --- | --- |
| 原子写 | 临时文件 + rename，不会写出半截密钥 |
| `0600` | 创建时给最紧的权限；Windows 上退化为 ACL |
| 已在 `.gitignore` | 提交它等于交出所有可达机器 |
| 日志只说事实 | `coordinator/state-loaded {"nodes":2,"enrollment":"shared-secret"}`，没有值 |
| `/api/enrollment` 同理 | 只回 `open` / `persisted` / `stateFile`，**没有任何接口能读回密钥** |

**优先级**（避免"启动参数悄悄把 UI 的设置改回去"）：

| 情况 | 结果 |
| --- | --- |
| 没给 `--enroll-token` | 用状态文件里的；文件里没有就是关闭 |
| 给了 `--enroll-token` | **命令行赢**，并**覆盖写回**状态文件（所以它是一个可用的"重置"） |

> ⚠️ 密钥太短会告警但不会拒绝。它只是共享口令，而本服务也要能用于「就在这台机器上试一下」，
> 一个把操作者选的值直接拒掉的校验器，只会让人把整个功能关掉。生产上请用 16+ 位随机串，
> 或者干脆关掉自助登记、改用 `--node-env` 逐台登记。

---

## 6. 验证

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run
pnpm --config.verify-deps-before-run=false build
```

不需要 DSH 的端到端自测（真两个进程、真 loopback socket）：

```powershell
# 终端 1
node lib/cli.js --port 39480 --enroll-token e2e-secret --log-level debug
# 终端 2
node tools/fake-node.mjs --url ws://127.0.0.1:39480/node --node-id fake-node-e2e --token e2e-secret --log
# 终端 3
curl.exe -s http://127.0.0.1:39480/api/nodes
```

`tools/fake-node.mjs` 是**节点侧**的最小实现（hello/ready/pong/rpc.result/stream.*，以及
`session/create|prompt|follow|list|page` 这五个带内存会话的 Remote），
用来把故障归因：**它和真 `dsh-node` 行为不一致 ⇒ 协议问题；一致 ⇒ Coordinator 问题。**
它对 `session/list` 用 `_request`、对其余四个用 `request`，**故意不自作主张地统一** ——
一个把参数名抹平的夹具，会正好掩盖 Coordinator 必须写对的那个差异。

会话全链路（建 → 发 → 收）有一条只走 `/api` 的驱动，也就是 UI 走的那条路：

```powershell
# 终端 1
node lib/cli.js --port 39480 --enroll-token e2e-secret --log-level debug
# 终端 2
node tools/fake-node.mjs --url ws://127.0.0.1:39480/node --node-id fake-node-e2e --token e2e-secret
# 终端 3
node tools/verify-sessions.mjs --api http://127.0.0.1:39480
```

它检查 17 件事，包括 `/ui` 能被取到、`session/create` 的 unary 载具、`session/follow`
的 NDJSON 信封、快照恰好一帧、prompt 之后**用户消息与助手消息都通过流回来了**、
以及跑完不留下活动流。同时它也是「页面坏还是后端坏」的归因工具：
这个脚本过而页面不过 ⇒ 问题在页面。

### 6.1 与真 DSH 联调（已跑通，可复现）

不需要重启你正在用的 DSH：起**第二个**实例即可（`web` profile，纯 Node 无 GUI，独立端口）：

```powershell
# 1) 把插件挂进 web profile（用完删掉这个 junction）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-node" `
  -Target 'G:\claude_project\code-agent\dsh-node'
# 2) 起本服务（共享密钥登记，待验证）
node lib/cli.js --port 39471 --enroll-token verify-live-token-2 --log-level debug
# 3) 起第二个真 DSH（overlay 在 .tmp/web-verify-overlay.yml：自带身份文件与 allowedRoots）
$env:ELECTRON_RUN_AS_NODE="1"
& "E:\DSH\DSH Desktop\DSH Desktop.exe" --expose-internals `
  "E:\DSH\DSH Desktop\resources\app\lib\desktop-cli.js" `
  --profile web --patch .tmp\web-verify-overlay.yml --port 43999 --no-open
# 4) 逐项验证（两个驱动都只走 /api）
node tools/verify-live.mjs  --api http://127.0.0.1:39471 --unary pluginInventory/list `
  --unary nodeAdmin/describe --unary nodeAdmin/audit `
  --expect-ok 'nodeAdmin/fsList:{"path":"…"}' --expect-denied 'nodeAdmin/fsList:{"path":"C:\\Windows"}' `
  --stream session/follow --stream-ms 5000
node tools/verify-admin.mjs      # skill 面 + 文件读写删 + 两处拒绝
node tools/verify-sessions.mjs --api http://127.0.0.1:39471   # 建会话 → 发消息 → 收消息
curl.exe -s "http://127.0.0.1:39471/api/sessions?nodeId=<nodeId>"
```

结果（`docs/GROUND-TRUTH.md` §2 有完整输出）：97 个真 Remote、真 unary、
真流（`session/follow`）、真路径策略拒绝、130 条真会话，全部 PASS。

> `verify-sessions.mjs` 打真节点时会**真的发 prompt**（跑一轮真实的 Agent turn）。
> 请指向一个可丢弃的 profile，别指向你正在用的那个。

PowerShell 会把传给原生程序的 JSON 引号吃掉，所以两个驱动都支持用环境变量传 JSON：
`DSH_VERIFY_STREAM_ARGS` / `DSH_VERIFY_UNARY_ARGS`。

---

## 7. 目录

```
src/
  protocol.ts        帧类型与视图类型（独立实现，不 import dsh-node 的任何东西）
  errors.ts          coordinator/* 错误码 + 脱敏工具
  frame-codec.ts     编解码、大小上限、逐类型结构校验
  node-registry.ts   身份/凭据绑定 + 在线状态 + 能力摘要 + 载具裁决
  request-table.ts   在途 unary：单次结算门、超时、取消
  stream-hub.ts      出站流：seq 校验、有界缓冲、空闲超时、恰好一个终态
  session.ts         一条连接的状态机（握手、心跳、断线、cancel）
  sessions.ts        会话 Remote 的名字与请求形状（本服务唯一认识业务端点的地方）
  server.ts          WebSocket 监听 + 会话编排 + 调用面 + 会话路由
  http-api.ts        运维 JSON API + /ui 路由
  ui.ts              内置单页的读取与缓存
  cli.ts             dsh-coordinate 命令行
  log.ts             不可能泄露 token 的日志
ui/index.html        内置单页：零构建、零依赖，由本服务托管
tools/fake-node.mjs   节点侧最小实现（含内存会话，自测夹具，不需要 DSH）
tools/verify-live.mjs 真机验证驱动：能力面 / unary / 路径策略 / stream
tools/verify-admin.mjs 真机验证驱动：skill 面 / 文件读写删 / 拒绝路径
tools/verify-sessions.mjs 端到端驱动：建会话 → 发消息 → 收消息 + /ui 可达
docs/GROUND-TRUTH.md  实测事实与未验证推断
```
