# dsh-coordinator - 数据模型文档

> Coordinator 当前没有数据库。本文描述源码中的内存实体、状态转换和唯一持久化文件。
> token、enrollment secret 等字段属于凭据，示例只使用占位符。

## 1. 模型边界

Coordinator 的数据分为两类：

1. 配置/身份数据：节点登记记录和共享登记规则，可以写入 coordinator-state.json；
2. 运行态数据：连接、能力、请求、流、统计和会话引用，只在进程内有效。

重启只恢复第一类数据。恢复后的节点初始仍是 offline，必须重新拨入并完成握手，
才能重新拥有 ready 连接和能力面。

## 2. 逻辑实体关系

~~~mermaid
erDiagram
    STATE_FILE ||--o{ NODE_RECORD : stores
    NODE_RECORD ||--o| LIVE_CONNECTION : owns
    LIVE_CONNECTION ||--o| CAPABILITY_SURFACE : reports
    LIVE_CONNECTION ||--o{ REQUEST_ENTRY : serves
    LIVE_CONNECTION ||--o{ REMOTE_STREAM : serves
    NODE_RECORD ||--o{ NODE_VIEW : projects

    STATE_FILE {
        int version
        string enrollmentKind
        string enrollmentToken
    }
    NODE_RECORD {
        string nodeId PK
        string token secret
        string nodeName
        string role
        string revokedAt
    }
    LIVE_CONNECTION {
        string connectionId PK
        string nodeId FK
        string state
        string connectedAt
        string lastSeenAt
    }
    CAPABILITY_SURFACE {
        string remoteSurfaceHash
        string remotes
        string namespaces
    }
    REQUEST_ENTRY {
        string requestId PK
        string endpoint
        string mode
        string outcome
        int timeoutMs
    }
    REMOTE_STREAM {
        string streamId PK
        string endpoint
        int expectedSeq
        int bufferedValues
        string terminal
    }
    NODE_VIEW {
        string nodeId PK
        string state
        int capabilityCount
        int inFlightRequests
        int activeStreams
    }
~~~

## 3. 持久化模型

### 3.1 STATE_FILE

当前 schema version 为 1。逻辑形状如下：

~~~json
{
  "version": 1,
  "enrollment": {
    "kind": "shared-secret",
    "token": "<enrollment-secret>"
  },
  "nodes": [
    {
      "nodeId": "node-1",
      "token": "<node-token>",
      "nodeName": "desktop",
      "role": "developer"
    }
  ]
}
~~~

字段说明：

| 字段 | 类型 | 是否必需 | 说明 |
| --- | --- | --- | --- |
| version | number | 否（兼容旧文件） | 当前应为 1；未知版本被忽略 |
| enrollment | object | 否 | closed 或 shared-secret 规则 |
| enrollment.kind | string | 是（存在 enrollment 时） | closed / shared-secret |
| enrollment.token | string | 是（shared-secret 时） | 共享登记凭据，不通过 API 读回 |
| nodes | array | 是（缺失时按空数组处理） | 登记节点集合 |
| nodes[].nodeId | string | 是 | 节点稳定身份 |
| nodes[].token | string | 是 | 节点接入口令 |
| nodes[].nodeName | string | 否 | 展示元数据，不参与鉴权 |
| nodes[].role | string | 否 | 展示元数据，不参与鉴权 |
| nodes[].revokedAt | string | 否 | 撤销时间；存在即拒绝握手 |

缺失文件是首次启动，不视为错误。文件存在但 JSON 损坏、根形状不对、版本未知或
不可读时，模块返回 secret-free 错误描述，Coordinator 继续以空状态启动。

### 3.2 写入策略

状态文件包含高价值凭据，写入遵守：

1. 先创建进程号和随机后缀组成的唯一临时文件；
2. 写入完整 JSON 并尝试设置 0600；
3. 用 rename 原子替换目标；
4. 替换失败时清理临时文件；
5. 日志只记录路径、数量和是否开启，不记录 token 值。

唯一临时文件用于避免并发保存共用同一个 .tmp 导致内容交错。调用方仍应尽量串行
触发保存；文件层本身提供最后一道保护。

## 4. 内存实体

### 4.1 NODE_RECORD

NodeRecord 是身份和凭据绑定的权威记录：

| 字段 | 说明 |
| --- | --- |
| nodeId | 节点持久化身份；握手时必须自报相同值 |
| token | 期望的节点 bearer token；任何 NodeView 都不返回 |
| nodeName | 可选展示名称 |
| role | 可选展示角色 |
| revokedAt | 可选撤销时间；存在时不接受握手 |

nodeName 和 role 永远不能成为授权依据。未知 nodeId、token 不匹配和 revoked 节点
对外统一表现为 coordinator/auth-rejected，详细原因只写入本机日志。

### 4.2 LIVE_CONNECTION

连接对象由 WebSocket 生命周期创建和销毁，常见字段包括：

| 字段 | 说明 |
| --- | --- |
| connectionId | Coordinator 在 hello.ok 中签发的连接标识 |
| nodeId | 绑定到 NodeRecord 的节点身份 |
| state | connecting、authenticating、ready、closing、offline |
| connectedAt | 本次 TCP/WebSocket 会话建立时间 |
| lastSeenAt | 最近一次有效入站活动时间 |
| capabilities | 最近一次 ready 上报的能力摘要 |
| request table | 当前等待 rpc.result 的 unary 调用 |
| stream hub | 当前活动 stream 及其缓冲 |

同一 nodeId 的新 ready 连接会替换旧连接。旧连接进入 closing，并且不再被视为
可路由的 ready 连接。

### 4.3 CAPABILITY_SURFACE

能力摘要来自 ready.capabilities：

| 字段 | 说明 |
| --- | --- |
| remotes | endpoint 与 mode 的摘要列表 |
| remoteSurfaceHash | 用于判断远端能力面是否改变 |
| namespaces | 节点不能枚举单方法时的命名空间提示 |

能力摘要属于当前连接，不持久化。下一次连接 ready 后完全覆盖上一份摘要。

### 4.4 REQUEST_ENTRY

每个 unary 调用在发出 rpc.request 前进入 RequestTable：

| 字段 | 说明 |
| --- | --- |
| requestId | 在该节点连接的在途范围内唯一 |
| endpoint | 要调用的 Remote |
| args | plain object 请求参数 |
| timeoutMs | 本次调用的截止时间 |
| outcome | pending 或已结算结果/错误 |

rpc.result、超时、AbortSignal、断线和 stop 共享同一个结算门。

### 4.5 REMOTE_STREAM

每个 stream 在发出 stream.open 前进入 StreamHub：

| 字段 | 说明 |
| --- | --- |
| streamId | 连接范围内唯一的流标识 |
| endpoint | 要调用的 Remote |
| expectedSeq | 下一次期望收到的序号，首值为 1 |
| bufferedValues | 当前尚未被调用方消费的值数 |
| terminal | open、end、error、cancel 或 connection-lost 等状态 |

seq 缺口、重复或超过有界缓冲会导致流失败或关闭；end/error 只能接受第一个终态。

### 4.6 NODE_VIEW

NodeView 是提供给 API/UI 的脱敏投影：

| 字段 | 说明 |
| --- | --- |
| nodeId、nodeName、role | 身份和展示信息 |
| state | 当前连接状态 |
| connectionId、connectedAt、lastSeenAt | 连接观察信息 |
| remoteSurfaceHash、capabilityCount | 能力观察信息 |
| inFlightRequests、activeStreams | 运行统计 |
| revoked | 是否处于撤销状态 |

NodeView 永远不包含 token、enrollment secret 或节点返回的敏感凭据。

## 5. 状态转换

### 5.1 节点/连接

~~~mermaid
stateDiagram-v2
    [*] --> connecting
    connecting --> authenticating: hello 收到且字段合法
    connecting --> closing: hello 超时或协议错误
    authenticating --> ready: token 通过且 ready 收到
    authenticating --> closing: auth 失败/ready 错误
    ready --> closing: revoke/stop/新连接/心跳失败
    closing --> offline: socket 清理完成
    ready --> offline: 对端正常关闭
    offline --> connecting: 新 WebSocket
~~~

### 5.2 unary

~~~mermaid
stateDiagram-v2
    [*] --> pending
    pending --> succeeded: rpc.result ok
    pending --> failed: rpc.result error
    pending --> failed: timeout/abort/disconnect/stop
    succeeded --> [*]
    failed --> [*]
~~~

### 5.3 stream

~~~mermaid
stateDiagram-v2
    [*] --> opening
    opening --> open: stream.ready
    opening --> error: open 失败/超时/断线
    open --> open: stream.data(seq + 1)
    open --> ended: stream.end
    open --> error: stream.error
    open --> cancelled: caller abort/HTTP close/timeout
    ended --> [*]
    error --> [*]
    cancelled --> [*]
~~~

## 6. 不变量

| 编号 | 不变量 |
| --- | --- |
| INV-01 | nodeId 与 token 的绑定由 NodeRecord 决定，nodeName/role 不改变授权 |
| INV-02 | 一个 nodeId 最多一个可路由的 ready 连接 |
| INV-03 | Coordinator 发出的每个节点帧都包含正确的 nodeId |
| INV-04 | requestId 和 streamId 在各自连接的在途范围内不重复 |
| INV-05 | unary 恰好一次结算；stream 恰好一个终态 |
| INV-06 | stream.data.seq 从 1 开始，每流单独递增 |
| INV-07 | 断线后不向已关闭的链路发送取消帧，不自动重放业务调用 |
| INV-08 | API/UI/NodeView 不回显节点 token 或登记密钥 |
| INV-09 | 持久化只恢复登记数据，不伪造 live connection、能力或在途工作 |
| INV-10 | enrollment API 只能报告 open/persisted/stateFile 等事实，不能读回 secret |

## 7. 数据流与生命周期

~~~mermaid
flowchart LR
    Config[CLI/Coordinator options] --> Registry[NodeRegistry]
    Registry --> Record[NodeRecord]
    Record --> StateFile[STATE_FILE]
    Node[hello/ready] --> Registry
    Registry --> View[NodeView]
    View --> Api[HTTP API/UI]
    Call[invoke/openStream] --> Connection[LIVE_CONNECTION]
    Connection --> Req[REQUEST_ENTRY]
    Connection --> Stream[REMOTE_STREAM]
    Req --> Node
    Stream --> Node
    Node --> Result[rpc.result/stream.*]
    Result --> Req
    Result --> Stream
~~~

启动时先读取状态文件和创建 Registry，再开始监听；停止时关闭新请求入口、
结束运行态并尽力把更新后的登记数据写回文件。运行态不会因为 state-file 写入而变成
可恢复任务。

## 8. 隐私与恢复边界

| 数据 | 进程内 | state-file | API/UI | 日志 |
| --- | --- | --- | --- | --- |
| nodeId | 是 | 是 | 是 | 可记录 |
| nodeName/role | 是 | 是 | 是 | 可记录 |
| node token | 是 | 是 | 否 | 否 |
| enrollment secret | 是 | 是 | 只报告是否开启 | 否 |
| api-token | 配置在进程内 | 否 | 只用于校验 | 否 |
| connectionId | 是 | 否 | 是 | 可记录 |
| capabilities | 是 | 否 | 是 | 可摘要记录 |
| request/stream 运行态 | 是 | 否 | 只通过结果体现 | 不记录秘密内容 |

状态文件本身就是凭据文件；任何备份、同步或共享行为都必须按秘密处理。
