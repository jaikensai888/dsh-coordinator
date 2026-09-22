# dsh-coordinator - 技术架构文档

> 文档性质：按当前源码整理的技术基线。涉及协议字段和默认值时，以 src/ 为最终事实来源。

## 1. 技术结论

dsh-coordinator 是一个 Node.js 单进程服务，使用一个 node:http listener 同时承载：

1. /node：节点主动拨入的 WebSocket 升级入口；
2. /api：运维 JSON/NDJSON HTTP API；
3. /ui：内置的零构建单页。

节点连接是出站连接的接收端。Coordinator 不主动连接节点，也不要求节点监听端口。
业务 Remote 仍在 dsh-node 上执行，Coordinator 只负责协议适配、身份、转发、边界和运维面。

## 2. 运行时架构

~~~mermaid
graph TD
    NodeA[dsh-node A] -->|WS /node| Listener[node:http + ws listener]
    NodeB[dsh-node B] -->|WS /node| Listener
    Caller[Library caller] -->|Coordinator API| Listener
    Browser[Browser /ui] -->|HTTP + fetch| Listener
    Listener --> Server[src/server.ts]
    Server --> Registry[src/node-registry.ts]
    Server --> Session[src/session.ts]
    Session --> Codec[src/frame-codec.ts]
    Codec --> Protocol[src/protocol.ts]
    Session --> RequestTable[src/request-table.ts]
    Session --> StreamHub[src/stream-hub.ts]
    Server --> Sessions[src/sessions.ts]
    Server --> HttpApi[src/http-api.ts]
    Server --> State[src/state-file.ts]
    HttpApi --> Ui[ui/index.html]
    Registry --> Live[内存运行态]
    State --> StateFile[coordinator-state.json]
~~~

### 2.1 进程内边界

| 边界 | 输入 | 输出 | 关键约束 |
| --- | --- | --- | --- |
| HTTP/WS listener | TCP、HTTP 请求、WebSocket 帧 | 路由到 API 或节点连接 | 共用端口，默认 127.0.0.1:39472 |
| NodeSession | 一条已接受的 WebSocket | 握手、心跳、RPC、流事件 | 一个连接维护自己的 request/stream 表 |
| NodeRegistry | nodeId、token、能力和连接事件 | NodeRecord、NodeView、能力摘要 | token 绑定 nodeId；nodeName/role 只作显示 |
| RequestTable | requestId、rpc.result、超时、取消、断线 | 单次 Promise 结算 | 同一个 requestId 只能结束一次 |
| StreamHub | streamId、seq、data、终态 | RemoteStream / AsyncIterable | seq 从 1 开始；有界缓冲和 idle timeout |
| sessions | 会话输入 | 已配置的业务 Remote 请求 | list 用 _request；其余 wrapper 用 request |
| http-api | HTTP method/path/body | JSON 或 NDJSON | 节点错误保留 HTTP 200 和原始 code |
| state-file | NodeRecord、enrollment | JSON 文件 | 唯一临时文件、原子 rename、敏感字段不写日志 |

### 2.2 目录与构建产物

~~~text
src/server.ts          listener、生命周期、公开库调用面
src/session.ts         单连接状态机、握手、心跳、帧分发
src/node-registry.ts   身份、登记、撤销、能力和 NodeView
src/request-table.ts   unary 在途请求
src/stream-hub.ts      stream 顺序、缓冲、终态
src/protocol.ts        dsh-node/1 帧和逻辑类型
src/frame-codec.ts     JSON 编解码和字段校验
src/sessions.ts        五个会话 Remote 包装
src/http-api.ts        运维 API、鉴权、JSON/NDJSON、/ui 路由
src/state-file.ts      状态文件读写
src/cli.ts             CLI 参数和启动横幅
src/ui.ts              UI 读取缓存
ui/index.html          零构建单页资源
lib/                   pnpm build 生成的 JavaScript/声明产物
~~~

## 3. 节点协议

### 3.1 版本与帧方向

协议版本为 dsh-node/1。节点到 Coordinator 的帧：

| 帧 | 作用 |
| --- | --- |
| hello | 节点身份、模式、认证材料和可选显示信息 |
| ready | 握手完成和 capability summary |
| rpc.result | unary 的唯一终态 |
| stream.ready | 流已建立 |
| stream.data | 流值，带 seq |
| stream.end | 流成功终态 |
| stream.error | 流失败终态 |
| ping/pong | 心跳 |
| close | 对端关闭意图 |

