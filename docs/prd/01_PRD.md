# dsh-coordinator - 产品需求文档

> 文档性质：当前实现基线（as-built），不是尚未实现的产品规划。
>
> 面向读者：负责开发、联调、测试和运维 dsh-coordinator 的工程师。
>
> 事实来源：README.md、docs/GROUND-TRUTH.md、src/、ui/index.html，以及本仓库当前可运行测试。

## 1. 产品定位

dsh-coordinator 是 dsh-node 的对端服务。节点主动建立一条 WebSocket 连接，
Coordinator 完成身份登记、握手、能力摘要缓存和连接生命周期管理，再把调用方的
Remote 请求转发回正确的节点。

它解决的是“节点如何安全地拨入、如何被识别、如何承载结构化调用和流式结果”这组
基础设施问题，而不是实现节点上的业务。除了会话相关的五个包装 Remote 外，
Coordinator 不解析 Session、Prompt、文件或其他业务语义。

## 2. 目标与非目标

| 类型 | 内容 |
| --- | --- |
| 目标 | 接受 dsh-node 主动拨入，并用 dsh-node/1 完成 hello/ready 握手 |
| 目标 | 将 nodeId 与 token 绑定，支持预登记、共享登记、轮换、撤销和恢复 |
| 目标 | 支持 unary 和 stream 两种 Remote 载具，并提供超时、取消、断线和有界消费 |
| 目标 | 提供库调用面、HTTP JSON/NDJSON 运维 API 和零构建内置 UI |
| 目标 | 记录当前节点能力、连接状态、请求和流的运行态，并让登记数据跨重启恢复 |
| 非目标 | Coordinator 主动连接节点或要求节点监听入站端口 |
| 非目标 | 实现多租户、RBAC、细粒度业务权限或项目经理 Agent |
| 非目标 | 实现断线重放、流续传、cursor 或自动重试编排 |
| 非目标 | 直接终止 TLS；非回环部署应由前置代理提供 TLS/wss |
| 非目标 | 在 Coordinator 内部实现节点上的 Session、Prompt、文件等业务逻辑 |

## 3. 用户与典型场景

| 角色 | 场景 | 期望结果 |
| --- | --- | --- |
| dsh-node | 主动连接到 /node | 完成鉴权、收到 connectionId、上报能力并进入 ready |
| 库调用方 | 对指定 nodeId 调用 unary Remote | 得到节点值，或得到可按 code 分支的失败 |
| 库调用方 | 调用长时间运行的 stream Remote | 先收到值，再按顺序消费，并能取消或在空闲时终止 |
| 运维人员 | 查看节点、能力、统计和健康状态 | 获得不含 token 的 NodeView 和能力摘要 |
| 运维人员 | 增加、轮换、撤销、恢复节点凭据 | 变更立即影响后续握手；撤销会关闭现有连接 |
| 操作人员 | 在 /ui 选择节点并操作会话 | 创建会话、发送 prompt、跟随实时事件 |
| 部署人员 | 重启 Coordinator | 节点登记和登记规则恢复；连接与在途任务重新建立 |

## 4. 功能需求与验收标准

| ID | 需求 | 当前验收标准 |
| --- | --- | --- |
| FR-01 | 监听入口 | 同一端口提供 /node WebSocket、/api HTTP 和可选 /ui；默认 127.0.0.1:39472 |
| FR-02 | 节点握手 | hello 校验协议版本、nodeId、token、mode；成功返回带 connectionId 的 hello.ok，再等待 ready |
| FR-03 | 身份登记 | 已登记 nodeId 只能使用绑定 token；开启共享登记时未知节点可登记；nodeName/role 不参与鉴权 |
| FR-04 | 在线状态 | 能区分 connecting、authenticating、ready、closing、offline，并在断线后明确下线 |
| FR-05 | 能力选择 | ready.capabilities 被缓存；unary 只走 rpc.request，stream 只走 stream.open |
| FR-06 | unary 转发 | 每个 requestId 恰好一次结算；支持结果、超时、AbortSignal、取消和断线失败 |
| FR-07 | stream 转发 | 支持 ready/data/end/error；检查 seq；有界缓冲、空闲超时、客户端断开取消 |
| FR-08 | 心跳与半开检测 | Coordinator 周期性 ping；在规定周期内无入站帧时主动断开半开连接 |
| FR-09 | 节点生命周期 | add、rotate、revoke、restore 可通过库调用和 HTTP API 操作；revoke 立即关闭现有连接 |
| FR-10 | 运维 API | GET 读接口返回 JSON；invoke/management 返回 JSON；stream/follow 返回 NDJSON |
| FR-11 | 会话包装 | 支持 list、page、create、prompt、follow；端点名和包装参数名可配置 |
| FR-12 | 内置 UI | 无需单独前端进程即可查看节点、会话，建会话、发 prompt、消费 follow |
| FR-13 | 状态持久化 | 默认 CLI 保存节点记录和登记规则；可指定 state-file 或用 no-state-file 关闭 |
| FR-14 | 凭据卫生 | token 不出现在日志、NodeView、API 响应和错误详情中；状态文件使用原子写入 |
| FR-15 | 安全分面 | 节点接入由地址与节点口令决定；管理面由请求来源与 api-token 决定 |
| FR-16 | 优雅停止 | stop 关闭监听、通知并清理节点连接、请求和流，不留下继续可用的运行态 |

## 5. 核心流程

### 5.1 启动、握手和调用

