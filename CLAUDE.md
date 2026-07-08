# stripe-billing-kit — Claude / Cursor / Kiro AI 接入指南

接手本仓库的 AI 助手（Claude / Claude Code / Cursor / Kiro），**开始任何 Stripe 代码工作前先执行以下指令加载官方文档上下文**，可大幅减少 API 幻觉、提升代码质量。

## 第一步：加载 Stripe 文档（必须）

```bash
# 方式 A — npx（推荐，任意终端执行一次）
npx skills add https://docs.stripe.com

# 方式 B — Claude Desktop / Cursor MCP 插件
/plugin install stripe@claude-plugins-official

# 方式 C — OpenAI Codex
codex plugin add stripe@openai-curated
```

## 第二步：了解本项目

本项目是**框架无关、随拿随用的 Stripe 支付接入套件**。核心原则：
- 所有者在 Stripe 后台配置好商品与密钥
- 产品开发 AI 按内置文档**半天内完成前后端接入**
- 价格与套餐由 Stripe 数据驱动，**改价永不发版**

### 项目结构速览

```
packages/
  core/               # 框架无关核心逻辑（TypeScript）
  adapter-next/       # Next.js App Router 适配器
  adapter-express/    # Express 适配器
  react/              # React 组件 + Hooks
  vue/                # Vue 3 组件 + Composables
  electron/           # Electron 桌面应用集成
docs/
  CHECKLIST.md        # 向所有者索取哪些密钥/ID（先读这个）
  INTEGRATION.md      # 接入全流程（主文档）
  ARCHITECTURE.md     # 架构与 HTTP 契约
  ADVANCED-BILLING.md # 7 种计费模式详解
  DATABASE_SETUP.md   # 数据库建表
  STRIPE-SETUP.md     # Stripe 后台配置步骤
templates/
  billing.config.template.ts  # 配置文件模板
  env.template                # 环境变量模板
  schema/                     # 数据库 schema（postgres/mysql/sqlite/prisma）
```

### 支持的 8 种计费模式

| 模式 | PlanType | 说明 |
|------|----------|------|
| 自动包月 | `subscription` + `interval: month` | 持续订阅，自动续费 |
| 自动包年 | `subscription` + `interval: year` | 持续订阅，自动续费 |
| 单日通行证 | `daily` | 一次性单日，非自动续费 |
| 额度套餐包 | `credit_package` | 一次购买 N 点，消耗完再买 |
| 按量实时计费 | `metered` | Stripe Meter，月底汇总出账 |
| 试用→自动转包月 | `trial_then_subscribe` | 试用期须绑卡，到期自动扣款 |
| 试用→不续费取消 | `trial_no_convert` | 试用期无需绑卡，到期即止 |
| 单次试用套餐 | `first_trial` | 只能订阅一次，订阅后不再显示 |

## 第三步：接入流程（按顺序执行）

### 1. 索取密钥（读 docs/CHECKLIST.md）

所有者需要提供：
- `STRIPE_SECRET_KEY` = `sk_live_...` 或 `sk_test_...`
- `STRIPE_PUBLISHABLE_KEY` = `pk_live_...` 或 `pk_test_...`
- `STRIPE_WEBHOOK_SECRET` = `whsec_...`
- 各套餐的 `PRICE_ID` 或 `lookup_key`

### 2. 复制配置模板

```bash
cp templates/billing.config.template.ts billing.config.ts
cp templates/env.template .env.local
# 填入所有者提供的密钥
```

### 3. 建数据库

```bash
# 按数据库类型选一个执行
psql -U user -d dbname -f templates/schema/postgres.sql
mysql -u user -p dbname < templates/schema/mysql.sql
sqlite3 app.db < templates/schema/sqlite.sql
# 或用 Prisma：
npx prisma db push --schema=templates/schema/billing.prisma
```

### 4. 挂路由（按框架选一）

**Next.js App Router：**
```ts
// app/api/billing/[action]/route.ts
export { GET, POST } from '@billing-kit/adapter-next';
```

**Express：**
```ts
import { createExpressBillingRouter } from '@billing-kit/adapter-express';
app.use('/api/billing', createExpressBillingRouter(billingConfig, { resolveUser }));
```

### 5. 放前端组件

**React：**
```tsx
import { PricingTable, CheckoutButton, useBilling } from '@billing-kit/react';
<PricingTable config={billingConfig} onSelect={(plan) => checkout(plan.key)} />
```

**Vue 3：**
```vue
<script setup>
import { PricingTable, CheckoutButton } from '@billing-kit/vue';
</script>
<template>
  <PricingTable :config="billingConfig" @select="checkout" />
</template>
```

### 6. 验收测试

```bash
# 启动 Stripe webhook 转发
stripe listen --forward-to localhost:3000/api/billing/webhook

# 用测试卡跑完整购买流程
# 支付成功：4242 4242 4242 4242
# 需要3DS：4000 0025 0000 3155
# 余额不足：4000 0000 0000 9995

# 跑所有单元测试
pnpm test
```

## 核心编码规则（AI 必须遵守）

```
You are working on a Stripe billing integration project.
Official docs base: https://stripe.com/docs
Always use stripe-node SDK (npm: stripe). Current recommended version: ^17.x
Always verify API shapes at https://stripe.com/docs/api before implementing.

Key patterns in this project:
- BillingConfig drives all SDK calls (see packages/core/src/config.ts)
- Never hardcode price IDs; use lookup_key via getCatalog()
- Webhook handler must verify signature + deduplicate by event.id
- syncStripeToDb() is the single source of truth for DB state
- All 7 plan types are handled in packages/core/src/checkout.ts
- planKey is the only thing the frontend passes; server resolves to priceId
```

## Stripe 关键文档直链

| 主题 | 地址 |
|------|------|
| API Reference | https://stripe.com/docs/api |
| Webhooks | https://stripe.com/docs/webhooks |
| Checkout | https://stripe.com/docs/payments/checkout |
| Subscriptions | https://stripe.com/docs/billing/subscriptions/overview |
| Customer Portal | https://stripe.com/docs/billing/subscriptions/customer-portal |
| Metered/Usage-Based | https://stripe.com/docs/billing/subscriptions/usage-based |
| One-time payments | https://stripe.com/docs/payments/payment-intents |
| Testing cards | https://stripe.com/docs/testing#cards |

---
*本文件由 stripe-billing-kit 维护，随仓库同步更新。*
