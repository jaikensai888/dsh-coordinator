# 节点用量统计设计

日期：2026-10-23。状态：架构方案已获用户认可；根据补充要求统一 Coordinator 存储，UI 等待再次确认；本文件不代表已实现。

交接入口：[完整实施包](../plans/2026-10-23-coordinator-handoff.md)。字段、接口与任务细节以同日 contracts 和 implementation plan 的细化定义为准；本说明保留设计理由与已确认范围。

## 补充范围：单管理员登录与局域网访问

用户已确认：首期单管理员，不开放注册；服务部署在 192.168.0.13，直接通过 IP 访问，不要求域名或公网入口。192.168.0.13 为私网地址，本轮验收为同一局域网或已有私网路由内访问，不承诺公网直接可达。

部署事实源：G:/claude_project/code-agent/dsh-coordinator/docs/fabu.md（经 fabu 全局 registry 定位）。文档记录 SSH 为 pc@192.168.0.13、目录 ~/dsh-coordinator、systemd --user 单元 dsh-coordinator.service，监听 0.0.0.0:8101；UI 当前仅 loopback。这是文档基线，本轮未 SSH 登录或核验线上版本，未执行发布。

目标访问地址为 http://192.168.0.13:8101/login；打开 / 或 /ui 未登录时跳至登录页，登录后进入 /ui，默认显示用量概览并可切换既有节点管理。沿用既有端口和节点 /node WebSocket 路由，不把管理账号密码用于节点连接。

认证设计：

- 首期唯一管理员，无注册、找回邮件或多角色系统。管理员通过服务器本地 CLI 初始化；隐藏式交互输入密码、不经命令参数或日志。未初始化时公开登录页只提示联系管理员，不能创建账号。遗失密码在服务器本地重置。
- coordinator.sqlite 增加 admin_users（数据库约束首期只允许一个管理员）及 admin_sessions；密码使用随机 salt 和 Node crypto.scrypt 生成的哈希，保存算法及成本参数，参数经目标机器验证。绝不存明文密码。
- 认证 API：GET /api/auth/me、POST /api/auth/login、POST /api/auth/logout、POST /api/auth/password。登录错误统一提示，限速采用账户与源地址组合；记录成功/失败/退出事件且不记录密码或 Cookie。登录限速不采用永久锁号，避免远程锁死唯一管理员。
- 会话使用随机不透明 token；服务端只保存 token 哈希及到期时间，Cookie 为 HttpOnly、SameSite=Lax、Path=/，不写 localStorage。建议空闲 30 分钟失效、绝对有效期 12 小时，服务端验证到期时间；退出立即撤销，改密或本地重置密码撤销全部会话。登录成功轮换会话标识。
- 本轮目标为用户指定的局域网 HTTP 访问；HTTP 下 Cookie 无 Secure，账号密码及会话不具备链路加密，界面提示“局域网 HTTP”。配置使用 publicOrigin=http://192.168.0.13:8101，HTTPS 接入后使用 Secure。未来公网访问必须单独设计 HTTPS 入口，不能把私网 IP 当成公网地址。
- Cookie 认证的写操作同时校验 CSRF token 与精确 Origin，登录校验精确 Origin 并防止 login CSRF；跨站浏览器调用默认拒绝，不启用任意 CORS。反向代理头只在配置可信代理后使用，本轮直接 IP 访问不信任 X-Forwarded-*。
- 管理 API 不再因请求来自 localhost 而免登录，原 localhost 配置 token 的 bootstrap 入口不能留下无鉴权后门。管理会话可执行现有 operator 范围操作；更换管理员密码仅接受管理员会话和当前密码，或本地 CLI 重置。
- 机器调用保留独立 operator Bearer token，以兼容 dsh-master。它不能登录 Web 或修改管理员账号，不能当 node-token 使用。请求同时带有 Authorization 和 Cookie 时明确采用 Bearer 路径，无效 Bearer 不回退 Cookie。节点仍走原有 node-token/握手认证。
- 登录页与静态非敏感资源可匿名访问；/ui 需要会话，管理 API 未认证返回 JSON 401，避免返回 HTML 破坏机器客户端；最小健康状态可匿名但不暴露节点、版本、凭据和部署路径。需鉴权的流在退出、改密或会话失效时及时终止，不能只在打开时检查。
- 管理端上线必须先迁移状态、在服务器初始化管理员并验证登录，随后启用远程 UI；无账号不允许以 localhost 自动信任方式继续管理。已有 node/operator token 保持原值，旧 JSON 不能用于生成管理员密码。

新增验收：从另一台局域网电脑登录；匿名请求节点、用量、配置和流接口返回 401；localhost 同样需认证；错误密码限速；退出/超时/改密后会话及原有流失效；跨站写入被拒；原有 Bearer 客户端及 Node 握手继续工作；服务重启后账号仍存在；无公开注册入口。此次登录原型仅用虚构示例账号，不连接服务器，不接收或保存真实凭据。

