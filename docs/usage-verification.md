# 实现与验证记录

日期：2026-10-23。范围：`dsh-node` 与 `dsh-coordinator` 的本地实现、自动化测试、构建，
以及一次隔离的端到端运行（临时数据库 + 临时管理员 + headless Chrome）。
**本轮没有发布、没有重启服务器、没有修改线上凭据。**

## 1. 自动化结果（本机，Windows x64，Node 24.11.1）

| 仓库 | 类型检查 | 测试 | 构建 |
|---|---|---|---|
| `dsh-node` | `tsc -p tsconfig.json --noEmit`：退出码 0 | 18 个文件 / **528 passed** | `tsc -p tsconfig.build.json` + `tsdown`：成功（`lib/index.js`、`lib/client.js`） |
| `dsh-coordinator` | `tsc -p tsconfig.json --noEmit`：退出码 0 | 21 个文件 / **375 passed** | `tsc -p tsconfig.build.json` + `tsdown`：成功（`lib/index.js`、`lib/cli.js`） |

运行方式（本机 pnpm 的 deps-status 检查在沙箱内不可用，直接调用工具链）：

```
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node node_modules/tsdown/dist/run.mjs
```

新增测试覆盖的关键行为：

- `C/test/database.test.ts`：schema、事务回滚、未来版本拒绝、64 位整数往返与溢出拒绝。
- `C/test/usage-contract.test.ts`：`inputTokens→uncachedInputTokens`、缺失桶不推断总量、
  负数/NaN 不变 0、供应商总量不一致时置 null、超出 64 位拒绝。
- `C/test/state-migration.test.ts`：token/enrollment/revoked 原样迁移、备份重命名、
  二次启动不重复导入、坏 JSON 不部分导入、`a.json→a.sqlite`。
- `C/test/auth.test.ts`：单管理员只能创建一次、错误账号同提示、30 分钟空闲/12 小时绝对到期、
  轮询不续期、退出/改密撤销会话、限速与 CSRF。
- `C/test/usage-sync.test.ts`：重放只计一次、修订更新、同 seq 不同内容 `collector-fork`、
  缺序拒绝、缺口显式推进、写失败不 ACK、序号回退停止同步。
- `C/test/usage-query.test.ts`：已知/未知桶、运行中不算缺失、跨 64 位精确求和、
  上海跨日归属、`[from,to)`、分页无丢无重、模型分布 49+其他。
- `C/test/usage-api.test.ts`：匿名 401（含 localhost）、Cookie 会话、Origin/CSRF 拒绝、
  改密撤销、用量 API 的 Decimal 字符串与错误状态。
- `C/test/usage-cross-implementation.test.ts`：用**已构建的 dsh-node** 生成真实批次，
  交给 Coordinator 的解析器与仓库入库，验证两份手写契约一致。
- `N/test/usage-store.test.ts`：单 attempt 多修订、重启保留 collectorId/seq、
  running→`process_interrupted`、ACK 幂等且不超投递、未 ACK 不清理、pruned gap、
  单进程锁、跨 nodeId 拒绝。
- `N/test/usage-collector.test.ts`：未迭代不计数、usage+finish 一个 attempt、
  error/aborted 分类、无 usage 仍计数、抛异常保留样本、消费者 return 记 cancelled、
  存储失败不改变流。
- `N/test/usage-service.test.ts`：三个 Remote 的精确描述符、请求校验、错误码保留。

## 2. 端到端验证（隔离环境）

脚本：`tools/verify-usage-e2e.mjs`。它自建临时目录、临时 SQLite、临时管理员，
绑定 127.0.0.1 随机端口，用 headless Chrome 打开页面截图，结束后删除临时目录。
不读取任何真实部署的凭据。

运行：

```
node tools/verify-usage-e2e.mjs
```

本次输出（摘要）：

```json
{
  "migration": {
    "backupExists": true,
    "legacyFileGone": true,
    "nodes": [
      { "nodeId": "node-alpha", "tokenUnchanged": true, "revoked": false },
      { "nodeId": "node-beta", "tokenUnchanged": true, "revoked": false },
      { "nodeId": "node-revoked", "tokenUnchanged": true, "revoked": true }
    ],
    "operatorTokenFromLegacy": true,
    "enrollmentOpen": true
  },
  "auth": { "anonymousStatus": 401, "cookieStatus": 200, "csrfTokenLength": 43 },
  "usage": {
    "requestCount": "48",
    "knownTokens": "331302",
    "unknownUsageCount": "6",
    "bucketUnknowns": { "input": "6", "cacheRead": "6", "cacheWrite": "6", "output": "6" },
    "coverage": "complete",
    "gapCount": 1,
    "models": 3
  },
  "backfill": {
    "eventsInBatch": 3,
    "firstInserted": 3,
    "replayedInserted": 0,
    "replayedDuplicates": 3,
    "storedAttempts": 3,
    "storedTokens": "1050",
    "collectedBeforeReconnect": 3
  },
  "widths": { "320": 0, "736": 0, "1024": 0 },
  "errors": []
}
```

这组数字对应的验证点是：

- **迁移**：旧 JSON 的 3 个节点 token 全部原样保留，撤销节点仍撤销，operator token 与
  enrollment secret 生效，JSON 重命名为 `.migrated.bak` 且原文件消失。
- **鉴权**：同一个 `GET /api/usage/summary`，匿名 401，带会话 Cookie 200；
  CSRF token 长度 43（base64url 32 字节）。
- **未知不当零**：48 次调用中 6 次没有 usage，`unknownUsageCount=6`，四个桶的未知计数都是 6，
  已知合计 331302 仍按已知桶累计。
- **断线补传/ACK 丢失**：节点队列 3 个事件，第一次入库 3 条；同一批次重放
  `inserted=0 / duplicates=3`，最终库中仍是 3 条、1050 Token。
- **布局**：320/736/1024 三个宽度下 `document.scrollWidth - innerWidth = 0`，
  表格在自身容器内横向滚动。

## 3. 截图

| 文件 | 内容 |
|---|---|
| `docs/screenshots/login-1024.png` | 登录页（匿名、无示例账号、局域网 HTTP 提示） |
| `docs/screenshots/usage-overview-1024.png` | 用量概览（1024 宽） |
| `docs/screenshots/usage-overview-736.png` | 用量概览（736 宽） |
| `docs/screenshots/usage-overview-320.png` | 用量概览（320 宽，表格局部滚动） |
| `docs/screenshots/usage-detail-1024.png` | 节点详情（趋势、模型分布、调用明细与筛选） |

## 4. 未验证或未包含

- **真实供应商调用**：没有使用真实模型凭据，`llm/stream` 的覆盖结论来自已安装运行时的
  实现阅读与 fixture 观察器测试；需要在有凭据的 DSH 实例上补一次真实调用。
- **Linux 服务器与其它 Node 宿主**：`192.168.0.13` 的 Node/ABI、systemd 参数与
  `node:sqlite` 可用性本轮未 SSH 复核；发布前必须按 `docs/usage-compatibility.md` 第 4 节执行。
- **`better-sqlite3` 干净安装**：本机离线，无法验证预编译包与 `--ignore-scripts` 的组合。
- **真实浏览器键盘操作**：截图与溢出检查是自动化的；Tab 顺序与读屏体验只做了实现层面的
  `textContent`/`aria-*`/`tabindex` 处理，没有人工逐项走查。
- 历史补录、费用、多用户、多实例 HA 不在首期范围内。
