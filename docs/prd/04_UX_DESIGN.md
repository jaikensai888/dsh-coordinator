# dsh-coordinator - UX 设计文档

> 文档性质：当前 ui/index.html 的交互和信息架构基线，不是独立前端产品的视觉重设计。
>
> 实现形态：服务端托管一个零构建、零额外进程的单页。

## 1. UX 范围

内置 UI 的核心任务是让操作人员在不编写脚本的情况下完成最小闭环：

1. 看见 Coordinator 是否可用；
2. 看见已登记节点及其 ready/offline 状态；
3. 查看选中节点的会话；
4. 创建会话；
5. 发送 prompt；
6. 通过 session/follow 消费历史快照和实时事件；
7. 管理共享 enrollment 规则。

UI 不替代通用 API，也不实现新的业务逻辑。节点上的 Agent、文件和工具仍由 dsh-node
执行，UI 只是会话 Remote 的一个操作客户端。

## 2. 信息架构

~~~mermaid
graph TD
    App[/ui DSH Coordinator]
    App --> Header[顶部状态栏]
    App --> Auth[API token 输入]
    App --> Enrollment[登记设置]
    App --> NodePane[节点列表]
    App --> SessionPane[会话列表]
    App --> ChatPane[消息与事件]
    NodePane --> NodeStatus[ready/offline/能力数]
    SessionPane --> SessionList[session/list 或 page]
    SessionPane --> CreateSession[创建会话]
    ChatPane --> Snapshot[follow 初始快照]
    ChatPane --> Events[follow 增量事件]
    ChatPane --> Prompt[文本输入与发送]
~~~

## 3. 页面布局

当前页面采用三栏操作台，布局重点是“节点 → 会话 → 消息”的逐级选择：

~~~text
┌──────────────────────────────────────────────────────────────────────────────┐
│ DSH Coordinator   [服务/请求状态]    [API token] [刷新] [登记设置]             │
├───────────────────┬───────────────────────┬──────────────────────────────────┤
│ 节点              │ 会话                  │ 消息                             │
│                   │                       │                                  │
│ ● node-a          │ ● session-1           │ session-1             [流状态]   │
│   ready · 97 能力 │   cwd / 状态          │ ──────────────────────────────── │
│                   │                       │ 历史快照、用户消息、AI 事件       │
│ ● node-b          │ ＋ 新建               │                                  │
│   offline         │                       │ ──────────────────────────────── │
│                   │                       │ [输入 prompt]             [发送]  │
└───────────────────┴───────────────────────┴──────────────────────────────────┘
~~~

### 3.1 区域职责

| 区域 | 展示 | 主要动作 | 后端接口 |
| --- | --- | --- | --- |
| 顶部状态栏 | 服务、请求、错误或鉴权状态 | 刷新、输入管理 token | /api/health、各 API |
| 节点栏 | nodeId、名称、state、能力数 | 选择节点、刷新列表 | GET /api/nodes |
| 会话栏 | 会话标题/标识、运行态、cwd 等 | 加载、选择、创建会话 | /api/sessions、/api/session/create |
| 消息栏 | snapshot、事件、助手流、错误 | 跟随、停止、发送 prompt | /api/session/follow、/api/session/prompt |
| 登记设置 | open、persisted、stateFile 等事实 | 开启、关闭共享登记 | GET/POST /api/enrollment |

## 4. 关键交互流程

### 4.1 首次加载

~~~mermaid
sequenceDiagram
    participant User as 操作人员
    participant UI as /ui
    participant API as Coordinator API

    User->>UI: 打开页面
    UI->>API: GET /api/health
    API-->>UI: listening
    UI->>API: GET /api/nodes
    API-->>UI: 脱敏 NodeView[]
    UI->>API: GET /api/enrollment
    API-->>UI: open/persisted/stateFile
    UI-->>User: 节点和登记状态
~~~

配置 api-token 时，/ui 页面可以作为浏览器导航返回；真正的 /api 请求需要带
Authorization: Bearer。401 时 UI 在当前页面提示输入或更新 token，并重试本次操作。
没有配置 api-token 时，本机浏览器可直接访问；非回环来源在无 api-token 时收到 403。

### 4.2 节点、会话和 follow

~~~mermaid
sequenceDiagram
    participant User as 操作人员
    participant UI as 三栏 UI
    participant API as HTTP API
    participant Node as dsh-node

    User->>UI: 选择 ready 节点
    UI->>API: GET /api/sessions?nodeId=...
    API->>Node: session/list
    Node-->>API: 会话列表
    API-->>UI: session list
    User->>UI: 选择会话
    UI->>API: POST /api/session/follow
    API->>Node: session/follow
    Node-->>UI: snapshot NDJSON
    Node-->>UI: event/assistant-stream NDJSON
    User->>UI: 切换节点或会话
    UI->>UI: AbortController.abort()
    UI->>API: 结束旧 follow 并创建新 follow
~~~

follow 首帧是快照，之后是增量事件或助手流帧。页面按换行拆分 NDJSON，
不会等待整个长流结束才渲染。切换选择时必须先 abort 旧流，保证同一页面不会
同时持有多条 follow 消费链。

### 4.3 创建和发送 prompt