## 已确认的目标

- 在 dsh-coordinator 的现有 /ui 中查看各节点用量。
- 统计节点上全部经 DSH LLM runtime 执行的模型调用，包括本地操作和远程操作。
- 首期提供输入、输出、缓存 Token 和模型调用次数；不计算费用。
- 从功能启用后开始可靠记录，历史补录为后续独立功能。

## 已核查的基础

- Coordinator 是 TypeScript/Node 服务，声明 Node >=20，已有 HTTP API、WebSocket 节点连接和无构建步骤的 ui/index.html。
- 当前 coordinator-state.json 保存节点登记及凭据；按用户补充要求，实施时将其一并迁入统一 SQLite 数据库。
- Node 通过已有 Gateway 转发节点注册的 Remote，支持新增 namespace；双方独立维护协议类型。
- 本地 DSH 源码的 llm/stream waterfall 覆盖 runtime 模型调用，GenerateOptions 有可选 sessionId 和 purpose（compaction/session-title）。
- TokenUsage 将未缓存输入、缓存读取、缓存写入分开；reasoningTokens 是输出子集。
- 本地源码能力不等于已部署版本能力，实施第一步必须做版本兼容与真实采集验证。

## 推荐架构

Node 在 llm/stream 上安装只读观察器，对每次实际 runtime 调用分配 attemptId，采集终态及供应商 usage，写本地持久化队列。Coordinator 通过新增 nodeUsage/status、nodeUsage/read、nodeUsage/ack Remote 分页拉取，事务入库后确认。复用现有 RPC，不增加新的 WebSocket 帧类型。

不统计 Coordinator HTTP/RPC 次数作为模型调用次数；一次用户操作可能触发多个模型调用。也不同时累计 session usage 和 runtime usage，避免重复。

统计边界：当前安装并启用 dsh-node 的 DSH runtime/profile；同一机器多个 profile 是多个独立节点。外部 Codex/Claude 子进程、自带 API 客户端的插件不经过该 runtime 时无法自动覆盖，界面必须说明此边界。runtime 原生子代理、压缩、标题生成经过入口时应被覆盖。模拟/回放适配器能可靠辨识时单独标记并排除生产用量；无法辨识的路由在覆盖说明中列明。

## 采集与统计口径

每个 attempt 包含：attemptId、开始/结束 UTC 时间、provider、model、可选 sessionId、purpose、终态、TokenUsage、usage 状态。nodeId 由 Coordinator 当前已认证连接确定，不信任载荷中的身份。

- requestCount：实际开始执行的 runtime attempt 数；重试为新的 attempt。
- 成功、失败、取消、运行中、进程中断分别计数。finish=length 等模型正常终止算完成，不能直接视为网络失败。
- usageAvailableCount：拿到供应商 usage 的 attempt 数；缺少 usage 记 unknown，不能记为已知零。
- uncachedInputTokens、cacheReadTokens、cacheWriteTokens、outputTokens 为互不重叠桶；reasoningTokens 不重复加入总量。
- totalTokens 优先采用一致的供应商总量；否则仅在全部必要桶已知时推导。任一调用缺少总量时，汇总展示“已知 Token 合计 + 不完整调用数”，不伪装成完整总量。
- 各缓存桶保留已知值及缺失数量。没有返回缓存数据不表示缓存为零。
- 同一次 attempt 的多次 usage 样本采用修订替换，不累加；usage chunk 和最终消息不能算两次。
- 失败或取消前已收到 usage 的仍计入。没有返回 usage 的请求可能已产生账单，首期无法补出真实数值。
- 时间筛选按调用开始时间归属；跨日调用结束后更新原开始日。存储 UTC，UI 默认 Asia/Shanghai，并显示时区。

## 持久化、补传与幂等

Node 建议使用 SQLite 作为本地队列，Coordinator 使用统一 coordinator.sqlite，存放登记状态、运营端与登记凭据、用量及同步游标，SQLite 为唯一持久化真源。具体驱动须在实施验证中确认 Node 20 和 Windows/Linux 的安装可用性，不假设 node:sqlite 在全部目标 runtime 上存在。无需外部数据库服务。

### Coordinator 状态迁移

增加 schema_migrations、settings、nodes 和 enrollment 表，完整迁移旧状态中节点 ID、名称、角色、撤销状态、登记规则、operator-token 和登记凭据；只迁移旧文件实际持久化字段，连接、在线会话等进程状态仍留内存。沿用现有凭据处理方式和 CLI 覆盖优先级，不在 UI 回读 token 明文，不把业务凭据写进日志。数据库与备份继承原状态文件的访问权限保护，不声称 SQLite 自带凭据加密。

