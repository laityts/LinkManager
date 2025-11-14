Link Manager - Cloudflare Workers

一个基于 Cloudflare Workers 的链接管理服务，提供订阅链接展示、访问统计、Telegram 通知等功能。

✨ 功能特性

🎯 核心功能

· 订阅链接管理 - 展示和复制订阅链接
· 实时状态监控 - 自动检查链接可用性
· 智能统计 - 记录页面访问、独立访客、复制点击等数据
· Telegram 集成 - 状态通知和定时报告
· 管理面板 - 完整的 Web 管理界面

📊 统计功能

· 页面访问次数统计
· 独立访客计数（基于 IP）
· 复制点击次数
· Telegram 点击次数
· IP 访问日志（含地理位置信息）

🔔 通知功能

· 链接状态变化通知
· 每日统计报告
· 手动测试通知
· 支持 HTML 格式消息

⚙️ 管理功能

· 密码保护的管理面板
· 实时配置更新
· 访问日志查看
· 忽略特定 IP 统计

🚀 快速部署

1. 创建 Cloudflare Worker

1. 登录 Cloudflare 控制台
2. 进入 "Workers & Pages" 页面
3. 点击 "Create application"
4. 选择 "Create Worker"
5. 将提供的 worker.js 代码粘贴到编辑器中

2. 配置 KV 命名空间

1. 在 Workers 页面，进入 "KV" 部分
2. 点击 "Create namespace"
3. 输入名称：LINK_MANAGER_KV
4. 复制命名空间 ID

3. 绑定 KV 到 Worker

1. 在 Worker 编辑页面，点击 "Settings"
2. 选择 "Variables" 标签
3. 在 "KV Namespace Bindings" 部分点击 "Add binding"
4. 填写：
   · Variable name: LINK_MANAGER_KV
   · KV namespace: 选择刚才创建的命名空间

4. 配置定时任务（Cron Trigger）

1. 在 Worker 编辑页面，点击 "Triggers" 标签
2. 在 "Cron Triggers" 部分点击 "Add cron trigger"
3. 添加以下 Cron 表达式：
   · */5 * * * * - 每 5 分钟检查链接状态
   · 0 16 * * * - 每天 UTC 16:00（北京时间 00:00）重置统计

注意: Cloudflare Cron 使用 UTC 时间，北京时间 = UTC + 8

5. 初始设置

1. 访问 https://your-worker.your-subdomain.workers.dev/admin
2. 首次访问会显示初始设置页面
3. 设置管理员密码
4. 完成设置后自动跳转到管理面板

⚙️ 配置说明

基本配置

· 订阅链接 - 用户需要复制的订阅链接
· Telegram 群组链接 - 用户加入的群组链接

Telegram 通知配置

· Bot Token - 通过 @BotFather 创建的机器人 Token
· Chat ID - 接收通知的用户或群组 ID（可通过 @userinfobot 获取）

高级配置

· 忽略的 IP 地址 - 该 IP 的访问不会被记录在统计中（支持 IPv4/IPv6）

📡 API 接口

公共接口

· GET / - 主页面
· POST /api/stats - 记录统计事件
· GET /api/check-link - 检查链接状态

管理接口

· GET /admin - 管理面板
· POST /admin/api/setup - 初始设置
· POST /admin/api/login - 管理员登录
· POST /admin/api/update-config - 更新配置
· POST /admin/api/logout - 管理员登出
· POST /admin/api/test-telegram - 测试 Telegram 通知

🔧 定时任务

自动执行的任务

· 每 5 分钟: 检查订阅链接状态，状态变化时发送通知
· 每天 00:00（北京时间）:
  · 重置每日统计
  · 清空 IP 访问日志
  · 发送每日统计报告

定时报告内容

· 链接状态检查结果
· 统计重置情况
· 今日统计摘要（页面访问、独立访客、复制次数、TG 点击）

🎨 界面功能

主页面

· 美观的卡片式设计
· 实时链接状态显示
· 一键复制订阅链接
· 移动端优化布局

管理面板

· 实时统计数据显示
· 配置管理表单
· IP 访问日志查看
· Telegram 通知测试
· 响应式设计

🔒 安全特性

· 管理员密码保护
· HTTP-only Cookie 认证
· IP 忽略功能（避免自己访问影响统计）
· 安全的 KV 数据存储

📱 移动端优化

· 完全响应式设计
· 触摸友好的按钮尺寸
· 优化的间距和字体大小
· 流畅的交互动画

🛠️ 开发说明

技术栈

· Cloudflare Workers - 无服务器运行环境
· Cloudflare KV - 键值存储
· HTML/CSS/JavaScript - 前端界面
· Telegram Bot API - 通知服务

文件结构

```
worker.js
├── 路由处理
├── 定时任务
├── 工具函数
│   ├── 统计记录
│   ├── 链接检查
│   ├── Telegram 通知
│   └── 时间处理
└── 界面模板
    ├── 初始设置页面
    ├── 登录页面
    ├── 管理面板
    └── 主页面
```

📈 统计指标

每日统计

· 页面访问: 总访问次数
· 独立访客: 基于 IP 的去重访问者
· 复制次数: 订阅链接复制次数
· TG 点击: Telegram 群组链接点击次数

IP 日志

· 访问时间（北京时间）
· IP 地址
· 地理位置（国家、城市）
· 网络信息（ISP、ASN）

🔄 更新日志

v1.0 功能

· ✅ 基础链接管理
· ✅ 访问统计
· ✅ Telegram 通知
· ✅ 管理面板
· ✅ 定时任务
· ✅ 移动端优化

🆘 常见问题

Q: 如何获取 Telegram Chat ID？

A: 向 @userinfobot 发送消息即可获取您的 Chat ID。

Q: 定时任务不执行怎么办？

A: 检查 Cron Trigger 配置，确保使用了正确的 UTC 时间。

Q: 如何重置管理员密码？

A: 需要手动在 KV 中删除 admin_password 键值，然后重新进行初始设置。

Q: IPv6 地址支持吗？

A: 是的，完全支持 IPv4 和 IPv6 地址的识别和忽略。

📄 许可证

MIT License

---

提示: 部署完成后，建议立即访问 /admin 路径进行初始设置，并配置 Telegram 通知以便及时接收服务状态信息。