Coordinator 到节点的帧：

| 帧 | 作用 |
| --- | --- |
| hello.ok | 接受握手并下发 connectionId、heartbeatIntervalMs、maxFrameBytes、acceptedMode |
| rpc.request | unary 请求，payload 为 args 对象 |
| rpc.cancel | 取消 unary |
| stream.open | 打开流，包含 streamId、endpoint 和 args |
| stream.cancel | 取消流 |
| ping/pong | 心跳 |
| close | 关闭连接 |

### 3.2 能力与载具选择

ready.capabilities 至少包含 remotes、remoteSurfaceHash 和 namespaces。每个 remote
摘要包含 endpoint 与 mode，mode 只能是 unary 或 stream。

Coordinator 按 capability summary 选择载具，不通过“先试 unary、失败后再试 stream”
猜测。source-mode namespace 可能无法枚举单个方法，此时 Coordinator 放行请求，
由节点返回 capability-unavailable 等节点错误。

### 3.3 请求终态

~~~mermaid
sequenceDiagram
    participant Caller as 调用方
    participant Table as RequestTable / StreamHub
    participant Session as NodeSession
    participant Node as dsh-node

    Caller->>Session: invoke/openStream
    Session->>Table: 注册 requestId/streamId
    Session->>Node: rpc.request/stream.open
    Node-->>Session: result 或 data/terminal
    Session->>Table: 校验 ID、方向、seq、终态
    Table-->>Caller: value 或 RemoteFailure
    Caller->>Session: timeout/abort/客户端断开
    Session->>Table: 关闭本地实体
    Table-->>Node: rpc.cancel/stream.cancel（链路仍存在时）
~~~

以下事件都会结束本地 unary，但只能生效一次：

- rpc.result；
- 请求超时；
- 调用方 AbortSignal；
- WebSocket 断开；
- Coordinator stop。

stream 的终态只接受第一个 end 或 error。客户端 HTTP 响应提前关闭时，
Coordinator 会 cancel 对应节点流，避免节点继续向无人消费的连接生产。

## 4. 默认配置与边界

### 4.1 Coordinator 默认值

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| port | 39472 | 0 表示由操作系统分配空闲端口 |
| host | 127.0.0.1 | 非回环必须显式 allowInsecureBind |
| path | /node | WebSocket upgrade 路径 |
| handshakeTimeoutMs | 10000 | 等待节点 hello 的时间 |
| heartbeatIntervalMs | 30000 | ping 周期 |
| maxFrameBytes | 4 MiB | 双向协议帧上限 |
| maxInFlightRequests | 32 | 每节点并发 unary 上限 |
| maxStreams | 16 | 每节点并发 stream 上限 |
| requestTimeoutMs | 30000 | unary 默认超时 |
| streamIdleTimeoutMs | 120000 | stream 无事件默认超时 |
| maxBufferedValues | 256 | 单流有界缓冲默认值 |
| shutdownGraceMs | 1000 | stop 的优雅关闭等待时间 |
| maxBodyBytes | 1 MiB | 单个 HTTP JSON 请求体上限 |
| enableApi | true | 是否安装 /api |
| enableUi | true | API 开启且 sessions 开启时默认提供 /ui |
| sessions.enabled | true | 是否安装会话包装和 UI |

实际配置会经过构造函数和 CLI 的数值边界校验；表格只列默认值，不替代源码约束。

### 4.2 CLI 入口

| 参数 | 作用 |
| --- | --- |
| --port、--host、--path | 监听端口、绑定地址、WebSocket 路径 |
| --node | 预登记 nodeId:token，可重复；token 会出现在进程列表 |
| --node-env | 从环境变量读取节点 token，优先于 --node |
| --nodes-file | 读取 NodeRecord JSON 数组 |
| --enroll-token | 打开共享登记 |
| --state-file | 指定持久化路径 |
| --no-state-file | 关闭持久化 |
| --api-token | 设置管理面 bearer token |
| --no-api | 不安装运维 API |
| --allow-insecure-bind | 允许非回环监听 |
| --heartbeat-interval、--handshake-timeout | 调整连接时序 |
| --request-timeout、--stream-idle-timeout | 调整 unary/stream 默认时限 |
| --max-streams、--max-in-flight | 调整每节点并发上限 |
| --log-level、--trace-frames | 日志等级和脱敏帧跟踪 |

