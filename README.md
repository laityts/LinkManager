# LinkManager - Cloudflare Workers 订阅链接管理面板

一个轻量、现代、响应式的 **订阅链接管理平台**，专为 Cloudflare Workers + KV 设计。支持实时状态检测、访问统计、IP日志、Telegram 通知、忽略IP、每日自动重置等功能。

> 无需数据库、无需后端服务器、纯 Workers + KV 实现，部署即用！

---

## ✨ 特性一览

| 功能 | 描述 |
|------|------|
| **订阅链接状态检测** | 自动每5分钟检测订阅链接是否可达 |
| **实时状态显示** | 主页显示「正常 / 异常 / 检查中」状态 |
| **访问统计面板** | 页面访问、独立访客、复制次数、TG点击 |
| **IP访问日志** | 记录国家、城市、ISP、ASN（支持 IPv6） |
| **忽略指定IP** | 防止自己或爬虫污染统计数据 |
| **Telegram 通知** | 链接异常/恢复、定时报告、测试通知 |
| **每日统计重置** | 北京时间 00:00 自动重置 + 保留昨日摘要 |
| **安全管理面板** | 初始设置 → 登录 → 配置管理 |
| **响应式设计** | 完美适配手机、平板、桌面 |
| **零配置部署** | 仅需绑定一个 KV 即可运行 |

---

## 🚀 部署步骤

### 1. 创建 KV 命名空间

```bash
# 创建 KV
npx wrangler kv:namespace create "LINK_MANAGER_KV"

# 预览环境（可选）
npx wrangler kv:namespace create "LINK_MANAGER_KV" --preview
```

> 记录输出的 `id`，后面会用到。

---

### 2. 部署 Worker

```bash
npx wrangler deploy
```

> 部署完成后会返回你的 Worker 域名，例如：`https://link-manager.yourname.workers.dev`

---

### 3. 绑定 KV 到 Worker

编辑 `wrangler.toml`（**本项目不需要，但建议保留用于本地开发**）：

```toml
name = "link-manager"
main = "index.js"
compatibility_date = "2025-11-14"

[[kv_namespaces]]
binding = "LINK_MANAGER_KV"
id = "your-kv-namespace-id-here"  # 替换为第1步的ID
```

> **注意**：不需要 wrangler.toml，可以直接在 Cloudflare 控制台绑定：
>
> **Workers → 你的 Worker → Settings → Variables → KV Namespace Bindings**
>
> 添加：
> - Variable name: `LINK_MANAGER_KV`
> - KV namespace: 选择你创建的命名空间

---

### 4. 设置定时任务（Cron Triggers）

进入 Cloudflare 控制台：

**Workers → 你的 Worker → Triggers → Add Cron Trigger**

添加以下定时任务：

```cron
*/5 * * * *    # 每5分钟执行一次（检查链接 + 发送报告）
0 0 * * *     # 每天00:00（北京时间）触发统计重置（冗余保险）
```

> 代码中已包含 `0 0 * * *` 的判断，建议至少保留 `*/5 * * * *`

---

## ⚙️ 首次使用流程

1. 打开你的 Worker 域名：`https://your-worker.workers.dev`
2. 进入 **初始设置页面**
3. 设置 **管理密码**
4. 跳转到 `/admin` → 登录
5. 配置：
   - 订阅链接（如 Clash/V2Ray 订阅）
   - Telegram 群组链接
   - Telegram Bot Token + Chat ID
   - 忽略IP（可选，推荐填自己的公网IP）

---

## 🔧 配置说明

| 配置项 | 说明 |
|-------|------|
| **订阅链接** | 你的节点订阅地址 |
| **Telegram 群组** | 显示在主页按钮 |
| **Bot Token** | 通过 [@BotFather](https://t.me/BotFather) 创建 |
| **Chat ID** | 个人用 [@userinfobot](https://t.me/userinfobot)，群组用 `-100xxxxxxxxxx` |
| **忽略IP** | 填你的出口IP，访问不计入统计（支持 IPv4/IPv6） |

---

## 📊 统计与日志

- **每日0点（北京时间）自动重置**
- **昨日数据会通过 Telegram 发送摘要**
- **IP日志保留最近100条**
- **支持 IPv6 完整识别与忽略**

---

## 🛠️ API 接口

| 路径 | 方法 | 功能 |
|------|------|------|
| `/api/stats` | GET | 获取当前统计 |
| `/api/stats` | POST `{ "type": "copy_clicks" }` | 记录复制 |
| `/api/stats` | POST `{ "type": "telegram_clicks" }` | 记录TG点击 |
| `/api/check-link` | GET | 检查订阅链接状态 |
| `/admin/api/test-telegram` | POST | 测试Telegram通知 |

---

### 管理面板
- 实时统计卡片
- 配置表单
- IP访问日志（支持滚动）
- 一键测试通知

---

## 🔒 安全说明

- 密码明文存储于 KV（建议强密码）
- 使用 `HttpOnly` Cookie 防止 XSS
- 所有敏感操作需登录
- 支持 `ignored_ip` 防止刷量

---

## 🙋 常见问题

### Q：为什么状态显示「检查中」？
> A：首次加载会请求 `/api/check-link`，30秒后自动刷新。

### Q：Telegram 收不到通知？
> A：检查：
> - Bot Token 是否正确
> - Chat ID 是否正确（群组需以 `-100` 开头）
> - 是否已向 Bot 发送过消息（私聊需先打招呼）

### Q：如何查看忽略的IP是否生效？
> A：在管理面板「今日统计」中查看「忽略IP设置」状态。

---

## 🎁 致谢

- Powered by [Cloudflare Workers](https://workers.cloudflare.com/)
- UI 设计灵感来自现代 SaaS 仪表盘
- 图标来自 SVG

---

## 📄 许可证

MIT License © 2025

---

**一键部署，轻松管理你的订阅链接！**

> 部署完成后，访问你的域名 → 设置密码 → 开始使用！