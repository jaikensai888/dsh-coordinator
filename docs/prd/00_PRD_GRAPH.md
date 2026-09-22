# dsh-coordinator - 当前实现设计总览

> 面向开发人员的反向工程看板：描述仓库当前已经实现的系统，而不是规划中的目标系统。
>
> 最后更新：2026-09-22 10:01
>
> 事实来源：README.md、docs/GROUND-TRUTH.md、src/、ui/index.html、package.json。
> 01_PRD、02_TECH、03_DATAMODEL、04_UX_DESIGN、05_API 已基于当前源码和实测记录补齐；
> 本图继续作为跨文档的系统关系总览。

---

## 1. MVP 功能范围

> 本节的“核心/支持”是按当前实现的重要性整理，不代表尚未存在的产品优先级决策。

### 1.1 功能边界

┌──────────────────────────────────┬───────────────────────────────────────────┐
│ ✅ 当前已实现                    │ ❌ 当前不提供或不纳入                      │
├──────────────────────────────────┼───────────────────────────────────────────┤
│ 节点主动拨入、hello/ready 握手    │ Coordinator 主动拨节点                     │
│ nodeId + token 鉴权与登记         │ 断线重放、流续传、cursor                   │
│ 节点状态、能力摘要和连接替换      │ 多租户、RBAC、细粒度业务权限               │
│ unary / stream 转发、取消、超时   │ 除会话五个 Remote 外的业务语义解析         │
│ 心跳、半开检测、断线明确下线       │ 项目经理 Agent、任务拆分、人工确认编排     │
│ /api 运维 JSON/NDJSON 调用面       │ Windows 服务、systemd、自动重启            │
│ 会话 create/prompt/follow/list/page│ 由 Coordinator 自己实现 DSH 业务逻辑       │
│ 零构建内置 UI /ui                  │ 本服务直接终止 TLS（由前置代理负责）        │
│ 登记规则与节点凭据持久化           │ 真机压力阈值、全场景桌面热重载已验证         │
└──────────────────────────────────┴───────────────────────────────────────────┘

系统的一句话定位：Coordinator 是 dsh-node 的对端服务，接收节点主动建立的
WebSocket，将结构化 Remote 调用转发回该连接；它是协议适配层和身份登记处，
不是业务服务，也不要求节点监听入站端口。

### 1.2 核心用户故事

| ID | 使用者 | 当前能力 | 当前重要性 |
| --- | --- | --- | --- |
| US01 | dsh-node 节点 | 主动连接 Coordinator，完成鉴权、能力上报并保持 ready | 核心 |
| US02 | 库调用方/脚本 | 对指定 nodeId 发起 unary Remote，并获得节点原始结果或错误码 | 核心 |
| US03 | 库调用方/脚本 | 消费 stream Remote，获得有序值，并能取消、超时或安全结束 | 核心 |
| US04 | 运维人员 | 查看节点、能力、连接状态和统计，并执行登记、轮换、撤销、恢复 | 支持 |
| US05 | 操作人员 | 在 /ui 选择节点、查看会话、建会话、发 prompt、跟随实时事件 | 支持 |
| US06 | 部署人员 | 通过状态文件保留节点登记和登记密钥，使服务重启后可恢复 | 支持 |

### 1.3 运行链路总览

~~~mermaid
sequenceDiagram
    participant Node as dsh-node
    participant Listener as HTTP/WS Listener
    participant Session as NodeSession
    participant Registry as NodeRegistry
    participant Caller as API / Library Caller

    Node->>Listener: WebSocket connect /node
    Listener->>Session: create NodeSession
    Node->>Session: hello(nodeId, token, mode)
    Session->>Registry: authenticate(nodeId, token)
    Registry-->>Session: accepted or auth-rejected
    Session-->>Node: hello.ok(connectionId, limits)
    Node->>Session: ready(capabilities)
    Session->>Registry: bind + setCapabilities
    Session-->>Caller: node becomes ready

    Caller->>Listener: POST /api/invoke or library invoke()
    Listener->>Session: resolve node and endpoint mode
    Session-->>Node: rpc.request
    Node-->>Session: rpc.result
    Session-->>Caller: value or preserved failure code
~~~

---

## 2. 系统架构

### 2.1 技术栈与运行形态

