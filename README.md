# Stripe Billing Kit

一套**框架无关、随拿随用**的 Stripe 支付接入套件。所有者在 Stripe 后台配置好商品与密钥,产品开发 AI 按内置文档半天内完成前后端接入;价格与套餐由 Stripe 数据驱动,**改价永不发版**。

仓库:https://github.com/GamePlayer-1001/stripe-billing-kit

## 你是谁?从这里开始

| 你是 | 读这份 |
|---|---|
| **所有者**(配置 Stripe、提供密钥) | [`docs/STRIPE-SETUP.md`](docs/STRIPE-SETUP.md) — 后台操作手册 |
| **所有者 + AI 双方**(交接时对表) | [`docs/CHECKLIST.md`](docs/CHECKLIST.md) — **信息采集总清单 + 交接卡 v2 模板**(要从 Stripe 拿什么、在哪拿、缺了会怎样) |
| **产品开发 AI**(为新产品接支付) | [`docs/INTEGRATION.md`](docs/INTEGRATION.md) — 唯一接入手册,按序执行即可 |
| **套件开发者 / 架构师**(实现或扩展本套件) | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 架构、HTTP 契约、数据模型 |
| **想了解为什么这么设计** | [`docs/PRD.md`](docs/PRD.md) — 需求、决策与里程碑 |

## 核心特性

- **动态商品目录**：前端零硬编码，Stripe 改价后自动跟随（lookup_key + webhook 缓存失效）
- **双支付形态**：订阅 + 一次性买断，业务侧统一 `hasAccess()` 权益模型
- **Webhook 一次做对**：验签、`event.id` 幂等、单一 `syncStripeToDb()` 状态同步
- **框架无关**：core 零依赖，Next.js / Express 适配器 ≤ 100 行，HTTP 契约支持任意前端
- **前端技术栈无关**：React hooks（`@billing-kit/react`）、Vue 3 Composables（`@billing-kit/vue`）、Electron 桌面应用（`@billing-kit/electron`），或任意前端直接调 HTTP 契约
- **订阅管理零开发**：升降级/取消/换卡直接用 Stripe Customer Portal

## 价格同步机制

**混合保障 — 后端缓存 + Webhook 失效 + 前端定时轮询**：

### 后端缓存层
1. **首次加载**：前端请求 `GET /catalog` → 后端从 Stripe 拉取价格 → 缓存 10 分钟（默认 `catalogTtlSeconds: 600`）
2. **缓存命中**：所有请求直接返回内存缓存，不回源 Stripe（减少 API 调用）
3. **Stripe 价格变动**：Stripe 发送 webhook（`price.created/updated` 或 `product.updated`）→ 后端 `invalidateCatalogCache()` 立即清空缓存
4. **下次请求**：缓存已失效，重新从 Stripe 拉取最新价格

### 前端轮询层（兜底保障）
- `usePlans()` hook 默认每 5 分钟（`refetchInterval: 300000`）自动重新请求 `/catalog`
- 防止 Webhook 丢失或延迟时价格长期不更新
- Stripe 价格变动后，前端最多 5 分钟内自动更新（无需用户刷新页面）
- 可通过 `<BillingProvider refetchInterval={60000}>` 自定义轮询间隔，设为 `0` 禁用轮询

**结果**：用户在产品页面上看到的价格会自动跟随 Stripe 后台配置变化，改价后最多 5 分钟生效（Webhook 正常时近实时，失败时轮询兜底）。

## 仓库结构

```
docs/          五份文档(PRD / 架构 / AI 接入 / Stripe 后台手册 / 信息采集清单)
packages/
  core/             @billing-kit/core     框架无关核心(catalog/checkout/webhook/entitlements/sync/portal)
  adapter-next/     @billing-kit/next     Next.js App Router 适配器
  adapter-express/  @billing-kit/express  Express 适配器
  react/            @billing-kit/react    React hooks + headless 组件
  vue/              @billing-kit/vue      Vue 3 Composables + 类型
  electron/         @billing-kit/electron Electron 主进程适配器(自定义协议 + 浏览器跳转)
templates/     billing.config 模板 · env 模板 · 建表 SQL / Prisma schema
```

构建与测试:`pnpm install && pnpm build && pnpm test`(23 个单测覆盖配置校验、目录缓存、幂等、权益派生、HTTP 契约)。

## 新产品接入流程(全景)

```
所有者(20 min)                          产品开发 AI(2~4 h)
─────────────                           ──────────────
Stripe 建 account/sandbox               读 docs/INTEGRATION.md
建 Product + Price(设 lookup_key)  →   装包 → 填 billing.config.ts → 配环境变量
配 webhook endpoint                     挂 5 个标准路由 + 建 4 张表
发「交接卡」(三把钥匙+套餐表)          前端放组件(或按 HTTP 契约自渲染)
                                        跑验收清单(stripe CLI + 测试卡)→ 完成
```

## 快速启动

```bash
# 安装依赖
pnpm install

# 构建所有包
pnpm build

# 并行启动开发模式（自动 watch）
pnpm dev

# 运行测试
pnpm test
```

## 额外文档

| 文档 | 用途 |
|------|------|
| [`docs/DATABASE_SETUP.md`](docs/DATABASE_SETUP.md) | **数据库建表指引** - PostgreSQL/MySQL/SQLite 三种方言的完整 SQL，AI 可直接执行 |
| [`docs/GUI_INTEGRATION.md`](docs/GUI_INTEGRATION.md) | **GUI 应用集成** - Electron/Tauri/React Native/Flutter 接入协议与代码示例 |

## 技术基线

TypeScript 5.x · Node.js ≥ 20 · stripe-node v22（API `2026-06-24.dahlia`）· pnpm monorepo  
前端：React ≥ 18 / Vue ≥ 3.3 / Electron ≥ 28（可选，按需接入）
