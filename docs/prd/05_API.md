# dsh-coordinator - HTTP API 文档

> 文档性质：当前实现的运维 API 契约。请求和响应示例使用占位符，不包含真实凭据。
>
> API 运行在 Coordinator 与 /node WebSocket 相同的 HTTP 端口上。

## 1. 基础信息

| 项目 | 当前值 |
| --- | --- |
| 默认 Base URL | http://127.0.0.1:39472 |
| 节点 WebSocket | ws://127.0.0.1:39472/node |
| API 路径前缀 | /api |
| JSON Content-Type | application/json; charset=utf-8 |
| 流式 Content-Type | application/x-ndjson; charset=utf-8 |
| 默认请求体上限 | 1 MiB |
| 默认 unary 超时 | 30 秒 |
| 默认 stream 空闲超时 | 120 秒 |

API 只描述 Coordinator 这一层；endpoint 和 args 的业务含义通常由 dsh-node 上报的
Remote 决定。会话接口是唯一由 Coordinator 提供参数包装的业务专用接口。

## 2. 鉴权与网络边界

### 2.1 管理鉴权

启动时可以用 `--api-token` 配置，也可以在 `/ui` 的「运营端 token」面板中设置。
配置完成后，所有 `/api/*` 请求（包括读取 token 配置状态的接口）都必须带：

~~~http
Authorization: Bearer <operator-api-token>
~~~

api-token 是管理面 token，不是节点接入 token，也不是 enrollment token。token 只会被
用于校验，不会由 API 返回。

首次启动且尚未配置 token 时：

- 回环来源（127.0.0.0/8、::1、localhost 及 IPv4-mapped loopback）可访问本机管理面，
  并可通过 `POST /api/operator-token` 完成首次设置；
- 非回环 bind 下的远程管理请求统一 HTTP 403；
- `/ui` 始终只允许 localhost 访问；页面发出的 `/api` 请求仍遵守 API 鉴权。

设置 token 后，浏览器页面会立即使用新 token。更换 token 必须先使用旧 token
通过鉴权；`/api/operator-token` 的 POST 只允许 localhost，避免把凭据配置面暴露到网络。

使用 --no-api 时，/api 不安装，关联 UI 也不可用。非回环监听仍需要
--allow-insecure-bind，该选项不提供 TLS；生产部署应使用前置代理把节点连接升级
为 wss，并保护节点接入口令。

### 2.2 凭据卫生

- /api/nodes、/api/node、/api/capabilities、所有 NodeView 都不返回 node token；
- /api/enrollment 只返回 open、persisted、stateFile 等事实，不返回 enrollment secret；
- 日志和错误详情不应包含 node token、enrollment secret、api-token 或敏感对端文本；
- 状态文件包含 node token 和 enrollment secret，必须按凭据文件保护。

## 3. 通用响应和状态码

### 3.1 JSON 成功和失败

成功：

~~~json
{
  "ok": true,
  "value": {}
}
~~~

Coordinator 自身失败：

~~~json
{
  "ok": false,
  "error": {
    "code": "coordinator/invalid-arguments",
    "message": "the request body must be a JSON object",
    "details": {}
  }
}
~~~

节点已经返回的失败仍以 HTTP 200 携带节点原始错误：

~~~json
{
  "ok": false,
  "error": {
    "code": "session/not-found",
    "message": "the node reported a failure",
    "details": {}
  }
}
~~~

### 3.2 Coordinator 错误到 HTTP 状态

| HTTP 状态 | 典型 code | 含义 |
| --- | --- | --- |
| 400 | coordinator/invalid-arguments、coordinator/protocol-invalid | 参数、JSON、方法或协议错误 |
| 401 | coordinator/auth-rejected | API bearer 无效，或管理身份被拒绝 |
| 403 | coordinator/auth-rejected | 非回环远程管理未配置 api-token |
| 404 | coordinator/node-unknown、未知路由 | 节点不存在或路径不存在 |
| 405 | coordinator/invalid-arguments | 已知 API 使用了不支持的 HTTP method |
| 409 | coordinator/node-offline、coordinator/capability-mismatch | 节点/能力当前不可用 |
| 413 | coordinator/frame-too-large | 请求体超过 maxBodyBytes |
| 429 | coordinator/request-limit、coordinator/stream-limit | 并发上限 |
| 502 | 其他 Coordinator/连接失败 | 网关或连接层失败 |
| 504 | coordinator/request-timeout | unary 超时 |

stream 一旦发送 HTTP 200，后续失败不能再修改 HTTP 状态，会以 NDJSON 的 error
记录返回。

## 4. 路由总览

