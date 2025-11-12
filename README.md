# LinkManager - Cloudflare Workers 订阅链接管理面板

一个功能完整、开箱即用的 **Cloudflare Workers + KV** 订阅链接管理项目，专为机场主/个人用户设计。

支持 **访问统计、访问人数、IP日志（带国家城市）、自动链接状态检测、失效自动 Telegram 通知**，并提供美观的管理后台。

## 功能亮点

- **一键复制订阅链接** + 实时状态检测
- **每日访问统计**（页面访问、复制次数、TG点击、访问人数）
- **IP访问日志**（最近100条，自动记录国家、城市、地区）
- **自动链接健康检查**（每5分钟一次）
- **链接失效/恢复自动推送 Telegram 通知**
- **完整管理后台**（初始设置 → 登录 → 配置 → 测试通知 → 查看日志）
- **每日0点（北京时间）自动重置统计**
- **零服务器成本**，完全运行在 Cloudflare Workers + KV

## 在线演示

> 您可以 fork 本项目后直接部署，5分钟拥有自己的订阅管理页

## 部署步骤

### 1. 创建 Cloudflare Workers + KV

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Workers & Pages → Overview → Create application → Workers → 从模板创建 → 选择 **"Workers KV"** 模板
3. 项目名称随意（例如 `link-manager`）
4. 点击 **Deploy** 部署空项目

### 2. 绑定 KV 命名空间

1. 在 Workers 页面 → Settings → Variables → KV Namespace Bindings
2. 点击 **Add binding**
   - Variable name: `LINK_MANAGER_KV`（**必须一致**）
   - KV namespace: 点击 **Create namespace** 创建一个，例如 `LinkManagerKV`
3. 保存

### 3. 替换代码

1. 点击 **Edit code**
2. 删除全部内容，**粘贴本项目完整代码**（`worker.js`）
3. 点击 **Save and deploy**

### 4. 配置 Cron 触发器（自动检查 + 每日重置）

1. Settings → Triggers → Add Cron Trigger
2. 添加两条规则：

```text
*/5 * * * *    ← 每5分钟检查链接状态
0 16 * * *     ← 每天 UTC 16:00 = 北京时间 00:00 重置统计