| 层级 | 当前实现 | 版本/默认值 | 备注 |
| --- | --- | --- | --- |
| 运行时 | Node.js | >= 20（实测环境 Node v24.11.1） | ESM |
| 语言 | TypeScript | 5.8.3 | 源码在 src/ |
| WebSocket | ws | 8.18.0 | 节点主动拨入 |
| HTTP | node:http | Node 内置 | 与 WebSocket 共用端口 |
| 构建 | tsdown + tsc declarations | tsdown 0.15.4 | 输出 lib/ |
| UI | 原生 HTML/CSS/JavaScript | 零构建、零依赖 | ui/index.html |
| 测试 | Vitest | 3.2.4 | test/ |
| 持久化 | JSON 文件，可关闭 | 默认 coordinator-state.json | 无数据库、无 ORM |

### 2.2 部署与模块架构

┌──────────────────────────────┐       outbound WS /node
│ dsh-node A                   │─────────────────────────────┐
│ dsh-node B                   │─────────────────────────────┤
│ dsh-node C                   │─────────────────────────────┘
└──────────────────────────────┘                              │
                                                              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ dsh-coordinator：单进程、单 HTTP listener                                    │
│                                                                              │
│  /node  WebSocket upgrade       /api  JSON/NDJSON       /ui  SPA             │
│             │                         ▲                     ▲                │
│             ▼                         │                     │                │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ server.ts：生命周期、路由、NodeSession 编排、调用面                   │  │
│  │                                                                        │  │
│  │ node-registry    session        request-table       stream-hub          │  │
│  │ 身份/状态/能力    握手/心跳/帧    unary 单次结算      stream 顺序/缓冲    │  │
│  │                                                                        │  │
│  │ frame-codec + protocol：帧编解码、字段校验、载具契约                  │  │
│  │ sessions：五个会话 Remote 的名称、包装参数和便捷请求构造               │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│             │                         │                     │                │
│             └──────────────┬──────────┴──────────────┬──────┘                │
│                            ▼                         ▼                       │
│                 ┌──────────────────┐      ┌──────────────────────────┐       │
│                 │ 内存运行状态      │      │ coordinator-state.json   │       │
│                 │ 连接/请求/流      │      │ 节点记录 + 登记规则       │       │
│                 └──────────────────┘      └──────────────────────────┘       │
└──────────────────────────────────────────────────────────────────────────────┘

关键边界：

- 节点只向 Coordinator 拨号；Coordinator 不拨回节点。
- /node、/api、/ui 共用同一端口，默认绑定 127.0.0.1:39472。
- API/UI 只调用 Coordinator；真正的业务 Remote 仍由节点执行。
- 只有节点记录和登记规则落盘；连接、在途请求、活动流、能力当前连接不落盘。

### 2.3 代码模块职责

| 模块 | 主要职责 | 关键不变量 |
| --- | --- | --- |
| src/protocol.ts | dsh-node/1 帧类型、连接状态、节点记录/视图 | 方向和帧类型独立定义，不依赖 dsh-node 类型 |
| src/frame-codec.ts | JSON 编解码、帧大小和逐类型结构校验 | 协议版本/必填字段/载荷形状在进入状态机前校验 |
| src/server.ts | listener、生命周期、会话编排、公开库调用面 | 先 restore 再 listen；一个 nodeId 只保留一个 ready 连接 |
| src/session.ts | 单条 WebSocket 的握手、心跳、帧分发、关闭 | hello.ok 必带 connectionId；出站帧使用正确 nodeId |
| src/node-registry.ts | 身份凭据绑定、登记、撤销、能力摘要、状态视图 | 鉴权只看 nodeId + token，不把 nodeName/role 当身份 |
| src/request-table.ts | unary 在途表、超时、AbortSignal、断线失败 | rpc.result/超时/取消/断线只能结算一次 |
| src/stream-hub.ts | stream 注册、seq 检查、有界缓冲、idle timeout、终态 | seq 从 1 递增；end/error 只接受第一个终态 |
| src/sessions.ts | 五个会话 Remote 的端点名、包装参数、便捷请求构造 | list 使用 _request；page/create/prompt/follow 使用 request |
| src/http-api.ts | /api 路由、鉴权、JSON/NDJSON、错误映射 | 节点错误保留 HTTP 200 + 原始 code；边界错误映射真实 HTTP 状态 |
| src/ui.ts + ui/index.html | /ui 静态页面读取缓存和三栏操作台 | 页面可先加载；配置 apiToken 时 API 调用使用 Bearer；远程无 token 时管理面 403 |
| src/state-file.ts | 节点/登记规则 JSON 原子读写和脱敏描述 | 临时文件 + rename；日志不回显密钥 |
| src/cli.ts | 命令行参数、启动横幅、优雅退出 | 可配置 port/host/path/token/state-file |
| src/errors.ts + src/log.ts | 错误码、失败归一化、日志脱敏 | token、密钥和敏感对端文本不进入日志/API |