| 方法 | 路径 | 返回 | 用途 |
| --- | --- | --- | --- |
| GET | /api/health | JSON | 监听健康 |
| GET | /api/stats | JSON | 全局统计 |
| GET | /api/nodes | JSON | 节点脱敏视图 |
| GET | /api/node?nodeId=... | JSON | 单节点脱敏视图 |
| GET | /api/capabilities?nodeId=... | JSON | 当前能力摘要 |
| GET/POST | /api/operator-token | JSON | 查看或设置运营端 API token（仅 localhost 配置） |
| GET/POST | /api/enrollment | JSON | 查看或修改共享登记规则 |
| GET/POST | /api/sessions | JSON | session/list 包装 |
| GET/POST | /api/session/page | JSON | session/page 包装 |
| POST | /api/session/create | JSON | session/create 包装 |
| POST | /api/session/prompt | JSON | session/prompt 包装 |
| POST | /api/session/follow | NDJSON | session/follow 长流 |
| POST | /api/invoke | JSON | 通用 unary Remote |
| POST | /api/stream | NDJSON | 通用 stream Remote |
| POST | /api/streams/cancel | JSON | 取消活动流 |
| POST | /api/nodes/add | JSON | 增加节点记录 |
| POST | /api/nodes/rotate | JSON | 轮换节点 token |
| POST | /api/nodes/revoke | JSON | 撤销节点并关闭连接 |
| POST | /api/nodes/restore | JSON | 恢复被撤销节点 |

## 5. 健康、统计与节点查询

### 5.1 GET /api/health

响应：

~~~json
{
  "ok": true,
  "value": {
    "listening": true
  }
}
~~~

它只表示 HTTP listener 是否有地址，不表示某个节点 ready。

### 5.2 GET /api/stats

成功返回 value 为 Coordinator 统计对象，包含节点总数、ready 数、撤销数、
会话/请求/活动流等运行指标。具体字段以 src/server.ts 的 stats() 类型为准；
统计对象不包含任何 token。

### 5.3 GET /api/nodes

返回 NodeView 数组：

~~~json
{
  "ok": true,
  "value": [
    {
      "nodeId": "node-1",
      "nodeName": "desktop",
      "role": "developer",
      "state": "ready",
      "connectionId": "conn-...",
      "capabilityCount": 97,
      "inFlightRequests": 0,
      "activeStreams": 1,
      "revoked": false
    }
  ]
}
~~~

示例中的 connectionId 是运行时值；token 不会出现。

### 5.4 GET /api/node

必需 query：

~~~text
?nodeId=node-1
~~~

节点未登记返回 404 和 coordinator/node-unknown。

### 5.5 GET /api/capabilities

必需 query：

~~~text
?nodeId=node-1
~~~

返回该节点最近一次 ready 上报的能力摘要，包括 remotes、remoteSurfaceHash 和
namespaces。节点已登记但还没有能力上报时返回 409 和 coordinator/node-offline。

## 6. Operator token API

### 6.1 GET /api/operator-token

只返回 token 是否配置以及是否启用状态文件，不返回 token 值：

~~~json
{
  "ok": true,
  "value": {
    "configured": true,
    "persisted": true
  }
}
~~~

token 已配置时，这个 GET 也需要 `Authorization: Bearer <operator-api-token>`。

### 6.2 POST /api/operator-token

首次设置或轮换 token：

~~~json
{"token":"<new-operator-api-token>"}
~~~

请求只能从 localhost 发起。首次设置时尚未有 bearer；轮换时必须携带旧 token。
成功响应只报告事实，不返回新 token：

~~~json
{
  "ok": true,
  "value": {
    "configured": true,
    "persisted": true
  }
}
~~~

`persisted: true` 表示 Coordinator 配置了状态文件，token 会写入该文件并在重启时恢复。
使用 `--no-state-file` 时只保存在内存中。

## 7. Enrollment API

### 7.1 GET /api/enrollment

只返回事实，不返回共享登记密钥：

~~~json
{
  "ok": true,
  "value": {
    "open": false,
    "persisted": true,
    "stateFile": "C:\\work\\coordinator-state.json"
  }
}
~~~

当没有 state-file 时，persisted 为 false 或 stateFile 不存在，具体以当前配置为准。

### 7.2 POST /api/enrollment

请求体：

~~~json
{"token":"<new-enrollment-secret>"}
~~~

开启或替换共享登记规则。关闭：

~~~json
{"token":null}
~~~

成功响应只报告更新后的事实。登记 secret 会写入 state-file（若持久化开启）。
改变 enrollment secret 不会自动撤销已经登记的节点；撤销必须调用节点管理接口。

## 8. 通用 Remote API

### 8.1 POST /api/invoke

请求：

~~~json
{
  "nodeId": "node-1",
  "endpoint": "pluginInventory/list",
  "args": {},
  "timeoutMs": 30000
}
~~~