启动时先判断统一库是否已初始化：已初始化则只读库，禁止重复导入 JSON。库未初始化且旧 JSON 存在时，严格验证完整 JSON，在单事务中导入旧状态并写 migration/source 标记，提交并核验后将 JSON 重命名为 coordinator-state.json.migrated.bak。备份不自动删除；数据库和该备份均含凭据。迁移异常必须明确报错，不以空节点表或重新开放登记替代；提交成功而重命名失败时提示清理备份，下一次凭库中标记跳过导入。无旧文件的新安装直接初始化库。

新增 --db-file 指定统一库位置；兼容旧 --state-file，默认 coordinator-state.json 映射到同目录 coordinator.sqlite，自定义 a.json 映射到 a.sqlite，b.json 映射到 b.sqlite，避免同目录不同实例串库。数据库保存规范化的迁移来源路径，兼容启动时若来源不匹配则明确失败，不使用别的实例凭据。两参数同时显式提供时拒绝歧义配置；需要指定迁移来源时使用 --db-file 加 --migrate-state-file。保留 --no-state-file 的无持久化含义，登记配置使用内存库，并禁用可靠用量同步，UI 显示“用量同步未启用：需持久化数据库”；不读取后发送会触发 Node 清理的 ACK，不默默写磁盘。若 Node 仍独立启用采集，UI 提示该节点会继续积压，需启用 Coordinator 持久化或显式关闭节点采集。数据库 schema 升级使用版本化事务；运行过程中无 JSON/SQLite 双写。迁移验证包含自定义路径、同目录多状态文件、重复启动、坏 JSON、数据库不可写、token 不变和撤销节点不会意外恢复。

Node 数据表：collector_meta（持久化 collectorId、单调 seq、已确认游标）、attempts（当前状态）、outbox（不可变修订记录）。调用开始先持久化 running；usage 样本及终态产生新 seq 修订。修订写盘和队列写入必须同事务，发送绝不早于提交。

Coordinator 数据表：usage_events（nodeId/collectorId/seq 唯一）、usage_attempts（nodeId/collectorId/attemptId 唯一）、usage_sync_state（游标、最近成功同步时间、采集起点、故障及覆盖状态）。首期直接对 attempts 按索引聚合，先不引入可漂移的独立日汇总表；按 nodeId/startedAt、provider/model/startedAt 建索引。

流程：read(afterSeq, limit) → 校验连续序号及 schema → 单事务写事件、以较新 seq 更新 attempt、推进游标 → 提交成功 → ack(collectorId, throughSeq)。丢 ACK 或重连会重传，唯一键和修订规则保证不重复计数。ack 是累计且幂等的，不接受超出已交付范围的确认。

每节点同时一个同步任务；单批最多 200 条并受现有 RPC 帧字节上限约束。默认在线每 10 秒拉取，追赶积压时连续分页并让出执行时间；离线时暂停，重连后恢复。UI 默认每 15 秒刷新，可手动刷新；筛选页与同步任务互不依赖。

Node 仅清理已确认的 outbox，保留短期安全窗口；未确认数据绝不因超时静默丢弃。建议 256 MiB 高水位预警，达到磁盘限制后持续报告 degraded 和丢失区间，不阻断业务调用。Coordinator 不为当前丢失区间冒充完整覆盖。首期 Coordinator 明细默认持续保留，展示库大小，暂不自动删除；后续制定保留期限和归档。

重启时 Node 把上次遗留的 running 标记 process_interrupted，保留已持久化 usage；供应商已返回但尚未落盘就断电的窗口无法保证零丢失。若 Node 队列丢失，重建 collectorId，UI 标记采集重置。collectorId 变化不混用游标；新 collector 不自动重放旧 attempt。磁盘损坏或恢复旧备份造成的时间重叠必须标记覆盖不确定，不能承诺自动精确去重。

Coordinator 备份覆盖统一 coordinator.sqlite，节点登记、凭据、用量和已确认游标属于同一备份；SQLite 使用一致性备份方式。恢复早于 Node ACK 的旧备份可能无法补回已清理数据，必须记录缺口。首期按单个 Coordinator 实例运行设计，不支持多实例共享同一数据库写入。

### 缺口与采集世代恢复协议

status/read 必须返回 collectorId、earliestAvailableSeq、latestIssuedSeq、ackedThroughSeq 和明确的 gap 区间。磁盘容量故障期间停止分配无法持久化的 seq，以独立覆盖状态记录缺失时间段，恢复后先写 gap 标记再恢复采集；不能持久化缺口时持续标记 degraded，恢复后将故障开始至恢复时间作为不确定区间。

若 Coordinator 的游标早于可重放起点，Node 显式返回缺失的 seq 区间；Coordinator 必须在同一事务中持久化 gap 和推进至可重放起点前一位，再继续 read。未被明确 gap 解释的缺序批次拒绝入库，不自动跳过。同步已追平与覆盖完整是两种独立状态。节点的已确认游标高于 Coordinator 游标且数据已清理时，同样走 gap 流程，不能永久卡住同步。

