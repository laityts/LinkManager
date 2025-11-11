Link Manager - Cloudflare Worker

一个功能完整的链接管理与状态监控系统，基于 Cloudflare Workers 构建，提供实时状态检测、访问统计和智能通知功能。

✨ 核心功能

🔗 链接管理

· 安全链接展示 - 优雅的订阅链接展示界面
· 一键复制 - 点击即可复制订阅链接到剪贴板
· 实时状态检测 - 自动监控链接可用性

📊 智能统计

· 访问统计 - 页面访问量、独立访客数
· 行为分析 - 复制点击、Telegram 点击统计
· IP 日志 - 详细的访问记录和地理位置信息
· 自动清零 - 每日自动重置统计数据

🔔 智能通知

· 状态监控 - 每 5 分钟自动检查链接状态
· 即时告警 - 链接异常时发送 Telegram 通知
· 状态恢复通知 - 服务恢复时自动发送通知
· 测试功能 - 支持测试通知配置

🛡️ 安全管理

· 密码保护 - 管理员密码加密存储
· 访问控制 - HttpOnly Cookie 认证机制
· 操作日志 - 完整的操作记录和 IP 追踪

🚀 快速部署

1. 创建 KV 命名空间

```bash
wrangler kv:namespace create "LINK_MANAGER_KV"
```

2. 配置 wrangler.toml

```toml
name = "link-manager"
main = "worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "LINK_MANAGER_KV"
id = "your_kv_namespace_id"

[triggers]
crons = ["*/5 * * * *", "0 16 * * *"]
```

3. 部署到 Cloudflare

```bash
wrangler deploy
```

⚙️ 初始配置

首次访问设置

1. 访问 https://your-worker.your-subdomain.workers.dev/admin
2. 设置管理员密码
3. 配置订阅链接和 Telegram 群组

必要配置项

· 订阅链接 - 需要管理的服务订阅地址
· Telegram 群组 - 用户交流群组链接
· Bot Token (可选) - Telegram 机器人令牌
· Chat ID (可选) - 通知接收聊天 ID

📡 API 接口

公共接口

端点 方法 描述
/ GET 主展示页面
/api/check-link GET 检查链接状态
/api/stats POST 记录用户行为

管理接口

端点 方法 描述
/admin GET 管理面板
/admin/api/login POST 管理员登录
/admin/api/update-config POST 更新配置
/admin/api/test-telegram POST 测试通知

🎯 使用指南

用户端使用

1. 访问主页 - 查看订阅链接状态
2. 复制链接 - 点击按钮一键复制订阅链接
3. 加入群组 - 通过 Telegram 按钮加入交流群

管理员使用

1. 登录管理面板 - 使用设置的管理密码登录
2. 查看统计数据 - 监控访问量和使用情况
3. 配置服务 - 更新订阅链接和通知设置
4. 测试功能 - 验证 Telegram 通知是否正常

⏰ 定时任务

自动状态检查

```cron
*/5 * * * *    # 每5分钟检查一次链接状态
```

每日统计重置

```cron
0 16 * * *     # 每天 UTC 16:00 (北京时间 00:00)
```

🔧 配置说明

Telegram 通知配置

1. 通过 @BotFather 创建 Telegram 机器人
2. 获取 Bot Token
3. 通过 @userinfobot 获取 Chat ID
4. 在管理面板中配置相关参数

统计配置

· 页面访问 - 主页访问次数统计
· 独立访客 - 基于 IP 地址的去重统计
· 操作统计 - 用户复制和点击行为记录
· 日志保留 - 最近 100 条 IP 访问日志

🛠️ 开发信息

技术架构

· 运行时：Cloudflare Workers
· 存储：Cloudflare KV
· 前端：原生 HTML/CSS/JavaScript
· 通知：Telegram Bot API

项目结构

```
worker.js
├── 路由处理 (fetch)
├── 定时任务 (scheduled)
├── 工具函数
│   ├── 状态检查
│   ├── 通知发送
│   └── 统计记录
├── 管理功能
│   ├── 认证系统
│   ├── 配置管理
│   └── 数据统计
└── 前端界面
    ├── 用户主页
    ├── 登录页面
    └── 管理面板
```

🐛 故障排除

常见问题

1. 通知无法发送

· 检查 Bot Token 和 Chat ID 是否正确
· 确认机器人已加入对应聊天
· 验证网络连接是否正常

2. 统计数据显示异常

· 检查 KV 存储权限
· 确认定时任务正常执行
· 查看 Workers 日志输出

3. 链接状态检测失败

· 验证订阅链接可访问性
· 检查网络超时设置
· 确认 CORS 配置正确

日志查看

通过 Cloudflare Workers 控制台查看实时日志和错误信息。

📈 监控指标

性能指标

· 链接状态检查成功率
· 通知发送延迟
· 页面加载时间

业务指标

· 日活跃用户数
· 用户操作转化率
· 服务可用性百分比

🔒 安全考虑

数据保护

· 管理员密码加密存储
· 敏感配置信息隔离
· 访问日志匿名化处理

访问安全

· 管理接口身份验证
· 操作行为审计追踪
· IP 地址访问限制

📄 许可证

MIT License - 详见 LICENSE 文件

---

技术支持：如遇问题，请通过 Telegram 群组或提交 Issue 获取帮助。

版本更新：定期检查更新以获取新功能和安全补丁。

---

Powered by Cloudflare Workers