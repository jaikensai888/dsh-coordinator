# 管理员、用量与数据库运维手册

适用版本：本轮 `dsh-coordinator` 0.1.0（SQLite 统一库 + 单管理员登录 + 用量统计）。
发布事实源仍是 `docs/fabu.md`；本手册补充本轮新增的数据库、登录与回滚步骤。

> 本手册是**操作说明**，不代表已经执行过发布。真实部署需要单独授权，且管理员密码只能由
> 操作者在服务器 TTY 上输入。

## 1. 数据与凭据

| 内容 | 位置 | 说明 |
|---|---|---|
| 统一数据库 | `--db-file`，默认 `./coordinator.sqlite` | 节点登记、token、enrollment、operator token、管理员、会话、用量、同步游标 |
| 旧状态迁移备份 | 同目录 `coordinator-state.json.migrated.bak` | 迁移成功后自动生成，不自动删除 |
| 节点本地队列 | `<DSH_HOME>/storages/dsh-node/usage.sqlite` | 每个 profile 一个，绑定 nodeId |
| 会话 Cookie | 浏览器，`HttpOnly` | 服务端只存 token 的 SHA-256 |

数据库和备份都含可直接控制节点的 token 与管理员密码哈希，按原 `coordinator-state.json`
的权限要求保护（POSIX `0600` / 仅服务账号可读）。SQLite 本身**不加密**。

## 2. 本地发布前检查（两仓库）

```bash
# dsh-node
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node node_modules/tsdown/dist/run.mjs

# dsh-coordinator
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node node_modules/tsdown/dist/run.mjs
```

要求：类型检查退出码 0、测试全过、`lib/cli.js` 与 `lib/index.js` 存在。

## 3. 服务器发布顺序（需要明确授权后执行）

以文档基线 `pc@192.168.0.13:~/dsh-coordinator`、`dsh-coordinator.service`、`0.0.0.0:8101` 为例。

### 3.1 备份

```bash
ssh pc@192.168.0.13
systemctl --user stop dsh-coordinator.service

cd ~/dsh-coordinator
mkdir -p backup/$(date +%Y%m%d-%H%M%S)
# 一致性备份：服务已停止，.db 与 -wal/-shm 一并复制
cp -a coordinator.sqlite* backup/$(date +%Y%m%d-%H%M%S)/ 2>/dev/null || true
cp -a coordinator-state.json* backup/$(date +%Y%m%d-%H%M%S)/ 2>/dev/null || true
cp -a lib ui package.json pnpm-lock.yaml backup/$(date +%Y%m%d-%H%M%S)/
```

运行中也必须备份时，用 SQLite backup API（例如 `sqlite3 coordinator.sqlite ".backup ..."`），
**不要**只复制 `.db` 主文件。

### 3.2 上传与安装

```bash
# 本机
scp -r lib ui package.json pnpm-lock.yaml pc@192.168.0.13:~/dsh-coordinator/

# 服务器
cd ~/dsh-coordinator
pnpm install --prod --frozen-lockfile --ignore-scripts
node -e "const s=process.getBuiltinModule('node:sqlite'); const d=new s.DatabaseSync(':memory:'); d.exec('create table t(a)'); console.log('node:sqlite ok', process.version)"
```

`node:sqlite` 行必须输出 `ok`。若失败（Node < 22.5），停止发布，不要改用空配置继续运行。

### 3.3 首次迁移与管理员初始化（停服务状态）

```bash
# 迁移 + 建库：可以直接以新参数启动一次，看到 state-loaded 后停止；
# 或者用维护命令打开同一个库，效果等价且不监听端口：
node lib/cli.js admin init --db-file /home/pc/dsh-coordinator/coordinator.sqlite --username admin
```

- 密码在该命令的 TTY 中输入（隐藏回显），**不要**把密码放进命令行、环境变量或仓库。
- 首次启动会自动把同目录 `coordinator-state.json` 导入并重命名为 `.migrated.bak`；
  `admin init` 只建管理员，不导入节点（导入由服务启动完成）。
- 若已有管理员，命令会拒绝并提示用 `admin reset-password`。

### 3.4 启动参数

`~/.config/systemd/user/dsh-coordinator.service` 的 `ExecStart` 改为：

```
node lib/cli.js \
  --host 0.0.0.0 --port 8101 --allow-insecure-bind \
  --db-file /home/pc/dsh-coordinator/coordinator.sqlite \
  --public-origin http://192.168.0.13:8101
```

- `--allow-insecure-bind` 是局域网 HTTP 的既有前提；节点 WebSocket 与管理页都没有链路加密。
- operator token 仍保存在数据库/旧 JSON 中，不写入命令行。
- 需要机器客户端时，用已登录的管理员会话在控制台「运营端 token」里设置。

