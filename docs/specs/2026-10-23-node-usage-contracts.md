# 节点用量与管理端接口契约 v1

状态：交接设计，非已发布协议。和同日 design、implementation plan 一起阅读；本文件细化早期设计中的未定字段，发生冲突时以本契约和实施计划为准。变更契约须同步 Node、Coordinator 两端类型、fixture、测试和文档，不能单边改名。

## 1. 公共类型与计量规则

```ts
type Decimal = string // /^(0|[1-9][0-9]*)$/，非负十进制整数字符串
type IsoTime = string // UTC ISO-8601，毫秒精度
type AttemptState = 'running' | 'completed' | 'failed' | 'cancelled' | 'process_interrupted'
type Purpose = 'conversation' | 'compaction' | 'session-title' | 'other'
interface UsageSample {
  uncachedInputTokens: Decimal | null
  cacheReadTokens: Decimal | null
  cacheWriteTokens: Decimal | null
  outputTokens: Decimal | null
  reasoningTokens: Decimal | null
  totalTokens: Decimal | null
}
interface AttemptSnapshot {
  attemptId: string
  startedAt: IsoTime
  endedAt: IsoTime | null
  provider: string | null
  model: string | null
  sessionId: string | null
  purpose: Purpose
  state: AttemptState
  usageReported: boolean
  usage: UsageSample
  source: 'runtime' // v1 不进行历史补录
}
type UsageEvent = {
  seq: Decimal
  recordedAt: IsoTime
} & (
  | { kind: 'attempt'; attempt: AttemptSnapshot }
  | { kind: 'gap'; fromAt: IsoTime; toAt: IsoTime; reason: 'storage-failure' | 'capacity-limit' | 'collector-reset' }
)
interface ReplayGap { fromSeq: Decimal; throughSeq: Decimal; reason: 'pruned' | 'restore' }
```

- seq 从 1 开始，每 collector 单调递增；afterSeq/ackedThroughSeq 初始 0。跨协议一律 Decimal，禁止字符串词典序比较。
- attemptId 为随机 UUID；唯一身份为 (nodeId, collectorId, attemptId)。一次 attempt 的后续事件包含完整快照，按更大 seq 替换。startedAt 不允许修改，终态不能回到 running。
- 每个 Token 桶独立可空，0 是明确报告的零；字段缺失/不合法转为 null 并诊断，绝不把 NaN、负数、小数强转为零。供应商原始数值必须先为 safe integer，再转 Decimal。
- totalTokens 优先保留供应商一致的值；没有供应商总量且四个互斥桶均已知时相加。供应商总量小于已知互斥桶之和时视为不一致，置 null 并标记该调用质量问题。reasoningTokens 超过 outputTokens 时无效，不能额外计入总量。
- attemptKnownTokens = totalTokens ?? sum(已知的四个互斥桶)。汇总 knownTokens 是这些下界之和；totalUnknownCount 统计 totalTokens 为 null 的调用数，字段名/文案必须说明“已知合计”。不能仅把 totalTokens 为 null 的请求整体排除导致已知桶丢失。
- usageReported 表示本次确实收到 usage 样本，不等同 total 完整；不能依靠桶非空推断。usage 返回率分母为已终止调用；运行中单列，不把正在等待 usage 的请求作为缺失。
- unknownUsageCount 表示已终止且 usageReported=false；totalUnknownCount 对所有调用统计，并提供 runningCount 帮助解释。失败/取消有 usage 仍累计。
- runtime 的 finish.reason.kind='error'→failed，'aborted'→cancelled，其余正常终止→completed；消费端 return()/AbortSignal 取消→cancelled；无 finish 而异常/提前结束需区分取消与 failed。退出进程未完成→process_interrupted，保留最后 usage。
- requestCount 是已实际迭代执行的 runtime 调用数，不是每个 token、流连接或用户轮次。重试调用新建 attempt。若真实宿主会在一次 stream 内部多次请求，Task 0 必须确认可观察层覆盖每个 attempt，禁止把逻辑调用伪称实际 API 次数。
- provider/model 取实际调用上下文；无法确定时 null，UI 使用“未知”。目的缺省且 sessionId 存在→conversation，明确 purpose 保留；其余→other。原生子代理经过 runtime 时单独调用，与父层的会话统计不再重复相加。

## 2. Node Remote