### 2.4 目录结构

~~~text
dsh-coordinator/
├── src/
│   ├── server.ts          # HTTP/WS listener、服务生命周期和调用面
│   ├── session.ts         # 单节点连接状态机
│   ├── node-registry.ts   # 身份、凭据、状态、能力
│   ├── request-table.ts   # unary 在途请求
│   ├── stream-hub.ts      # stream 缓冲和终态
│   ├── protocol.ts        # dsh-node/1 帧和视图类型
│   ├── frame-codec.ts     # 帧编解码和校验
│   ├── sessions.ts        # 会话 Remote 包装
│   ├── http-api.ts        # 运维 API 和 /ui 路由
│   ├── state-file.ts      # 持久化
│   ├── cli.ts             # dsh-coordinate CLI
│   ├── ui.ts              # UI 文件读取缓存
│   ├── errors.ts
│   ├── log.ts
│   └── timers.ts
├── ui/
│   └── index.html         # 零构建内置 UI
├── test/                  # 单元、HTTP、跨实现和会话调用测试
├── tools/
│   ├── fake-node.mjs
│   ├── verify-live.mjs
│   ├── verify-admin.mjs
│   └── verify-sessions.mjs
├── docs/
│   ├── GROUND-TRUTH.md
│   └── prd/
│       ├── 00_PRD_GRAPH.md
│       ├── 01_PRD.md
│       ├── 02_TECH.md
│       ├── 03_DATAMODEL.md
│       ├── 04_UX_DESIGN.md
│       └── 05_API.md
├── package.json
├── tsconfig.json
├── tsdown.config.ts
└── vitest.config.ts
~~~

### 2.5 部署配置

#### 端口和路径

| 服务面 | 默认地址/路径 | 说明 |
| --- | --- | --- |
| 节点 WebSocket | ws://127.0.0.1:39472/node | dsh-node 主动连接 |
| 运维 API | http://127.0.0.1:39472/api/* | JSON；stream 使用 NDJSON |
| 内置 UI | http://127.0.0.1:39472/ui | 服务自托管单页 |
| 状态文件 | 工作目录/coordinator-state.json | 可用 --state-file 改位置；--no-state-file 关闭 |
| 数据库 | 无 | 本实现不依赖数据库 |

#### 常用命令

~~~powershell
# 安装和构建
pnpm install
pnpm build

# 启动 Coordinator
node lib/cli.js --port 39472 --enroll-token <shared-secret>

# 类型检查
pnpm typecheck

# 单元/集成测试
pnpm test
~~~

生产边界：

- 默认只监听回环地址；非回环绑定必须显式 allowInsecureBind，实际部署应把 TLS 放在前置代理。
- 节点接入权限与管理权限分开：非回环绑定且未配置 apiToken 时，/api 和 /ui 仍安装，但远程管理请求统一返回 403；配置 apiToken 后远程 /api 请求需要 Bearer。
- /ui 的 GET 页面为浏览器导航保留访问例外；页面发出的 /api 请求仍按管理鉴权执行。
- 节点 token 等价于该节点机器上的完整 DSH 能力，生产环境应使用每节点独立 token。
- 登记密钥只能设置/关闭，API/UI 只能看到 open、persisted、stateFile 等事实，不能读回密钥值。

---

## 3. 数据模型

> Coordinator 没有数据库。本节展示源码中的逻辑实体和内存关系；只有 STATE_FILE
> 中标注的内容会跨进程重启保留。

### 3.1 逻辑实体关系

