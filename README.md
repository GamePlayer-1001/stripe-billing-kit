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

- **动态商品目录**:前端零硬编码,Stripe 改价后自动跟随(lookup_key + webhook 缓存失效)
- **双支付形态**:订阅 + 一次性买断,业务侧统一 `hasAccess()` 权益模型
- **Webhook 一次做对**:验签、`event.id` 幂等、单一 `syncStripeToDb()` 状态同步
- **框架无关**:core 零依赖,Next.js / Express 适配器 ≤ 100 行,HTTP 契约支持任意前端
- **订阅管理零开发**:升降级/取消/换卡直接用 Stripe Customer Portal

## 仓库结构

```
docs/          五份文档(PRD / 架构 / AI 接入 / Stripe 后台手册 / 信息采集清单)
packages/
  core/             @billing-kit/core     框架无关核心(catalog/checkout/webhook/entitlements/sync/portal)
  adapter-next/     @billing-kit/next     Next.js App Router 适配器
  adapter-express/  @billing-kit/express  Express 适配器
  react/            @billing-kit/react    React hooks + headless 组件
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

## 技术基线

TypeScript 5.x · Node.js ≥ 20 · stripe-node v22(API `2026-06-24.dahlia`)· pnpm monorepo