沿用现有 rpc.request/rpc.result；namespace 为 nodeUsage，三个 unary；status 为零参数，wire payload={args:{}}；read/ack 参数只有 request，wire payload={args:{request:{...}}}。不扩展 dsh-node/1 帧枚举。

```ts
interface UsageStatus {
  schemaVersion: 1
  enabled: boolean
  state: 'ready' | 'disabled' | 'unsupported' | 'degraded'
  collectorId: string | null
  startedAt: IsoTime | null
  earliestAvailableSeq: Decimal
  latestIssuedSeq: Decimal
  ackedThroughSeq: Decimal
  pendingCount: Decimal
  pendingBytes: Decimal
  coverage: 'complete' | 'incomplete' | 'unknown'
  degradedSince: IsoTime | null
  issueCode: string | null
}
interface UsageReadRequest {
  collectorId: string
  afterSeq: Decimal
  limit: number // 1..200，缺省 200
  maxBytes: number // 缺省 262144，最大 262144
}
interface UsageBatch {
  schemaVersion: 1
  collectorId: string
  events: UsageEvent[] // 按 seq 升序
  gaps: ReplayGap[] // 仅 afterSeq 到首个可重放项之前的缺口
  nextSeq: Decimal // 本批覆盖到的游标，包括已解释 gap；空批无 gap 则等于 afterSeq
  hasMore: boolean
  status: UsageStatus
}
interface UsageAckRequest { collectorId: string; throughSeq: Decimal }
interface UsageAckResult { collectorId: string; ackedThroughSeq: Decimal }
```

`nodeUsage/status` → UsageStatus，调用 args={}，不得额外传 request；read/ack 使用对应 request。未知参数拒绝；collectorId 错误返回 nodeUsage/collector-mismatch（附最新安全 status）；非法参数返回 nodeUsage/invalid-arguments，存储错误 nodeUsage/storage-unavailable；disabled/unsupported 返回明确状态，不返回假空统计。

- status 的 earliestAvailableSeq：有可读事件取最小 seq，无事件取 latestIssuedSeq+1。latestIssuedSeq 始终包含已清理事件的历史上界。
- read 自适应小于现有 RPC 最大帧；返回 JSON 的完整 envelope 不能超帧。单条过大时不得越过它继续 ACK；返回 nodeUsage/record-too-large 并使该节点 degraded。字符串 provider/model≤256、sessionId≤256、ID≤128，单条事件≤16 KiB，禁止包含消息正文、工具参数、异常堆栈和凭据。
- Node 持久化 deliveredThroughSeq，只在实际交付过的连续区间/显式 gap 范围后推进；ack 不得超过该值。ACK 幂等，旧 ACK 返回当前水位，不降低水位。先写 ACK 水位，再异步清理；未确认永不自动删除。
- Coordinator 每轮读取 afterSeq=min(库中游标, Node ackedThroughSeq)，让 ACK 丢失后可重读原批再确认；已清理前缀通过显式 gaps 恢复。仅已入库的连续前缀可确认；事务失败不 ACK。
- 相同 (nodeId,collectorId,seq) 已存在但规范化内容不同，属于世代分叉，返回 collector-fork 并停止该世代同步，不得 INSERT IGNORE 后当正常重复继续 ACK；要求执行显式重置/恢复流程。
- 当前只支持单 Coordinator 消费该节点队列。更换 Coordinator、备份回退视为新消费者或恢复，明确记录历史缺口；不承诺多消费者独立保留。

## 3. Coordinator 存储结构

统一库 coordinator.sqlite，PRAGMA foreign_keys=ON、journal_mode=WAL、synchronous=FULL、busy_timeout=1000；Node 队列相同持久化参数。所有凭据文件和目录使用宿主实际可用的最小权限；SQLite 不自带密码加密。不得注册 HTTP 文件下载路径读取 DB/WAL/备份。