首期不支持直接覆盖运行中的 Node 队列恢复备份。受支持的恢复流程必须停插件、隔离旧队列、生成新 collectorId 和新采集起点，再启动；旧备份不能自动混入实时流，需后续历史导入工具处理。发现 latestIssuedSeq 回退至 Coordinator 已见序号之前时停止该世代同步并提示执行此重置流程。任意手工复制、回滚数据库且不执行身份重置的操作不在完整性保证范围内；UI 保留恢复区间缺口。普通进程重启且数据库未回滚时继续使用原 collectorId 和 seq。

## 查询 API

沿用现有 operator 鉴权和错误格式；禁止节点 Token 访问全局用量查询。

- GET /api/usage/summary：时间段总体统计、覆盖情况、同步新鲜度。
- GET /api/usage/nodes：按节点聚合、排序和分页，包含离线及已撤销节点的历史。
- GET /api/usage/series：nodeId 可选、hour/day 粒度和显式时区，返回趋势。
- GET /api/usage/requests：节点、时间、provider/model、终态、usage 是否完整筛选和游标分页。
- GET /api/usage/status：采集支持情况、启用时间、最近同步时间、积压、故障和已知缺口。

时间采用 [from,to)；有范围与分页上限。每日分桶按请求时区计算，UI 时间与 API 一致。汇总中的计数和 Token 返回可安全序列化的整数表示，超出 JS 安全整数范围不能静默舍入。provider/model 值仅作数据，以参数化查询和 textContent 渲染。

## 管理界面

在现有 /ui 增加“用量统计”入口，沿用原生 HTML/CSS/JS，不为此迁移前端框架。

本轮提供可交互原型，示例数据明确标注；包含“概览”和从节点表进入的“节点详情”，支持日期范围切换、节点筛选、趋势指标切换、调用明细及返回概览。沿用现有控制台的信息密度与状态用语，费用不进入首期页面。原型用于确认布局与交互，不连接生产实例；无后端功能完成含义。

1. 全局页：今日/7天/30天/自定义日期；总调用、已知 Token、usage 完整率、待同步节点；每日趋势；各节点排名表。
2. 节点表：节点名及 ID、在线状态、调用次数、未缓存输入、缓存读写、输出、已知总量、未知用量调用数、最近同步时间、采集状态。
3. 节点详情：趋势、provider/model 分布、调用明细；会话 ID 仅作辅助字段，可缺失。
4. 状态区分：已同步、离线待补传、不支持采集、采集异常、首次同步、无调用、存在历史缺口。同步完成不代表每次调用都有供应商 usage。

节点改名不切断历史；节点撤销后停止拉取但保留历史；重新安装生成新 nodeId 默认视为新节点，不按名称合并。界面显示“数据截至”“采集开始于”和覆盖边界，不展示 prompt、回复正文、工具参数、凭据。

## 实施顺序及验收

阶段一：采集验证。用隔离 profile 验证宿主支持 llm/stream；覆盖本地调用、远程调用、重试、压缩、标题、原生子代理、失败与取消，确认观察器顺序、真实 provider/model 归属、排除回放可行性和驱动安装。不能覆盖的路径先报告；若核心入口不足，再提出最小核心扩展，不静默改变范围。

阶段二：Node 持久化队列与三个 Remote。验证重启恢复、分页上限、重复样本修订、ACK 丢失和断网积压。采集失败不改变业务流的 chunk、异常或取消语义。

阶段三：Coordinator 入库、同步和查询。验证重复批次、乱序/缺序、事务失败、库重启、节点改名/撤销、未知字段、整数边界及鉴权。升级兼容：先发布支持新 Remote 的 Node，旧 Coordinator 忽略该能力；新 Coordinator 遇到旧 Node 显示不支持。

阶段四：/ui 页面与端到端验收。两个节点同时执行本地/远程调用；其中一个离线产生调用后重连；Coordinator 重启及 ACK 丢失后总量不重复；包含缺 usage 的失败请求；按时区跨日与筛选查询结果一致，表格、趋势和明细使用同一统计口径。

改动范围：dsh-node 增加 collector/store/remotes 及生命周期挂载；dsh-coordinator 增加 store/sync/query/API/UI。首期无需修改 dsh-master。当前设计文档暂放 dsh-master 工作区；实施时应将正式设计移入 Coordinator 文档目录。

## 后续独立事项

历史补录应有独立来源标记、稳定去重键、时间重叠控制与明确可恢复范围，不直接混入实时采集。费用需要有效期价格表、币种及缓存计价，属于另一期。告警、预算、CSV、多 Coordinator HA 和外部子进程账单接入均不在首期。
