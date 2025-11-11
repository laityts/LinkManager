🔗 Link Manager - Cloudflare Workers

一个现代化、功能丰富的链接管理与状态监控系统，基于 Cloudflare Workers 构建，为订阅服务提供完整的展示、监控和统计解决方案。

https://img.shields.io/badge/Cloudflare-Workers-orange?style=for-the-badge&logo=cloudflare
https://img.shields.io/badge/Version-2.0-blue?style=for-the-badge
https://img.shields.io/badge/License-MIT-green?style=for-the-badge

✨ 核心特性

🎯 主要功能

功能 描述 状态
订阅链接管理 安全展示和复制订阅链接 ✅ 稳定
实时状态监控 自动检测链接可用性 ✅ 稳定
智能访问统计 详细的用户行为分析 ✅ 稳定
Telegram 通知 异常状态自动告警 ✅ 稳定
管理面板 完整的后台管理系统 ✅ 稳定

📊 统计维度

· 页面访问量 - 主页访问次数统计
· 独立访客数 - 基于 IP 地址的去重统计
· 用户行为 - 复制操作和 Telegram 点击
· 访问日志 - 详细的 IP 访问记录
· 实时状态 - 链接健康状态监控

🔔 智能通知

· 自动检测 - 每 5 分钟检查链接状态
· 状态告警 - 异常时立即发送通知
· 恢复通知 - 服务恢复时发送确认
· 测试功能 - 支持手动测试通知

🚀 快速部署

环境要求

· ✅ Cloudflare 账户
· ✅ Workers 权限
· ✅ KV 命名空间

部署步骤

1. 创建 KV 命名空间

```bash
wrangler kv:namespace create "LINK_MANAGER_KV"
```

1. 配置项目

```toml
# wrangler.toml
name = "link-manager"
main = "worker.js"
compatibility_date = "2024-03-20"

[[kv_namespaces]]
binding = "LINK_MANAGER_KV"
id = "your_kv_namespace_id"

[triggers]
crons = ["*/5 * * * *", "0 16 * * *"]
```

1. 部署到 Cloudflare

```bash
# 安装依赖（如有）
npm install

# 部署
wrangler deploy
```

1. 初始设置
   访问管理面板完成初始化：

```
https://your-worker.your-subdomain.workers.dev/admin
```

⚙️ 配置指南

🔧 基本配置项

配置项 说明 示例
SUBSCRIPTION_URL 订阅服务链接 https://api.example.com/subscribe
TELEGRAM_GROUP Telegram 群组链接 https://t.me/your_group

🤖 Telegram 通知配置

1. 创建 Bot
   · 联系 @BotFather
   · 使用 /newbot 命令创建机器人
   · 保存生成的 Bot Token
2. 获取 Chat ID
   · 联系 @userinfobot
   · 获取您的用户 ID 或群组 ID
3. 配置参数
   · TELEGRAM_BOT_TOKEN: 机器人 Token
   · TELEGRAM_CHAT_ID: 接收通知的 Chat ID

📊 统计配置

· 自动重置: 每日北京时间 00:00
· 数据保留: IP 日志保留 100 条
· 去重统计: 基于 IP 地址的独立访客

🎮 使用说明

👤 用户界面

用户访问主域名即可看到：

· ✅ 服务状态指示器
· 📋 一键复制订阅链接
· ✈️ Telegram 群组入口
· ⏰ 最后更新时间

👨‍💼 管理面板

访问 /admin 路径进入管理界面：

功能模块

1. 数据看板
   · 实时统计数据显示
   · 今日访问趋势
   · 系统状态监控
2. 配置管理
   · 链接配置更新
   · 通知设置
   · 系统参数调整
3. 访问日志
   · IP 访问记录查询
   · 用户行为分析
   · 实时监控数据

操作指南

```bash
# 访问管理面板
https://your-domain.com/admin

# 初始设置（首次访问）
1. 设置管理员密码
2. 配置订阅链接
3. 设置 Telegram 通知（可选）
4. 保存配置
```

🔌 API 接口文档

公共接口

端点 方法 描述 参数
/ GET 主页面 -
/api/check-link GET 检查链接状态 -
/api/stats POST 记录用户行为 {type: 'copy_clicks'}

管理接口

端点 方法 描述 认证
/admin GET 管理面板 ✅
/admin/api/login POST 管理员登录 ❌
/admin/api/update-config POST 更新配置 ✅
/admin/api/test-telegram POST 测试通知 ✅

⏰ 定时任务系统

自动监控任务

```cron
*/5 * * * *    # 每5分钟检查链接状态
```

数据维护任务

```cron
0 16 * * *     # 每日 UTC 16:00（北京时间00:00）重置统计
```

任务功能说明

1. 状态检查
   · 验证订阅链接可达性
   · 更新最后检查时间
   · 触发状态变更通知
2. 数据维护
   · 重置每日计数器
   · 清理过期数据
   · 更新统计日期

🛡️ 安全特性

认证安全

· 🔒 密码加密存储
· 🍪 HttpOnly Session Cookie
· 🛡️ CSRF 攻击防护
· ⏰ Session 安全管理

数据安全

· 📍 IP 访问记录
· 🔍 操作日志审计
· 🗑️ 数据自动清理
· 💾 安全的 KV 存储

访问控制

· 👁️ 管理面板访问限制
· 📊 统计接口权限控制
· 🔐 配置更新认证

📈 监控与统计

实时指标

指标 说明 更新频率
页面访问量 主页访问次数 实时
独立访客 去重访问人数 实时
用户行为 复制和点击统计 实时
链接状态 服务健康状态 5分钟

数据分析

· 📊 每日访问趋势
· 👥 用户行为分析
· 🔗 链接稳定性统计
· 📱 访问来源分析

🐛 故障排除

常见问题

1. 部署问题

问题: Worker 部署失败

```bash
# 解决方案
wrangler publish --new-class
```

2. 通知不工作

检查步骤:

1. 验证 Bot Token 格式
2. 确认 Chat ID 正确性
3. 测试通知功能
4. 检查网络连接

3. 统计异常

排查方法:

1. 确认 KV 存储权限
2. 检查定时任务状态
3. 验证时区设置
4. 查看 Worker 日志

日志查看

```bash
# 查看实时日志
wrangler tail

# 查看特定时间日志
wrangler tail --format=pretty
```

🔄 更新维护

版本更新

```bash
# 拉取最新代码
git pull origin main

# 重新部署
wrangler deploy
```

数据备份

```bash
# 导出 KV 数据
wrangler kv:key list --binding=LINK_MANAGER_KV
```

🎯 使用场景

适用场景

· 🔗 订阅服务提供商
· 📊 需要访问统计的链接服务
· 🔔 需要状态监控的 API 服务
· 👥 用户群体分析项目

典型案例

1. VPN 订阅服务
2. API 密钥分发
3. 私有服务访问
4. 会员专属内容

🤝 贡献指南

我们欢迎社区贡献！请遵循以下流程：

1. Fork 项目
2. 创建功能分支 (git checkout -b feature/AmazingFeature)
3. 提交更改 (git commit -m 'Add some AmazingFeature')
4. 推送到分支 (git push origin feature/AmazingFeature)
5. 开启 Pull Request

📄 许可证

本项目采用 MIT 许可证 - 查看 LICENSE 文件了解详情。

🆘 获取帮助

· 📚 Cloudflare Workers 文档
· 💬 创建 Issue
· 🐛 报告 Bug
· 💡 功能请求

---

Powered by Cloudflare Workers • Built with ❤️ for the community

---

最后更新: 2024年3月20日
版本: v2.0