| 表 | 主键与关键字段 | 约束/用途 |
|---|---|---|
| schema_migrations | version INTEGER PK, applied_at | 事务 schema 升级；拒绝比程序新的 schema |
| settings | key TEXT PK, value_json TEXT | operator token、迁移来源、coordinator instance ID、配置；响应按白名单裁剪 |
| enrollment | singleton_id=1, kind, token | closed/shared-secret；与旧值保持一致 |
| nodes | node_id TEXT PK, token, node_name, role, revoked_at | 不存 socket 在线状态；历史统计引用 node_id 不级联删除 |
| admin_users | singleton_id=1, username UNIQUE, password_hash, salt, kdf_json, credential_version | CHECK singleton_id=1，唯一管理员 |
| admin_sessions | token_hash TEXT PK, user_id, credential_version, created_at, last_seen_at, expires_at, csrf_hash | 用户 FK；不存原始 Cookie |
| auth_audit | id INTEGER PK, at, action, outcome, source_address | 不记录密码/token；保留最近 30 天，每日清理 |
| usage_events | (node_id,collector_id,seq) PK, kind, event_json | seq SQLite INTEGER；入参 Decimal→BigInt；幂等原始事件 |
| usage_attempts | (node_id,collector_id,attempt_id) PK, revision_seq, started_at, ended_at, provider, model, session_id, purpose, state, usage_reported, token桶, total_tokens, known_tokens | Token 桶 INTEGER 可空；更新只接受更大 revision_seq |
| usage_sync_state | (node_id,collector_id) PK, cursor_seq, last_synced_at, last_error, coverage, pending_count, started_at | 旧 collector 保留；活跃 collector 单独记录 |
| usage_gaps | id PK, node_id, collector_id, from_seq/to_seq 可空, from_at/to_at 可空, reason, detected_at | 与推进游标同事务持久化；不假装缺口属于精确日期 |

每桶 SQL INTEGER 限制到 2^63-1，超出返回数据错误而非截断。聚合时以 BigInt 保证精度；不能让 SQLite SUM 的 64 位溢出变成 500，需按有界批次读取计数并在 JS BigInt 累加，或经验证的精确十进制聚合；禁止 REAL/TOTAL() 累加。HTTP 返回 Decimal，图表仅在显示边界转近似数值。

索引：usage_attempts(node_id,started_at,collector_id,attempt_id)、(started_at)、(provider,model,started_at)；events 原始主键；sessions(expires_at)。首期无单独日汇总表，避免两份真源。

Node 库 usage.sqlite：collector_meta（singleton、UUID、seq、ack、delivered水位、采集起点）、attempts（最近快照）、outbox（seq PK、事件）、coverage_state（故障时间段）。与账号/Node 配置文件分开。已 ACK 事件保留 24 小时安全窗口；对应终态 attempts 可在其最新修订已 ACK 且过窗口后清理，running 不清。容量高水位 256 MiB，90% 提醒，100% 降级；大小包括 DB/WAL，清理不能删除未 ACK 事件。对损坏/WAL 不可写按设计 gap 协议处理。

## 4. HTTP 查询契约

保持现有 `{ok:true,value:T}` 或 `{ok:false,error:{code,message,details}}`，不把本机路径或 SQL 放进错误。管理业务端点接受有效 admin Cookie 或现有 operator Bearer；auth/password/logout 仅 Cookie。

公共查询参数：from/to 必须为含偏移量 ISO 时间，内部变为 [from,to) UTC；timezone 首期只支持 Asia/Shanghai/UTC，默认 Asia/Shanghai；最大 90 天，默认近 7 个自然日；未来区间可返回空但不能越过 90 天限制。nodeId 可选。未知 nodeId 返回 404，已撤销/离线节点可以查询历史。

```ts
interface UsageTotals {
  requestCount: Decimal
  runningCount: Decimal
  completedCount: Decimal
  failedCount: Decimal
  cancelledCount: Decimal
  interruptedCount: Decimal
  usageReportedCount: Decimal // 已终止且报告 usage
  unknownUsageCount: Decimal // 已终止且没有 usage
  totalUnknownCount: Decimal
  knownTokens: Decimal
  uncachedInputTokens: Decimal
  cacheReadTokens: Decimal
  cacheWriteTokens: Decimal
  outputTokens: Decimal
  bucketUnknownCounts: { input: Decimal; cacheRead: Decimal; cacheWrite: Decimal; output: Decimal }
}
```