字段：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| nodeId | 是 | 已登记且当前可路由的节点 |
| endpoint | 是 | 节点上的 Remote 名称 |
| args | 否 | plain object；缺省按空对象处理 |
| timeoutMs | 否 | 本次 unary 截止时间 |

成功时 value 是节点返回值。节点业务错误以 HTTP 200 + 原始 node code 返回。

### 8.2 POST /api/stream

请求与 invoke 相同，可以额外指定 maxBufferedValues：

~~~json
{
  "nodeId": "node-1",
  "endpoint": "session/watch",
  "args": {
    "sessionId": "session-1"
  },
  "timeoutMs": 30000,
  "maxBufferedValues": 256
}
~~~

响应为换行分隔 JSON。服务端先发送 open：

~~~json
{"type":"open","streamId":"stream-...","endpoint":"session/watch"}
{"type":"data","value":{"kind":"event","payload":{}}}
{"type":"data","value":{"kind":"event","payload":{}}}
{"type":"end","count":2}
~~~

如果流失败：

~~~json
{"type":"error","error":{"code":"node/connection-lost","message":"...","details":{}},"count":2}
~~~

HTTP 客户端断开时，Coordinator 会尝试取消节点上的同一 stream。

### 8.3 POST /api/streams/cancel

请求：

~~~json
{
  "nodeId": "node-1",
  "streamId": "stream-...",
  "reason": "cancelled by operator"
}
~~~

成功响应为 {ok:true,value:...}。nodeId 和 streamId 都是必填字符串。

## 9. 节点管理 API

### 9.1 POST /api/nodes/add

请求：

~~~json
{
  "nodeId": "node-1",
  "token": "<node-token>",
  "nodeName": "desktop",
  "role": "developer"
}
~~~

nodeName 和 role 可选且只用于展示。成功后记录可用于下一次握手；返回值为脱敏
NodeView 或节点管理结果，不包含 token。

### 9.2 POST /api/nodes/rotate

请求：

~~~json
{
  "nodeId": "node-1",
  "token": "<new-node-token>"
}
~~~

轮换会更新 nodeId 的预期 token。调用方应让节点使用新 token；旧 token 不再作为
该记录的有效凭据。

### 9.3 POST /api/nodes/revoke

请求：

~~~json
{"nodeId":"node-1"}
~~~

撤销记录并立即关闭对应的在途连接；节点收到 auth-failed/4401 语义，之后使用旧凭据
的握手继续被拒绝。

### 9.4 POST /api/nodes/restore

请求：

~~~json
{"nodeId":"node-1"}
~~~

清除撤销状态。恢复不会自动建立连接，节点仍需重新拨入。

## 10. 会话 API

会话接口由 src/sessions.ts 构造，端点名称可以通过 SessionsOptions 配置。
默认端点：

| API | 默认 Remote | 载具 |
| --- | --- | --- |
| /api/sessions | session/list | unary |
| /api/session/page | session/page | unary |
| /api/session/create | session/create | unary |
| /api/session/prompt | session/prompt | unary |
| /api/session/follow | session/follow | stream |

### 10.1 GET/POST /api/sessions

GET query：

~~~text
?nodeId=node-1
~~~

可选 request query 参数，内容必须是 JSON object。POST 使用 JSON body：

~~~json
{
  "nodeId": "node-1",
  "request": {
    "workspaceId": "workspace-1"
  }
}
~~~

Coordinator 将 request 放到 session/list 的 _request 包装参数中。列表结果通过
普通 JSON envelope 返回。

### 10.2 GET/POST /api/session/page

GET 同样接受 nodeId 和可选 JSON request query；POST 形状与 sessions 相同。
与 list 不同，session/page 使用的包装参数名是 request。这是实现中的真实契约，
不能把两个端点合并为一个通用 requestArgument。

### 10.3 POST /api/session/create

请求：

~~~json
{
  "nodeId": "node-1",
  "cwd": "C:\\work\\project",
  "workspaceId": "workspace-1",
  "sessionId": "session-1",
  "agentPreset": "default",
  "request": {}
}
~~~

cwd、workspaceId、sessionId、agentPreset、request 均可选。request 是逃生口，
Coordinator 会按配置包装到 session/create。成功的节点结果通常包含 sessionId。

### 10.4 POST /api/session/prompt

请求：

~~~json
{
  "nodeId": "node-1",
  "sessionId": "session-1",
  "text": "请检查当前项目的类型错误",
  "mode": "queue",
  "requestId": "client-request-1",
  "clientTimeZone": "Asia/Shanghai",
  "content": []
}
~~~

字段：

