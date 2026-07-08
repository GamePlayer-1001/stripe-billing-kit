# stripe-billing-kit — OpenAI Codex / GPT Agents 接入指南

接手本仓库的 AI Agent（OpenAI Codex / GPT with code tools），**开始任何 Stripe 代码工作前先执行以下指令**。

## 加载 Stripe 文档上下文（必须）

```bash
# OpenAI Codex 插件
codex plugin add stripe@openai-curated

# 通用 npx 方式（任何环境）
npx skills add https://docs.stripe.com
```

## 项目简介

**stripe-billing-kit** 是一套框架无关、随拿随用的 Stripe 支付接入套件：
- 所有者在 Stripe 后台配置好商品与密钥
- AI 按内置文档**半天内完成前后端接入**
- 价格与套餐由 Stripe 数据驱动，**改价永不发版**

## 支持的 8 种计费模式

| PlanType | 说明 |
|----------|------|
| `subscription` | 自动包月 / 自动包年 |
| `daily` | 单日通行证（非自动续费） |
| `credit_package` | 额度套餐包（买 N 点消耗完再买） |
| `metered` | 按量实时计费（Stripe Meter，月底出账） |
| `trial_then_subscribe` | 试用期须绑卡，到期自动转包月 |
| `trial_no_convert` | 试用期无需绑卡，到期即止 |
| `one_time` | 买断 / 终身 |
| `first_trial` | 单次试用套餐（只能订阅一次，订阅后不再显示） |

## 接入检查清单

1. 读 `docs/CHECKLIST.md` — 向所有者索取密钥清单
2. `cp templates/billing.config.template.ts billing.config.ts` 并填入密钥
3. `cp templates/env.template .env.local` 并填入环境变量
4. 按数据库类型执行 `templates/schema/` 下对应 SQL
5. 挂路由：Next.js → `packages/adapter-next/`，Express → `packages/adapter-express/`
6. 放前端组件：React → `packages/react/`，Vue 3 → `packages/vue/`
7. `stripe listen --forward-to localhost:3000/api/billing/webhook` 启动 webhook 转发
8. 用测试卡 `4242 4242 4242 4242` 跑完整购买流程
9. `pnpm test` 全绿

## 核心编码规则

```
Always use stripe-node SDK (npm: stripe), version ^17.x
Never hardcode price IDs — use lookup_key via getCatalog()
Webhook handler must verify signature + deduplicate by event.id
syncStripeToDb() is the single source of truth for DB state
BillingConfig drives all SDK calls (packages/core/src/config.ts)
planKey is the only thing frontend passes; server resolves to priceId
```

## 关键文档

- 全流程接入：`docs/INTEGRATION.md`
- 架构与 HTTP 契约：`docs/ARCHITECTURE.md`
- 高级计费模式：`docs/ADVANCED-BILLING.md`
- Stripe 官方 API：https://stripe.com/docs/api
- Webhook 事件：https://stripe.com/docs/webhooks
- 测试卡号：https://stripe.com/docs/testing#cards