| 方法/路径 | 参数/结果 |
|---|---|
| GET /api/usage/summary | 公共参数 → {from,to,timezone,totals:UsageTotals,byModel:[{provider,model,knownTokens,requestCount,isOther}],coverage,lastSyncedAt,onlineCollectorCount,supportedNodeCount,totalNodeCount,gapCount}；节点数为安全整数，Token/调用数为 Decimal；byModel 按 knownTokens DESC、provider/model ASC，超过50组时显示前49组和一个 {provider:null,model:null,isOther:true} 的“其他”聚合组，普通组 isOther=false |
| GET /api/usage/nodes | 公共参数 + sort=knownTokens/requestCount/nodeName，order=asc/desc，page≥1、pageSize=1..100（默认20）→ {items:[{nodeId,nodeName,connectionState,collectorState,totals:UsageTotals|null,lastSyncedAt,startedAt,coverage,pendingCount}],page,pageSize,totalItems}；不支持采集用 null |
| GET /api/usage/series | 公共参数 + grain=hour/day（默认day）→ {from,to,timezone,grain,points:[{from,to,totals:UsageTotals}]}；hour≤7天；补齐空桶，仍保留全局 coverage，不能将缺口画成已知零 |
| GET /api/usage/requests | 公共参数 + provider/model/state/usage=all/reported/missing + limit=1..100（默认20）、cursor → {items:[AttemptSnapshot + {nodeId,collectorId,revisionSeq,knownTokens}],nextCursor} |
| GET /api/usage/status | nodeId 可选 → {persistenceEnabled,items:[{nodeId,collectorState,connectionState,activeCollectorId,startedAt,lastSyncedAt,pendingCount,pendingBytes,coverage,issueCode,gaps}]}；gaps 最近50条并说明截断 |

分页 cursor 为 base64url JSON 的 {v:1,filterHash,startedAt,nodeId,collectorId,attemptId}；按 startedAt DESC、nodeId/collectorId/attemptId DESC 排序。解码长度≤2KiB，拒绝不合法/与筛选不符 cursor，使用绑定参数。页面无数据时 totals 为零并附覆盖状态；unsupported 绝不可伪装有效零。

## 5. 登录与会话契约

首期 publicOrigin=http://192.168.0.13:8101；可配置显式允许的 Origin 列表供 localhost 验证，但无鉴权 localhost 后门。任何代理头默认不可信。Cookie 名 dsh_admin_session，HttpOnly、SameSite=Lax、Path=/，HTTP 不设 Secure；HTTPS 必须设 Secure。不得允许通过查询参数传会话或 token。

| 方法/路径 | 输入与结果 |
|---|---|
| GET /login | 匿名登录页，无已存在用户名/token 注入；登录后跳 /ui |
| GET /api/auth/me | 匿名→200 {authenticated:false,initialized:boolean}；有效会话→200 {authenticated:true,user:{username},csrfToken,expiresAt}；过期Cookie删除后匿名响应 |
| POST /api/auth/login | JSON {username,password}，精确匹配允许 Origin，Content-Type=application/json；成功设置新Cookie，200 {user:{username},csrfToken,expiresAt}；错误统一401，未初始化503，限速429 |
| POST /api/auth/logout | Cookie + X-CSRF-Token + Origin；撤销服务端会话、清Cookie，200 {loggedOut:true}；无会话401 |
| POST /api/auth/password | Cookie + CSRF + Origin；JSON {currentPassword,newPassword}；成功撤销全部会话（包括当前），清Cookie，200 {reauthenticate:true} |
| POST /api/auth/activity | Cookie + CSRF + Origin；前台真实操作至多每60秒发送一次，刷新空闲时钟但不延长绝对期限；200 {expiresAt}；被动轮询不调用 |
| GET / /ui | 未登录→303 /login；有效会话→页面；只持有 Bearer 不等同浏览器登录 |

