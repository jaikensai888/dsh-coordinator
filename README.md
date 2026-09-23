# dsh-coordinator

`dsh-coordinator` 是 `dsh-node` 的对端服务：接收节点主动发起的 WebSocket 连接，
再通过 HTTP API 或内置 UI 控制节点上的 Remote。

本 README 只保留最常用的启动和使用方式。协议、数据模型和完整 API 见：

- [技术方案](docs/prd/02_TECH.md)
- [数据模型](docs/prd/03_DATAMODEL.md)
- [API 文档](docs/prd/05_API.md)
- [实测记录](docs/GROUND-TRUTH.md)

## 1. 快速启动（手动）

环境要求：Node.js 20+、pnpm。

### 1.1 构建

```powershell
cd G:\claude_project\code-agent\dsh-coordinator

pnpm install
pnpm --config.verify-deps-before-run=false --config.confirmModulesPurge=false run build
```

源码没有更新且 `lib/` 已存在时，可以跳过构建。

### 1.2 启动 Coordinator

推荐直接运行仓库根目录的 `start.cmd`：

```powershell
.\start.cmd
```

脚本会先清理占用 `39472` 端口的旧 Node Coordinator，再启动一个允许局域网节点连接的实例。保持这个窗口运行，停止服务按 `Ctrl+C`。

如需手动启动，使用：

```powershell
node lib/cli.js --port 39472
```

保持这个 PowerShell 窗口运行。停止服务按 `Ctrl+C`。

启动后地址：

```text
节点 WebSocket：ws://127.0.0.1:39472/node
管理 UI：       http://127.0.0.1:39472/ui
状态文件：      .\coordinator-state.json
```

### 1.3 在 UI 中配置 token

打开：<http://127.0.0.1:39472/ui>

按以下顺序配置：

1. 在「登记设置」中设置全局 `node-token`。
2. 在 `dsh-node` 中填写同一个 `node-token` 和上面的 WebSocket 地址。
3. 在「运营端 token」中设置 API 使用的 `operator-token`。

当前方案是全局一个 `node-token`，所以首次启动不需要在命令行传 token。
默认状态文件会保存这两个 token，重启后继续有效。

### 1.4 配置 dsh-node

在 DSH profile 的 `cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: dsh-node
      name: dsh-node
      config:
        coordinatorUrl: ws://127.0.0.1:39472/node
        auth:
          token: "与 Coordinator UI 中相同的 node-token"
```

也可以打开 dsh-node 自己的节点面板填写地址和 token。保存后节点会主动连接
Coordinator，不需要 Coordinator 监听第二个端口。

### 1.5 验证连接

在 UI 中看到节点状态为「已连接」即可。也可以调用 API：

```powershell
curl.exe -s http://127.0.0.1:39472/api/nodes `
  -H "Authorization: Bearer 你的operator-token"
```

返回 `ok: true` 且 `value` 中出现节点，说明连接成功。

## 2. 三种 token 的区别

| 名称 | 在哪里设置 | 用途 |
| --- | --- | --- |
| `node-token` | UI「登记设置」 | `dsh-node` 连接 Coordinator 时使用 |
| `operator-token` | UI「运营端 token」 | 调用 Coordinator `/api/*` 时使用 Bearer 鉴权 |
| `--enroll-token` | 启动命令行参数 | 不使用 UI 时，命令行设置全局 `node-token` 的可选 bootstrap 方式 |

不要把 `operator-token` 填到 dsh-node，也不要把 `node-token` 当作 API Bearer token。

如果使用 `--enroll-token`，启动方式是：

```powershell
node lib/cli.js --port 39472 --enroll-token "全局node-token"
```

它不是必需参数；手动 UI 配置方式只需要 `node lib/cli.js --port 39472`。

## 3. 常用启动方式

### 3.1 指定运营端 token 启动

如果不想通过 UI 设置 `operator-token`，可以在启动时传入：

```powershell
node lib/cli.js `
  --port 39472 `
  --api-token "operator-token" `
  --enroll-token "global-node-token"
```

之后所有 `/api/*` 请求都必须携带：

```http
Authorization: Bearer operator-token
```

### 3.2 允许其他机器上的 dsh-node 连接

```powershell
node lib/cli.js `
  --host 0.0.0.0 `
  --port 39472 `
  --allow-insecure-bind
```

其他机器的节点连接地址应使用 Coordinator 所在机器的实际 IP：

```text
ws://<coordinator-ip>:39472/node
```

这是明文 WebSocket，仅适合本地或可信 LAN 测试。生产环境应使用 TLS 反向代理，
并使用 `wss://`。

## 4. 常用 API

所有 API 都运行在 Coordinator 的同一个 HTTP 端口上。配置 `operator-token` 后，
请求必须携带 Bearer token。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 检查服务是否监听 |
| GET | `/api/nodes` | 查看节点状态 |
| GET | `/api/capabilities?nodeId=...` | 查看节点能力 |
| POST | `/api/invoke` | 调用节点 unary Remote |
| POST | `/api/stream` | 调用节点 stream Remote |
| GET/POST | `/api/operator-token` | 查看或设置运营端 token |
| GET/POST | `/api/enrollment` | 查看或设置全局 node-token 登记规则 |
| POST | `/api/nodes/revoke` | 撤销节点并断开连接 |

完整请求体、响应和错误码见 [API 文档](docs/prd/05_API.md)。

## 5. 常见问题

### 节点一直没有连接

依次检查：

1. `coordinatorUrl` 是否为 `ws://127.0.0.1:39472/node` 或实际 IP 地址。
2. dsh-node 的 token 是否与 UI「登记设置」完全一致。
3. Coordinator UI 中的登记规则是否已开启。
4. 节点是否已安装并加载到 DSH profile。

### API 返回 401

这是 `operator-token` 错误或没有携带 Bearer token。它与 dsh-node 使用的
`node-token` 不是同一个值。

### API 返回 403

通常是从非本机访问了没有配置远程管理 token 的 Coordinator。为远程调用设置
`--api-token`，并在请求中携带 Bearer token。

### 如何修改 token

- 修改全局 `node-token`：在 UI「登记设置」中更换，并同步更新 dsh-node 配置。
- 修改 `operator-token`：在 UI「运营端 token」中更换，之后 API 使用新 token。
- 状态文件默认是当前工作目录下的 `coordinator-state.json`，必须当作凭据文件保护。

## 6. 开发与验证

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run
pnpm --config.verify-deps-before-run=false --config.confirmModulesPurge=false run build
```

项目目录：

```text
src/       TypeScript 源码
ui/        内置管理 UI
test/      自动化测试
lib/       构建产物
docs/      设计方案、API 文档和实测记录
```
