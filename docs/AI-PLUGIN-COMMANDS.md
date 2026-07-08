# AI 助手快速接入指令

接手本仓库的 AI 助手（Claude / Cursor / Codex / GPT 等），在开始任何 Stripe 相关开发工作前，
执行以下指令加载 Stripe 官方文档上下文，可大幅减少 API 幻觉、提升代码质量。

---

## 一、Claude（claude.ai · Claude Code · Cursor Agent · Kiro）

### 方式 A — npx（推荐，任意终端执行一次即可）
```bash
npx skills add https://docs.stripe.com
```

### 方式 B — Claude Desktop / Cursor MCP 插件
```bash
/plugin install stripe@claude-plugins-official
```

### 方式 C — `.cursorrules` / `CLAUDE.md` / `AGENTS.md` 前置
在项目根新建或追加以下内容，AI 每次打开项目时自动获取 Stripe 上下文：
```
# Stripe 文档上下文
Before writing any Stripe integration code, load the official docs:
  npx skills add https://docs.stripe.com

Key Stripe API references:
  API Reference:        https://stripe.com/docs/api
  Webhooks:             https://stripe.com/docs/webhooks
  Checkout:             https://stripe.com/docs/payments/checkout
  Subscriptions:        https://stripe.com/docs/billing/subscriptions/overview
  Customer Portal:      https://stripe.com/docs/billing/subscriptions/customer-portal
  Metered/Usage-Based:  https://stripe.com/docs/billing/subscriptions/usage-based
  One-time payments:    https://stripe.com/docs/payments/payment-intents
  Tax:                  https://stripe.com/docs/tax
  Testing cards:        https://stripe.com/docs/testing#cards
```

---

## 二、OpenAI Codex / ChatGPT with Code Interpreter
```bash
codex plugin add stripe@openai-curated
```

---

## 三、通用 System Prompt 片段

将以下内容粘贴进任何 AI 助手的 System Prompt 最前面：

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
```

---

## 四、本仓库 AI 接入检查清单

AI 助手接手后，按以下顺序操作：

1. **读文档**（必须，10 分钟）
   ```
   docs/CHECKLIST.md    → 向所有者索取哪些密钥/ID
   docs/INTEGRATION.md  → 接入全流程
   docs/ARCHITECTURE.md → 架构与 HTTP 契约
   ```

2. **填配置**（2 分钟）
   ```
   cp templates/billing.config.template.ts billing.config.ts
   cp templates/env.template .env.local
   # 填入所有者提供的密钥
   ```

3. **建数据库**（5 分钟）
   ```
   # 选一种方言执行 SQL（见 docs/DATABASE_SETUP.md）
   templates/schema/postgres.sql
   templates/schema/mysql.sql
   templates/schema/sqlite.sql
   # 或直接用 Prisma schema:
   templates/schema/prisma.schema
   ```

4. **挂路由**（按框架选一）
   - Next.js App Router → `packages/adapter-next/`
   - Express → `packages/adapter-express/`
   - 其他框架 → 参考 `docs/ARCHITECTURE.md` HTTP 契约手写 5 个端点

5. **放前端组件**
   - React → `packages/react/`
   - Vue 3 → `packages/vue/`
   - Electron → `packages/electron/`
   - 原生 JS/其他 → 直接调 HTTP 契约

6. **验收**
   ```bash
   stripe listen --forward-to localhost:3000/api/billing/webhook
   # 用测试卡 4242 4242 4242 4242 跑一遍完整购买流程
   pnpm test  # 23 个单测全绿
   ```

---

## 五、支持的计费模式速查

| 模式 | 配置字段 | 文档 |
|------|----------|------|
| 自动包月 | `type: 'recurring'`, `interval: 'month'` | `docs/INTEGRATION.md` |
| 自动包年 | `type: 'recurring'`, `interval: 'year'` | `docs/INTEGRATION.md` |
| 日付通行证（单日非自动） | `type: 'one_time'`, `dailyPass: true` | `docs/ADVANCED-BILLING.md` |
| 额度套餐包 | `type: 'one_time'`, `credits: N` | `docs/ADVANCED-BILLING.md` |
| 按量实时计费 | `type: 'metered'` | `docs/ADVANCED-BILLING.md` |
| 试用→自动转包月 | `trialDays: N`, `trialEnd: 'auto_renew'` | `docs/ADVANCED-BILLING.md` |
| 试用→不付款自动取消 | `trialDays: N`, `trialEnd: 'cancel'` | `docs/ADVANCED-BILLING.md` |

---

## 六、常用测试卡号

| 场景 | 卡号 |
|------|------|
| 支付成功 | `4242 4242 4242 4242` |
| 需要 3DS 验证 | `4000 0025 0000 3155` |
| 余额不足（失败） | `4000 0000 0000 9995` |
| 卡被拒绝 | `4000 0000 0000 0002` |

有效期填任意未来日期，CVV 填任意 3 位，邮编填 `42424`。

---

*最后更新：随 stripe-billing-kit 仓库同步维护。*