1. 用户在会话栏点击“新建”，填写 cwd、workspaceId、sessionId 或 agentPreset；
2. UI 调用 session/create，成功后刷新会话列表；
3. 用户在消息栏输入文本并发送；
4. UI 调用 session/prompt；
5. 成功后保持或重新建立 follow，以便展示节点生成的真实事件。

prompt 文本会在节点上真实执行一轮 Agent。发送按钮附近应明确提示这不是本地草稿，
可能修改文件、执行命令或产生外部副作用。

### 4.4 enrollment 设置

登记设置面板可以：

- 读取 open、persisted、stateFile 等事实；
- 设置新的共享登记密钥；
- 显式关闭共享登记。

输入框是只写的。页面不显示当前密钥，因为 API 不提供读取途径；输入框留空表示
不修改，不应被解释为“清空密钥”。关闭登记必须使用独立动作。

## 5. 组件与状态设计

| 组件 | 初始态 | 加载态 | 成功态 | 异常态 |
| --- | --- | --- | --- | --- |
| 服务状态 | unknown | checking | listening | 401/403/网络错误 |
| 节点列表 | empty | loading | ready/offline 列表 | 加载错误 |
| 会话列表 | 未选择节点 | loading | 会话列表/空列表 | 节点 offline、Remote 错误 |
| follow 消费器 | idle | opening | snapshot + event | stream error、abort、断线 |
| prompt 输入 | enabled | submitting | accepted | 参数错误、节点离线、超时 |
| enrollment | unknown | reading | open/closed + persisted | 鉴权/保存错误 |
| 节点状态 | unknown | connecting | ready | offline、revoked |

### 5.1 空状态

| 场景 | 用户需要看到的解释 | 下一步 |
| --- | --- | --- |
| 没有节点 | 尚未登记或没有节点拨入 | 检查 /node 地址、token 或 enrollment |
| 节点 offline | 节点记录存在，但当前没有 ready 连接 | 启动节点或检查网络 |
| 没有会话 | 节点在线但尚无会话 | 点击创建会话 |
| follow 无历史 | 会话存在但没有可展示记录 | 等待增量事件或发送 prompt |
| enrollment closed | 新节点不能自助登记 | 由管理员 add，或显式开启 enrollment |

### 5.2 错误文案

错误展示至少保留稳定 code，便于开发者从 UI 追到 API 或节点日志。推荐分层：

- coordinator/auth-rejected：管理 token 无效，或请求来源不是允许的机器；
- coordinator/node-offline：节点记录存在但没有可用连接；
- coordinator/capability-mismatch：节点未声明对应载具；
- coordinator/request-timeout：调用未在截止时间前完成；
- 节点原始 code：保留原始命名空间，避免 UI 把业务错误改写成通用 500。

## 6. 鉴权与凭据体验

1. 顶部 API token 输入框只保存管理面 token，不应提示用户填节点 token。
2. 节点接入口令和 enrollment secret 不在 UI 的任何列表或结果中显示。
3. API token 与节点 token 是两种不同凭据；文案必须分别命名。
4. /ui 页面本身不携带凭据；需要凭据的动作由 fetch 请求统一附加 Bearer。
5. 远程管理未配置 api-token 时直接显示“管理面仅回答本机；启动时加 --api-token”。
6. prompt 发送前应避免暗示“仅发送文本”，应说明它会在真实节点上运行。

## 7. 可访问性与实现约束

当前实现是原生 HTML/CSS/JavaScript，没有单独的设计系统或前端构建产物。因此：

- 状态文本应优先于只使用颜色来区分 ready/offline；
- 发送、停止、刷新、创建等操作应有清晰的按钮标签；
- 长流区域应持续追加而不是重排整个页面；
- 节点、会话和消息区域应保持稳定位置，避免事件流导致操作控件跳动；
- 任何新增交互都应保持零构建和单端口托管，不引入第二个服务。

移动端响应式布局、复杂权限下的多角色 UI、审计日志和可视化背压指标目前没有实现，
不能把当前三栏页面当作这些能力已经存在。

## 8. UX 与 API 映射

| 用户动作 | UI 状态变化 | API/数据 |
| --- | --- | --- |
| 刷新节点 | 节点列表 loading → ready/offline | GET /api/nodes |
| 选择节点 | 会话栏 loading → list/empty | GET /api/sessions |
| 创建会话 | 创建按钮 submitting → 新会话 | POST /api/session/create |
| 打开会话 | 消息栏 opening → snapshot/event | POST /api/session/follow |
| 发送 prompt | 输入框 submitting → accepted | POST /api/session/prompt |
| 停止 follow | stream active → cancelled | fetch abort，服务端 cancelStream |
| 设置 enrollment | 表单 submitting → open/closed | POST /api/enrollment |

## 9. 当前 UX 限制

- UI 面向本机操作台，不提供独立的远程多用户工作区。
- api-token 的远程管理依赖用户把 token 输入浏览器；没有 SSO、RBAC 或审计确认。
- session/follow 的事件形状由节点能力决定，UI 只能按已验证的真实事件形状渲染。
- prompt 是真实副作用操作，没有 Coordinator 侧的审批、预览或撤销。
- 真机热重载、网络中断后的所有视觉恢复路径仍需结合真实 dsh-node 持续验证。