~~~mermaid
erDiagram
    NODE_RECORD ||--o| LIVE_CONNECTION : "nodeId"
    LIVE_CONNECTION ||--o| CAPABILITY_SURFACE : "ready 上报"
    NODE_SESSION ||--o{ REQUEST_ENTRY : "等待 rpc.result"
    NODE_SESSION ||--o{ REMOTE_STREAM : "stream.open"
    NODE_RECORD ||--o{ NODE_SESSION : "当前连接"
    STATE_FILE ||--o{ NODE_RECORD : "持久化"

    NODE_RECORD {
        string nodeId PK
        string token
        string nodeName
        string role
        string revokedAt
    }
    LIVE_CONNECTION {
        string connectionId PK
        string state
        string connectedAt
        string lastSeenAt
        string surfaceHash
        int inFlightRequests
        int activeStreams
    }
    CAPABILITY_SURFACE {
        string remoteSurfaceHash PK
        int remotesCount
        string namespaces
    }
    NODE_SESSION {
        string sessionKey PK
        string nodeId
        string connectionId
        string state
    }
    REQUEST_ENTRY {
        string requestId PK
        string endpoint
        int timeoutMs
        string outcome
    }
    REMOTE_STREAM {
        string streamId PK
        string endpoint
        int expectedSeq
        int bufferedValues
        string terminal
    }
    STATE_FILE {
        int version PK
        string enrollment
        string nodes
    }
~~~

实体说明：

| 实体 | 所在位置 | 生命周期 | 是否持久化 |
| --- | --- | --- | --- |
| NODE_RECORD | NodeRegistry | 节点被预登记/自助登记至撤销或恢复 | 是 |
| LIVE_CONNECTION | NodeRegistry 的 live map | hello/ready 至断线 | 否 |
| CAPABILITY_SURFACE | 当前 live connection | ready 上报至下一次连接覆盖 | 否 |
| NODE_SESSION | Coordinator.sessions | socket 接受至关闭 | 否 |
| REQUEST_ENTRY | NodeSession.RequestTable | rpc.request 至单次结算 | 否 |
| REMOTE_STREAM | NodeSession.StreamHub | stream.open 至 end/error/cancel | 否 |
| STATE_FILE | coordinator-state.json | 文件存在期间 | 是 |

### 3.2 连接状态

~~~mermaid
stateDiagram-v2
    [*] --> connecting
    connecting --> authenticating: hello + 鉴权通过
    connecting --> closing: 超时/协议错误/拒绝
    authenticating --> ready: ready + capabilities
    authenticating --> closing: 非 ready 或协议错误
    ready --> closing: 撤销/停机/心跳丢失/新连接替换
    ready --> offline: socket close
    closing --> offline: teardown
    offline --> connecting: 节点重新拨入
~~~

补充规则：

| 规则 | 实现 |
| --- | --- |
| 未登记、token 错误、已撤销 | 对端统一收到 node/auth-failed + WebSocket 4401；详细原因只留本机日志 |
| 重连 | 新 ready 连接替换旧连接；旧连接不会继续被视为 ready |
| 能力选择 | 已公开 endpoint 必须匹配 unary/stream mode；未枚举方法交给节点裁决 |
| unary 结算 | rpc.result、超时、AbortSignal、断线四条路径共用单次结算门 |
| stream 结算 | stream.ready → data(seq) → end/error；seq 缺口、背压、空闲和取消都会结束流 |
| 断线 | 在途请求/流本地失败；不重放、不在已断链路发送 cancel |
| 持久化 | 只恢复节点记录和登记规则；恢复后的节点仍先显示 offline，重新握手后才 ready |

---

## 4. 页面设计

### 4.1 页面层级

~~~mermaid
graph TD
    Root["/ui · DSH Coordinator"]
    Root --> Header["状态栏"]
    Root --> Token["API token 输入栏"]
    Root --> Enrollment["节点登记令牌面板"]
    Root --> Nodes["节点列表"]
    Nodes --> Sessions["选中节点的会话列表"]
    Sessions --> Chat["选中会话的消息面板"]
    Chat --> Follow["session/follow NDJSON 流"]
    Chat --> Composer["prompt 输入与发送"]
    Sessions --> Create["新建会话"]
~~~

### 4.2 主页面结构

┌──────────────────────────────────────────────────────────────────────────────┐
│ DSH Coordinator   [连接状态]                         [令牌] [刷新节点]       │
├───────────────────┬───────────────────────┬──────────────────────────────────┤
│ 节点              │ 会话                  │ 消息                             │
│                   │                       │                                  │
│ ● node-a          │ ● 会话标题            │ 会话标题              [流状态]    │
│   ready · 97 能力 │   运行中 · cwd        │ ──────────────────────────────── │
│                   │                       │ [本地/用户/AI/系统事件]          │
│ ● node-b          │ ＋ 新建               │                                  │
│   offline         │                       │                                  │
│                   │                       │ ──────────────────────────────── │
│                   │                       │ [输入框]                 [发送]   │
└───────────────────┴───────────────────────┴──────────────────────────────────┘

交互要点：

| 区域 | 操作 | 后端调用 |
| --- | --- | --- |
| 节点 | 刷新、选择 nodeId、显示 state/capabilityCount | GET /api/nodes |
| 会话 | 加载列表、创建、选择会话 | /api/sessions、/api/session/create |
| 消息 | 建立/重连 follow 流、渲染快照和增量事件 | POST /api/session/follow |
| 消息输入 | 发送纯文本 prompt | POST /api/session/prompt |
| 登记面板 | 查看 open/persisted；设置或关闭新节点登记 | GET/POST /api/enrollment |
| API token | 本地保存 Bearer token；401 时再次提示 | 所有 /api 调用 |

UI 的 follow 实现使用 fetch + ReadableStream 逐行读取 NDJSON；切换节点/会话
时先 abort 旧流。页面能在 API token 校验前返回，但页面发出的每一个 /api 请求
仍然要通过鉴权。

---

### 4.3 调用面与模块关系

> 本节把开发者最常追踪的调用入口集中在总览中；它描述当前代码，不代表额外的 API 文档。

#### 核心运维调用

| 类别 | 当前入口 | 作用 |
| --- | --- | --- |
| 健康/统计 | GET /api/health、GET /api/stats | 监听状态、节点数、ready 数、请求/流计数 |
| 节点视图 | GET /api/nodes、GET /api/node、GET /api/capabilities | 查看无 token 的节点状态和能力表 |
| 通用 unary | POST /api/invoke | 以 nodeId + endpoint + args 调节点 unary Remote |
| 通用 stream | POST /api/stream | 返回 open/data/end/error NDJSON |
| 流控制 | POST /api/streams/cancel | 停止指定 nodeId/streamId |
| 节点生命周期 | POST /api/nodes/add、rotate、revoke、restore | 管理登记记录和 live connection |
| 登记规则 | GET/POST /api/enrollment | 查看事实、设置或关闭共享登记密钥 |
| 会话读写 | /api/sessions、/api/session/page、/api/session/create、/api/session/prompt、/api/session/follow | 内置 UI 使用的会话调用面 |

#### 库调用面

| 入口 | 内部路径 | 结果 |
| --- | --- | --- |
| Coordinator.start/stop | server.ts → HTTP/WS listener | 启停单实例服务 |
| listNodes/node/capabilitiesOf | server.ts → NodeRegistry | 得到脱敏 NodeView/能力摘要 |
| invoke | server.ts → NodeSession.invoke → RequestTable | rpc.request/rpc.result |
| openStream | server.ts → NodeSession.openStream → StreamHub | stream.open/data/end/error |
| createSession/promptSession/followSession | sessions.ts 构造请求 → invoke/openStream | 只在此处认识五个 DSH session Remote |
| add/rotate/revoke/restoreNode | server.ts → NodeRegistry | 变更登记与凭据绑定 |
| setEnrollmentSecret | server.ts → NodeRegistry → state-file | 运行时改登记规则并可持久化 |

#### 关键协议约束

~~~mermaid
sequenceDiagram
    participant Caller as 调用方
    participant Session as NodeSession
    participant Node as dsh-node
    participant Table as RequestTable / StreamHub

    Caller->>Session: invoke 或 openStream
    Session->>Table: 先登记 requestId/streamId
    Session->>Node: rpc.request 或 stream.open
    Node-->>Session: rpc.result 或 stream.ready/data/end/error
    Session->>Table: 路由并单次结算
    Table-->>Caller: value、AsyncIterable 或错误

    Caller->>Session: timeout / abort / break
    Session->>Table: 结束本地状态
    Table-->>Node: rpc.cancel 或 stream.cancel
~~~

不可破坏的协议事实：

- hello.ok 必须带 Coordinator 签发的 connectionId。
- Coordinator 发出的每个帧都带目标 nodeId。
- unary 只能使用 rpc.request；stream 只能使用 stream.open。
- requestId/streamId 在途期间唯一；stream.data.seq 从 1 开始并逐次递增。
- node 报告的业务错误保留原始 code；Coordinator 自身边界错误才映射为 HTTP 4xx/5xx。
- 请求/流都受上限保护：默认每节点 32 个 unary、16 条 stream、每流默认最多缓存 256 个值。
- 默认 unary 超时 30 秒，stream 空闲超时 120 秒；实际值可配置并被边界约束。

---

## 5. 文档索引

### 5.1 设计文档状态

| 文档 | 路径 | 状态 | 说明 |
| --- | --- | --- | --- |
| 设计总览 | docs/prd/00_PRD_GRAPH.md | ✅ | 本文档，反向整理当前实现 |
| 产品需求 | docs/prd/01_PRD.md | ✅ | 当前实现边界、角色、功能需求和验收口径 |
| 技术架构 | docs/prd/02_TECH.md | ✅ | 运行时、协议、配置、部署和错误模型 |
| 数据模型 | docs/prd/03_DATAMODEL.md | ✅ | 内存实体、状态转换和持久化 schema |
| UX 设计 | docs/prd/04_UX_DESIGN.md | ✅ | 当前内置 UI 的信息架构和交互 |
| API 文档 | docs/prd/05_API.md | ✅ | HTTP JSON/NDJSON 运维接口与示例 |

---

## 6. 规则索引

### 6.1 当前事实和规则来源

| 来源 | 用途 |
| --- | --- |
| README.md | 快速开始、已实现范围、安全模型、运维调用面 |
| docs/GROUND-TRUTH.md | 带实测/源码/待验证标签的事实记录 |
| src/protocol.ts | dsh-node/1 帧方向、字段和状态契约 |
| src/session.ts | 连接状态机、握手、心跳、关闭与转发约束 |
| package.json | 构建、类型检查、测试命令和运行时依赖 |

未在当前仓库中发现技能模板引用的公共 docs-update-rule 文件，因此本总览不创建
不存在的规则链接，也不把模板占位内容当作项目事实。

---

## 7. 更新记录与验证边界

### 7.1 更新记录

| 版本 | 日期 | 更新内容 | 来源 |
| --- | --- | --- | --- |
| 1.1 | 2026-09-22 | 一次性补齐 PRD、技术、数据模型、UX 和 API 文档，并同步当前管理面安全模型 | 源码 + README + GROUND-TRUTH |

*当前版本：1.1 | 最后更新：2026-09-22 10:01*

### 7.2 验证证据

| 标记 | 结论 | 证据/入口 |
| --- | --- | --- |
| [源码] | 当前模块职责和状态关系 | src/ 下对应模块及 JSDoc |
| [实测] | fake-node 端到端握手、unary、stream、鉴权、撤销和无泄漏 | docs/GROUND-TRUTH.md §1 |
| [实测] | 真 dsh-node 能力面、unary、stream、路径策略和节点视图 | docs/GROUND-TRUTH.md §2 |
| [实测] | 会话建、发、收和 /ui 路径 | tools/verify-sessions.mjs；GROUND-TRUTH §7/§8 |
| [实测] | 状态文件跨重启恢复登记密钥和节点记录 | GROUND-TRUTH §9 |
| [待验证] | 真机高并发、背压阈值、ws 超限交互、桌面 profile 热重载 | GROUND-TRUTH §4/§6/§8 |
| [本轮验证] | TypeScript 类型检查通过（exit 0） | node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit |
| [本轮验证] | Vitest 12 个文件、263 个测试：258 通过、5 失败 | node node_modules/vitest/vitest.mjs run；失败集中在 test/cli.test.ts、test/server.test.ts 与 test/state.test.ts |
| [环境限制] | pnpm typecheck/test 被 no-TTY 依赖完整性检查拦截；未将其误判为代码测试结果 | pnpm 输出 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY |

### 7.3 当前维护重点

1. 修改协议字段或载具选择时，先对照 src/protocol.ts、src/frame-codec.ts 和 dsh-node
   对端契约，再更新 session/request-table/stream-hub 的不变量。
2. 修改 session Remote 包装时，保留 list 的 _request 与 page/create/prompt/follow 的
   request 差异，并用真节点或对应 descriptor 验证。
3. 修改 UI 事件渲染时，以真实 session/follow 帧形状为准，不让 fake-node 夹具迁就
   消费者。
4. 任何新增日志、NodeView 或 API 响应都要检查 token、登记密钥和对端敏感文本是否
   被回显。