| 字段 | 说明 |
| --- | --- |
| sessionId | 目标会话标识，可按当前节点实现要求传入 |
| text | 便利文本，会构造成 text content |
| content | 内容数组；传入时可绕过 text 便利构造 |
| mode | queue 或 steer，默认 queue |
| requestId | 缺省时由 Coordinator 生成 |
| clientTimeZone | 可选客户端时区 |
| request | 原始请求逃生口 |

text 会真实触发节点上的 Agent 回合，可能修改文件、执行工具或产生外部副作用。
成功响应是节点返回的 accepted 结果，错误保留节点原始 code。

### 10.5 POST /api/session/follow

请求：

~~~json
{
  "nodeId": "node-1",
  "sessionId": "session-1",
  "maxMessages": 100,
  "assistantStream": true,
  "request": {}
}
~~~

也可以使用预构造的 address；当 address 存在时按实现优先使用 address。follow 是长流，
HTTP 外层仍使用 open/data/end/error 记录。data.value 通常先包含历史 snapshot：

~~~json
{"type":"open","streamId":"stream-...","endpoint":"session/follow"}
{"type":"data","value":{"header":{},"cursor":"...","records":[],"hasMore":false,"projections":[]}}
{"type":"data","value":{"kind":"event","payload":{}}}
{"type":"end","count":2}
~~~

assistantStream 开启时，后续 value 还可能包含助手流片段。不要假设所有节点事件
都具有相同业务字段，应以目标节点的真实协议和 capabilities 为准。

## 11. PowerShell 调用示例

### 11.1 配置 token 并查看节点

首次设置 token（只允许在 Coordinator 所在机器执行）：

~~~powershell
'{"token":"<operator-api-token>"}' | Set-Content -Encoding utf8 operator-token.json
curl.exe -s -X POST http://127.0.0.1:39472/api/operator-token -H "content-type: application/json" --data-binary "@operator-token.json"
~~~

配置后查看节点：

~~~powershell
curl.exe -s http://127.0.0.1:39472/api/nodes -H "Authorization: Bearer <operator-api-token>"
~~~

### 11.2 查看节点

~~~powershell
curl.exe -s http://127.0.0.1:39472/api/nodes
~~~

配置 api-token 时：

~~~powershell
curl.exe -s http://127.0.0.1:39472/api/nodes -H "Authorization: Bearer <operator-api-token>"
~~~

### 11.3 调用 unary

~~~powershell
'{"nodeId":"node-1","endpoint":"pluginInventory/list","args":{}}' | Set-Content -Encoding utf8 invoke.json
curl.exe -s -X POST http://127.0.0.1:39472/api/invoke -H "content-type: application/json" --data-binary "@invoke.json"
~~~

### 11.4 读取 stream

~~~powershell
'{"nodeId":"node-1","endpoint":"session/watch","args":{"sessionId":"session-1"}}' | Set-Content -Encoding utf8 stream.json
curl.exe -s -N -X POST http://127.0.0.1:39472/api/stream -H "content-type: application/json" --data-binary "@stream.json"
~~~

PowerShell 示例使用 body 文件，避免原生 curl.exe 对 JSON 引号和管道输入的差异。

## 12. 库调用映射

| HTTP API | Coordinator 库入口 | 内部载具 |
| --- | --- | --- |
| /api/nodes | listNodes() | NodeRegistry 视图 |
| /api/node | node(nodeId) | NodeRegistry 视图 |
| /api/capabilities | capabilitiesOf(nodeId) | capability summary |
| /api/invoke | invoke(nodeId, endpoint, args, options) | RequestTable |
| /api/stream | openStream(nodeId, endpoint, args, options) | StreamHub |
| /api/session/create | createSession(nodeId, input) | sessions + invoke |
| /api/session/prompt | promptSession(nodeId, input) | sessions + invoke |
| /api/session/follow | followSession(nodeId, input) | sessions + openStream |
| /api/nodes/* | add/rotate/revoke/restoreNode | NodeRegistry + state-file |

HTTP 层不会把通用 Remote 的业务语义复制进 Coordinator；除会话五个 wrapper 外，
endpoint 和 args 应直接按节点 capability 与对端契约调用。

## 13. 客户端实现注意事项

1. 不要只按 HTTP 状态判断业务是否失败；HTTP 200 也可能有 ok:false 的节点错误。
2. stream 一旦收到 HTTP 200，应持续读取 NDJSON，直到 end、error 或客户端取消。
3. 不要把 stream.data.value 假设为固定对象；它是节点 Remote 的业务值。
4. 不要把 /api/sessions 的 _request 和 /api/session/page 的 request 混用。
5. 不要把 enrollment GET 的 open/persisted 当成 secret；secret 永远不可读回。
6. 轮换或撤销 token 后，调用方应重新建立节点连接并刷新节点列表。