~~~mermaid
sequenceDiagram
    participant Operator as 开发者/运维
    participant C as Coordinator
    participant N as dsh-node
    participant Caller as 库或 HTTP 调用方

    Operator->>C: start / CLI 启动
    C->>C: 恢复 NodeRecord 与 enrollment 规则
    C-->>Operator: 监听地址、API/UI、状态文件提示
    N->>C: WebSocket /node
    N->>C: hello(nodeId, token, mode)
    C->>C: 校验版本、身份、token、连接上限
    C-->>N: hello.ok(connectionId, limits)
    N->>C: ready(capabilities)
    C-->>Caller: 节点变为 ready
    Caller->>C: invoke 或 openStream
    C->>N: rpc.request 或 stream.open
    N-->>C: rpc.result 或 stream.ready/data/end/error
    C-->>Caller: value、AsyncIterable 或失败
~~~

### 5.2 节点与连接状态

~~~mermaid
stateDiagram-v2
    [*] --> connecting
    connecting --> authenticating: hello 通过初步校验
    connecting --> closing: 超时/协议错误/拒绝
    authenticating --> ready: ready + capabilities
    authenticating --> closing: ready 缺失或协议错误
    ready --> closing: 撤销/停机/新连接替换/心跳失败
    ready --> offline: WebSocket close
    closing --> offline: 资源清理完成
    offline --> connecting: 节点重新拨入
~~~

### 5.3 管理请求的安全分流

节点接入和管理是两个独立权限：

| 权限 | 决定因素 | 当前行为 |
| --- | --- | --- |
| 节点接入 | bind host 是否可达 + 节点接入口令 | 任何能访问 /node 且持有正确 token 的节点都可以拨入 |
| 本机管理 | 请求来源是否为 loopback | 未配置 api-token 时，本机可访问 /api 和 /ui |
| 远程管理 | api-token 是否配置且请求携带 Bearer | 配置 api-token 后，远程 /api 请求必须带 Bearer token |
| 关闭管理面 | enableApi 或 CLI --no-api | /api 不安装；关联 UI 也不可用 |

非回环绑定且未配置 api-token 时，/api 和 /ui 仍会安装，但远程管理请求统一得到
HTTP 403；这不影响其他机器作为节点拨入。/ui 的 GET 页面为浏览器导航保留了访问例外，
页面发出的每个 /api 请求仍须通过管理鉴权。

## 6. API 与库调用面的产品约定

### 6.1 通用返回

普通 JSON 成功响应使用：

~~~json
{"ok":true,"value":{}}
~~~

失败响应使用：

~~~json
{"ok":false,"error":{"code":"coordinator/...","message":"...","details":{}}}
~~~

节点已经返回的错误以 HTTP 200 携带原始 code；Coordinator 自身的参数、鉴权、
节点状态、限流和超时错误才使用真实 HTTP 状态码。

### 6.2 会话能力

会话接口是 Coordinator 唯一按名称认识的业务 Remote 集合：

- session/list：只读列表，包装参数名为 _request；
- session/page：分页，包装参数名为 request；
- session/create：创建会话；
- session/prompt：发送一轮消息，支持 queue 或 steer；
- session/follow：以 NDJSON 长流返回快照和增量事件。

prompt 的 text 是便利字段，会在节点上真实执行一轮 Agent。它不是模拟输入，
因此调用方必须把它视为具有文件修改、命令执行或外部副作用的操作。

## 7. 安全与数据边界

1. 节点 token 等价于该节点 DSH profile 的完整能力，不应通过明文网络暴露。
2. 非回环监听必须显式使用 allow-insecure-bind；生产上应在前置代理终止 TLS。
3. api-token 是管理 bearer token，与节点 token、enrollment token 分开。
4. 未知 nodeId、token 不匹配和已撤销节点对外统一为 coordinator/auth-rejected，
   避免通过握手枚举已登记节点。
5. /api/nodes、/api/node、/api/capabilities 和 NodeView 永远不返回节点 token。
6. 状态文件包含节点 token 和 enrollment secret，必须作为凭据文件保护。
7. /api 请求体默认上限为 1 MiB；请求、流和缓冲都有上限，避免无限制占用内存。

## 8. 验收证据与当前限制

### 8.1 可追溯证据

| 结论 | 证据 |
| --- | --- |
| 协议帧与状态机 | src/protocol.ts、src/frame-codec.ts、src/session.ts |
| 节点登记和生命周期 | src/node-registry.ts、src/server.ts |
| unary 与 stream 单次结算 | src/request-table.ts、src/stream-hub.ts |
| 会话包装参数和端点 | src/sessions.ts、src/http-api.ts |
| 运维 API 与 UI 行为 | src/http-api.ts、src/ui.ts、ui/index.html |
| 持久化和凭据处理 | src/state-file.ts、src/log.ts、docs/GROUND-TRUTH.md |

### 8.2 当前限制

- 没有多租户和细粒度管理权限；拿到 api-token 或节点 token 的主体拥有对应面的完整能力。
- 没有断线重放、流续传和自动编排。
- 真机高并发、背压阈值、ws maxPayload 交互和系统休眠后的时钟行为仍属于待验证项。
- 服务不是 Windows service、systemd daemon 或自动重启 supervisor。
- 当前测试环境的直接 Vitest 结果为 12 个文件、263 个测试，其中 258 个通过、5 个失败；
  失败集中在 test/cli.test.ts、test/server.test.ts 与 test/state.test.ts，不能把它宣称为全绿。

## 9. 文档追踪

| 文档 | 关注点 |
| --- | --- |
| 00_PRD_GRAPH.md | 模块、调用关系、当前实现总览 |
| 01_PRD.md | 产品边界、角色、功能需求和验收口径 |
| 02_TECH.md | 运行时架构、协议、配置和部署 |
| 03_DATAMODEL.md | 内存实体、状态转换和持久化 schema |
| 04_UX_DESIGN.md | 内置 UI 信息架构、交互和状态 |
| 05_API.md | HTTP JSON/NDJSON 运维接口 |