### 3.5 验证清单

```bash
systemctl --user is-active dsh-coordinator.service     # active
ss -ltnp | grep 8101                                   # 0.0.0.0:8101
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8101/api/health   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8101/api/stats    # 401（无凭据）
```

从另一台局域网电脑：

1. 打开 `http://192.168.0.13:8101/`，应 303 到 `/login`；
2. 用服务器 TTY 初始化的账号登录，进入 `/ui`；
3. 「用量统计」能看到节点与总量；「节点与会话」原有功能可用；
4. 节点侧日志出现 `dsh-node/usage-queue-open` 与 `dsh-node/usage-collector-installed`；
5. 控制台「运营端 token」可设置/轮换机器 token，`GET /api/stats` 带上 Bearer 返回 200。

## 4. 节点插件部署

节点与 Coordinator 是独立仓库、独立宿主：

1. 先发布**支持 `nodeUsage` 的 dsh-node**（本轮版本），再发布 Coordinator。
   旧 Coordinator 会忽略新能力；新 Coordinator 对旧节点显示「不支持采集」而不是报错循环。
2. 每个宿主记录：插件版本、安装目录、`DSH_HOME`、重启方式。仓库里没有节点宿主的发布文档，
   不能从 Coordinator 的目标地址推断节点位置。
3. 队列默认在 `<DSH_HOME>/storages/dsh-node/usage.sqlite`；
   需要换位置时在 `cordis.patch.yml` 配置绝对路径：
   ```yaml
   - name: dsh-node
     config:
       usage:
         enabled: true
         databaseFile: /absolute/path/usage.sqlite
         maxBytes: 268435456
   ```
4. 队列绑定 nodeId。**不要**把 `usage.sqlite` 复制给另一个 nodeId 使用；需要重置时停插件、
   移走旧队列、让插件生成新的 collectorId，UI 会出现新的采集世代。

## 5. 回滚

1. 停止服务：`systemctl --user stop dsh-coordinator.service`。
2. 恢复**上一份已构建制品**（`lib/`、`ui/`、`package.json`、`pnpm-lock.yaml`）并 `pnpm install --prod --frozen-lockfile --ignore-scripts`。
3. 旧版本只读 `coordinator-state.json`。把备份中的 `coordinator-state.json` 恢复到
   `~/dsh-coordinator/coordinator-state.json`，并用旧参数
   `--state-file ~/dsh-coordinator/coordinator-state.json` 启动。
4. 不要尝试让旧版本读取新 schema 的 `coordinator.sqlite`：它不理解该文件，
   也不会自动降级。
5. 回滚只恢复旧库会丢失本轮之后的用量；先保存新库快照并记录缺口，
   **不要承诺节点已 ACK 的数据一定能重放**（24 小时安全窗口之外的已确认事件会被清理）。
6. 任一步失败，保持服务停止，恢复到上一份已验证提交；不要把失败版本写成发布成功。

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `/api/*` 全部 401 | 没有会话也没有 Bearer | 打开 `/login` 登录；机器客户端用 Bearer |
| 登录页提示「尚未创建管理员」 | 库里没有 admin | 停服务，在服务器 TTY 执行 `admin init` |
| 登录 503 | 使用 `--no-state-file` 或数据库不可用 | 用持久化 `--db-file` 启动 |
| 节点显示「不支持采集」 | 节点插件旧版、缺 `llm`、或 usage.enabled=false | 升级节点、检查宿主 profile、查看节点日志 |
| 节点显示「待补传」 | 队列有未同步事件 | 等待下一轮（10 秒）或检查网络 |
| 节点显示「采集异常」 | 磁盘满、记录过大、队列损坏 | 看 `nodeUsage/status` 的 `issueCode`；扩容或重置队列 |
| 用量页显示覆盖「存在缺口」 | 采集世代重置或容量故障 | 接受缺口；需要精确历史时走独立补录工具（未实现） |
| `no SQLite driver` / `node:sqlite` 不存在 | 宿主 Node < 22.5 | 升级 Node 或改用带原生驱动的构建（需单独评估） |

## 7. 未完成事项

- 历史用量补录工具（独立来源标记、稳定去重键）。
- 费用与价格表、告警、CSV 导出、多 Coordinator HA。
- 用真实供应商凭据做一次端到端模型调用验证（当前只有实现阅读与 fixture 测试）。
- 在 `192.168.0.13` 与各 Node 宿主上复核 Node/ABI 与 `node:sqlite` 可用性。
- 数据库保留期限与归档策略（当前仅 24 小时 ACK 清理窗口，明细长期保留）。