登录路径仅 exact Origin + JSON，跨站表单禁止，因此不接受缺失 Origin 的登录；CLI 初始化走服务器进程接口不走该路由。对其他 Cookie 写操作同时校验 CSRF；csrfToken=HMAC-SHA256(服务端随机csrfKey, 原始会话Cookie token)，服务端csrfKey存settings，session只存csrfToken的hash，浏览器仅内存保存csrfToken。GET me可用当前请求Cookie重新派生csrfToken，不依赖服务端存原始会话token，刷新/服务重启后仍能恢复CSRF使用。Authorization 与 Cookie 同时存在时只走 Bearer，失效 Bearer 401，不回退。/auth/*（除 me 的匿名状态）不接受 Bearer 替代管理员。

用户名初始由 CLI 指定（默认 admin），支持 3..64 个 ASCII 字母数字 ._-；密码 12..128 Unicode 字符、UTF-8≤1024bytes，不 trim，不强制符号组合。比较失败用同一提示；不存在用户名也执行同成本 dummy hash。KDF 初始建议 scrypt N=32768,r=8,p=1,keylen=64,maxmem=64MiB，随机16byte salt；先在宿主校验耗时与内存。验证使用异步 crypto.scrypt 与 timingSafeEqual，最多2个并行 KDF，避免事件循环/线程池被拖垮。

登录限速：每源地址 15 次/10分钟、每账号失败 5 次/10分钟，返回 Retry-After；只在窗口内限速，正确账号不永久锁定；limiter 容量最多10000个键，超容量按最旧淘汰。用户名先规范化（本期 ASCII 小写）再限速，源地址取 socket remoteAddress，默认忽略 X-Forwarded-For。登录请求体≤8KiB。

Cookie token 随机32byte base64url；空闲30分钟、绝对12小时，时钟由服务端注入。持久化 lastSeen 至多每60秒一次，内存仍严格跟踪活动；服务重启可保守提前过期，不延长绝对寿命。仅 auth/activity 刷新空闲时钟，前端根据前台真实键盘、点击、触摸操作触发；禁止后台15秒轮询让空闲永不失效。每30秒检查已鉴权长流到期/撤销并关闭，改密/退出立即按 sessionId 关闭。定时清除过期会话，每小时一次。

CLI 形式：`node lib/cli.js admin init --db-file PATH --username admin`、`admin reset-password --db-file PATH`，无 --password 参数。必须停服务后执行；命令校验管理员是否已存在，init不覆盖，reset保留用户名；无 TTY 时失败并给安全提示。端口/UI未初始化也不提供公开建号入口。不把示例 demo-pass 用于真实部署。

`--no-state-file` 仅保留临时登记/显式Bearer机器API用途：用量同步禁用，持久化管理员CLI拒绝内存库，登录显示“管理登录需启用持久化数据库”并返回503；不能为了让演示模式可登录而增加匿名初始化或localhost后门。默认正式部署不使用此参数。

## 6. 覆盖状态优先级

collectorState 为 disabled/unsupported/degraded/initializing/synced/pending；connectionState 沿用现有 Node 状态，互相独立。先显示故障/不支持，再显示连接离线。离线但已清空队列的旧快照不能宣称离线期间“零用量”。有未知 usage 不直接等于传输缺口，coverage 专指采集/同步覆盖，两者在 UI 分开标示。

Node 采集默认 enabled=true，可用配置 usage.enabled=false 显式关闭；不因 coordinatorUrl/token 设置变更而卸载/重装观察器。插件生命周期仅一个观察器、一个库，网络 host 重建不能重复采集；停止连接但插件仍在运行时继续采集。Node 宿主无 llm 入口则 unsupported，其他节点转发能力保持正常。

Node collector_meta 绑定 nodeId；打开已属于其他 nodeId 的库时拒绝复用并报告需独立路径/显式重置，不能把旧节点记录归给新节点。队列文件使用单进程所有权锁，第二个进程不能同时采集同一库；多个profile必须有独立身份与路径。

采集完整性是尽力保证：供应商已计费但 usage 未返回、进程在收到后落盘前崩溃、磁盘损坏都可能存在缺口。不能把此方案描述为供应商账单的完整替代。

## 7. 技术参考与兼容性关卡

项目当前 engines 为 Node>=20；本地 CLI 检查为 v24.11.1，服务器文档基线 v24.12.0，DSH 实际插件宿主运行时仍需实测。不能仅以 CLI 版本代替 Electron/DSH 宿主。

SQLite 驱动作为 Task 0 的有界选择：优先验证支持 Node20/22/24 的固定版本 better-sqlite3（12.4.1 为已查 manifest 的候选，非安全审计后的最终选定版本）。查官方 manifest/发布说明及安全通告，选择同样兼容且无已知未处置高危漏洞的固定版本，记录到 lockfile；验证 Windows DSH ABI、Linux发布安装和干净重装。其候选版本有原生 install 脚本，不能照搬 --ignore-scripts 后假设能加载；应在发布文档中增加仅针对该依赖的明确构建/预编译安装步骤，禁止全面放开全部依赖脚本。若无法满足宿主 ABI、安装与版本下限，不继续实施依赖该库的任务，先提交兼容性结果及最小替代方案。

官方参考：[候选版本 manifest](https://github.com/WiseLibs/better-sqlite3/blob/v12.4.1/package.json)、[整数处理](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/integer.md)、[Node 内置 SQLite](https://nodejs.org/api/sqlite.html)。Node内置 SQLite 首次加入22.5，不能直接拿它替换所有 Node20宿主。不要未经确认修改两个仓库的 engines 或升级用户 DSH。