CLI 默认打开 state-file，文件名为工作目录下的 coordinator-state.json；程序化
new Coordinator() 若没有传 stateFile，则仍可以保持纯内存模式。使用 --no-state-file
时节点 token 和 enrollment secret 会在进程退出后丢失。

## 5. HTTP、UI 与权限模型

### 5.1 管理权限

节点接入和管理权限分开：

| 情况 | /node | /api | /ui |
| --- | --- | --- | --- |
| 默认回环、无 api-token | 正确节点 token 可接入 | 本机可用 | 本机可打开 |
| 非回环、无 api-token | 可允许其他机器作为节点接入 | 远程请求 HTTP 403 | 远程请求 HTTP 403 |
| 配置 api-token | 节点 token 仍只保护 /node | /api 需要 Bearer | 页面可导航；页面发出的 /api 需要 Bearer |
| --no-api | /node 仍可用 | 不安装 | 不可用 |

非回环监听需要 --allow-insecure-bind。该开关只解决监听意图，不提供加密；
节点 token 对应节点机器上的完整 DSH 能力，生产应使用前置 TLS/wss。

### 5.2 UI 运行方式

ui/index.html 由服务直接读取和发送，不需要单独的前端构建过程、CORS 配置或第二个端口。
页面通过 fetch 读取节点和会话，使用 ReadableStream 逐行消费 follow NDJSON，
切换节点或会话时 abort 上一条 follow 流。

## 6. 持久化实现

状态文件版本当前为 1，保存：

- enrollment：closed 或 shared-secret；
- nodes：nodeId、token、nodeName、role、revokedAt。

连接、能力、请求、流、lastSeen 等运行态不落盘。保存时：

1. 创建带进程号和随机后缀的唯一临时文件；
2. 以 0600 尝试创建并再次 chmod；
3. 写完整 JSON；
4. rename 覆盖目标文件；
5. rename 失败时删除临时文件。

POSIX 上会尽量使用 0600；Windows 或部分网络文件系统可能不完全支持该权限语义。
缺失状态文件视为首次启动；JSON 损坏、版本未知或不可读时记录错误并以空状态启动，
避免服务因手工编辑的凭据文件无法启动。

## 7. 错误与可观测性

稳定的 Coordinator 错误包括：

| 类别 | 错误码 |
| --- | --- |
| 身份/节点 | coordinator/auth-rejected、coordinator/node-unknown、coordinator/node-offline |
| 参数/协议 | coordinator/invalid-arguments、coordinator/protocol-invalid、coordinator/frame-too-large |
| 请求/流 | coordinator/request-timeout、coordinator/request-aborted、coordinator/request-limit、coordinator/stream-limit、coordinator/stream-closed、coordinator/backpressure |
| 连接/生命周期 | coordinator/connection-lost、coordinator/handshake-failed、coordinator/shutdown、coordinator/internal |
| 能力/容量 | coordinator/capability-mismatch、coordinator/registry-full |

节点返回的 code 原样透传，不在 HTTP 层包装成另一个业务错误。日志通过 secret provider
脱敏节点 token、enrollment token、api-token 和敏感对端文本；trace-frames 也只允许
记录脱敏后的帧。

## 8. 构建、类型检查与测试

~~~powershell
pnpm build
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run
~~~

当前仓库已验证 TypeScript 类型检查通过。直接 Vitest 运行的最新记录为 12 个文件、
263 个测试，其中 258 个通过、5 个失败，失败集中在 test/cli.test.ts、
test/server.test.ts 和 test/state.test.ts。pnpm typecheck/test 在当前环境可能先触发 no-TTY 依赖目录清理保护，
这属于执行环境限制，不应与代码测试结论混淆。

## 9. 技术决策与未覆盖项

### 9.1 已作出的决策

- 单端口复用 HTTP 和 WebSocket，减少节点与运维配置面。
- 用 capability mode 决定 unary/stream 载具，避免盲目重试。
- 用表驱动 request/stream 生命周期，实现单次结算和断线清理。
- 用 NDJSON 表达长流，兼容 HTTP 客户端和 fetch ReadableStream。
- 只持久化凭据和登记记录，不持久化不可安全恢复的运行态。
- 用“本机来源或 bearer token”保护管理面，并与节点接入权限分开。

### 9.2 当前未覆盖

- 没有 TLS 终止和证书自动化；
- 没有多进程共享状态和高可用；
- 没有真机高并发、背压阈值和系统休眠后的完整运行验证；
- 没有服务管理器、自动重启和日志轮转；
- 没有管理面 RBAC 或审计级操作授权。
