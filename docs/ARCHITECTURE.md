# ARCHITECTURE · Stripe Billing Kit 架构与接口设计

> 读者:实现本套件的架构师 / 开发 AI。
> 配套:需求见 `PRD.md`;产品接入视角见 `INTEGRATION.md`;Stripe 后台操作见 `STRIPE-SETUP.md`。
> 技术基线:TypeScript 5.x · Node.js ≥ 20 · stripe-node v22(API `2026-06-24.dahlia`)

---

## 1. 总体架构

```
┌────────────────────────── 产品(每个新产品一份)──────────────────────────┐
│                                                                          │
│  前端(任意框架)                    后端(任意框架)                      │
│  ┌──────────────────┐   HTTP 契约   ┌─────────────────────────────┐      │
│  │ @billing-kit/react│ ───────────▶ │ adapter(next/express/…)    │      │
│  │ 或自行 fetch      │              │   └─▶ @billing-kit/core     │      │
│  └──────────────────┘              │         ├─ catalog           │      │
│                                    │         ├─ checkout          │      │
│         billing.config.ts ────────▶│         ├─ webhooks          │      │
│         (planKey ↔ lookup_key)     │         ├─ entitlements      │      │
│                                    │         └─ portal            │      │
│                                    └──────┬───────────┬───────────┘      │
│                                           │           │                  │
│                                    StorageAdapter   stripe-node          │
│                                    (pg / prisma)        │                │
└───────────────────────────────────────────┼───────────┼──────────────────┘
                                            ▼           ▼
                                        产品数据库    Stripe(该产品专属 account)
                                        (只读副本)   (唯一事实源)◀── Dashboard 改价
                                                        │
                                                        └── Webhook ──▶ /api/billing/webhook
```

### 1.1 铁律(实现时不可违背)

1. **Stripe 是唯一事实源**。本地表只是读副本,任何状态更新都通过 `syncStripeToDb()` 从 Stripe API 拉取真相后 upsert,绝不在 webhook handler 里手写每个事件的局部字段更新。
2. **权益只信 webhook**,浏览器成功回跳只做「触发一次兜底 sync + 展示」,不授予权益。
3. **core 零框架依赖**:不 import next/express/react,只暴露纯函数与类型。
4. **服务端白名单**:checkout 只接受 `billing.config.ts` 中声明的 `planKey`,由服务端解析成 price,拒绝客户端直传任意 `price_id`。
5. **时间与金额**:金额一律用 Stripe 返回的最小货币单位整数(`unit_amount`),前端格式化展示;不做浮点运算。

---

## 2. 包结构(pnpm monorepo)

| 包 | npm 名 | 职责 | 依赖 |
|---|---|---|---|
| core | `@billing-kit/core` | 全部业务逻辑 + 类型 + HTTP 契约处理器 | `stripe` |
| adapter-next | `@billing-kit/next` | Next.js App Router 路由挂载 | core |
| adapter-express | `@billing-kit/express` | Express Router 挂载 | core |
| react | `@billing-kit/react` | hooks + headless 组件 | react(peer) |
| storage-pg | core 内置 `storage/pg` | Postgres 实现 | `pg`(peer) |
| storage-prisma | core 内置 `storage/prisma` | Prisma 实现 | `@prisma/client`(peer) |

> 发布形态:npm 私有 registry 或 git 依赖均可;版本统一走 changesets。

---

## 3. 配置契约(`billing.config.ts`)

产品接入时唯一要写的配置文件。**这份类型是套件对外的第一契约**:

```ts
import type { BillingConfig } from '@billing-kit/core';

export const billingConfig: BillingConfig = {
  // ── Stripe 凭证(全部来自环境变量,模板见 env.template)──
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY!,        // sk_live_xxx / sandbox 的 sk_test_xxx
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!, // whsec_xxx
    publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!, // pk_xxx(仅前端用)
  },

  // ── 套餐声明:planKey 是产品内部稳定标识 ──
  // ref 二选一:lookupKey(推荐,支持改价原子迁移)或 priceId(兼容直填)
  plans: [
    { key: 'pro_monthly',  type: 'subscription', ref: { lookupKey: 'pro_monthly' },  features: ['pro'] },
    { key: 'pro_yearly',   type: 'subscription', ref: { lookupKey: 'pro_yearly' },   features: ['pro'] },
    { key: 'lifetime',     type: 'one_time',     ref: { lookupKey: 'lifetime' },     features: ['pro', 'lifetime'] },
  ],

  // ── 回跳地址 ──
  urls: {
    checkoutSuccess: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    checkoutCancel: `${process.env.APP_URL}/pricing`,
    portalReturn: `${process.env.APP_URL}/account`,
  },

  // ── 存储 ──
  storage: pgStorage(pool), // 或 prismaStorage(prisma)

  // ── 可选项 ──
  catalogTtlSeconds: 600,          // catalog 缓存 TTL,默认 600
  logger: console,                 // 结构化 logger 注入点
  hooks: {                         // 业务通知钩子,全部可选
    onCheckoutCompleted: async (ctx) => {},
    onSubscriptionChanged: async (ctx) => {},
    onPaymentFailed: async (ctx) => {},
    onSubscriptionCanceled: async (ctx) => {},
  },
};
```

### 3.1 核心类型

```ts
type PlanType = 'subscription' | 'one_time';

interface PlanDef {
  key: string;                       // 产品内部稳定标识,业务代码只用它
  type: PlanType;
  ref: { lookupKey: string } | { priceId: string };
  features: string[];                // 该套餐解锁的能力标签
}

interface Entitlement {
  planKey: string;
  features: string[];
  source: 'subscription' | 'purchase';
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';
  currentPeriodEnd: string | null;   // ISO;买断为 null(永久)
  cancelAtPeriodEnd: boolean;
}
```

---

## 4. HTTP 标准契约(前后端解耦的关键)

所有适配器最终暴露同样的 5 个端点。**任何前端(React/Vue/Svelte/原生)按此契约消费即可**,这也是 AI 接入非 React 前端时的依据。

### 4.1 `GET /api/billing/catalog` — 动态商品目录(公开)

前端定价页的数据源。响应:

```jsonc
{
  "plans": [
    {
      "key": "pro_monthly",
      "type": "subscription",
      "product": { "name": "Pro", "description": "...", "marketingFeatures": ["..."] , "images": [] },
      "price": {
        "id": "price_xxx",            // 仅信息展示,前端不得回传
        "currency": "usd",
        "unitAmount": 1900,            // 最小货币单位
        "interval": "month",           // one_time 时为 null
        "intervalCount": 1,
        "trialPeriodDays": null
      }
    }
  ],
  "updatedAt": "2026-07-02T08:00:00Z"
}
```

实现:按 config 中全部 `lookupKey` 调 `GET /v1/prices?lookup_keys[]=…&active=true&expand[]=data.product`(priceId 引用则直接 retrieve),组装后写入内存缓存(TTL = `catalogTtlSeconds`)。**缓存失效来源**:TTL 到期、webhook 收到 `price.created|price.updated|product.updated`。

### 4.2 `POST /api/billing/checkout` — 创建支付会话(需登录)

请求:`{ "planKey": "pro_monthly", "quantity": 1 }`
响应:`{ "url": "https://checkout.stripe.com/c/pay/cs_xxx" }`(前端 302 跳转)

实现要点:

1. 从会话中取 `userId`(适配器注入 `resolveUser(req)`,产品侧提供)。
2. `planKey` 必须存在于 config.plans,否则 400 —— **白名单在此生效**。
3. customer 复用:查 `billing_customers`;没有则 `stripe.customers.create({ metadata: { userId } })` 后落表。
4. 创建 Session:`mode` 由 plan.type 决定;携带 `client_reference_id: userId`、`customer`、`success_url/cancel_url`;订阅另设 `subscription_data.metadata.userId`。
5. 出站幂等:`{ idempotencyKey: `checkout:${userId}:${planKey}:${分钟级时间桶}` }`。

### 4.3 `POST /api/billing/portal` — Customer Portal 会话(需登录)

请求:`{}` → 响应:`{ "url": "https://billing.stripe.com/p/session/xxx" }`
实现:`stripe.billingPortal.sessions.create({ customer, return_url: urls.portalReturn })`。

### 4.4 `GET /api/billing/me` — 当前用户权益(需登录)

响应:`{ "entitlements": Entitlement[], "hasAccess": { "pro": true, "lifetime": false } }`
实现:纯读本地表(`billing_subscriptions` + `billing_purchases`),不打 Stripe API。

### 4.5 `POST /api/billing/webhook` — Stripe 回调(公开,验签)

**适配器必须以 raw body 接入**(Next.js Route Handler 用 `await req.text()`;Express 用 `express.raw({ type: 'application/json' })`)。

处理管线(core 内实现,顺序固定):

```
verify(rawBody, sig, webhookSecret)          // 失败 → 400
  → claimEvent(event.id)                     // INSERT ON CONFLICT DO NOTHING;已存在 → 200 直接返回
  → dispatch(event)                          // 见 4.6
  → 200(处理器内部错误也记日志后返回 500 让 Stripe 重试,幂等表保证不双发)
```

### 4.6 Webhook 事件矩阵(v1 全集)

| 事件 | 动作 |
|---|---|
| `checkout.session.completed` | `mode=payment`:落 `billing_purchases` + 触发 `onCheckoutCompleted`;`mode=subscription`:`syncStripeToDb(customer)` |
| `customer.subscription.created/updated/deleted` | `syncStripeToDb(customer)` + 触发 `onSubscriptionChanged`/`onSubscriptionCanceled` |
| `invoice.payment_failed` | `syncStripeToDb(customer)` + 触发 `onPaymentFailed` |
| `invoice.paid` | `syncStripeToDb(customer)` |
| `price.created` / `price.updated` / `product.updated` | 失效 catalog 缓存 |
| 其他 | 记日志,直接 200(忽略但不报错) |

### 4.7 `syncStripeToDb(customerId)`(全套件唯一状态写入口)

```
1. stripe.subscriptions.list({ customer, status: 'all', limit: 10, expand: ['data.items.data.price'] })
2. 取最新一条(按 created 倒序)→ 映射 status / price → planKey(经 lookup_key 或 price_id 反查 config)
3. UPSERT billing_subscriptions(唯一键 stripe_subscription_id)
4. 派生 entitlements 缓存字段(status ∈ active|trialing → 有权益)
```

成功回跳页 `/billing/success` 服务端也调一次(**兜底**,防 webhook 延迟导致用户付完看不到权益)。

---

## 5. 数据模型(模板随包分发:SQL + Prisma schema)

```sql
-- 用户 ↔ Stripe customer 映射(每产品一行/用户)
CREATE TABLE billing_customers (
  user_id            TEXT PRIMARY KEY,
  stripe_customer_id TEXT UNIQUE NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 订阅状态副本(源:syncStripeToDb)
CREATE TABLE billing_subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES billing_customers(user_id),
  plan_key               TEXT NOT NULL,
  status                 TEXT NOT NULL,          -- active/trialing/past_due/canceled/…
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT false,
  raw                    JSONB NOT NULL,          -- 完整 subscription 对象,排障用
  synced_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_billing_subs_user ON billing_subscriptions(user_id, status);

-- 一次性买断记录(源:checkout.session.completed)
CREATE TABLE billing_purchases (
  stripe_session_id TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  plan_key          TEXT NOT NULL,
  amount_total      INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  purchased_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_billing_purchases_user ON billing_purchases(user_id);

-- webhook 幂等表
CREATE TABLE billing_events (
  stripe_event_id TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`StorageAdapter` 接口(core 只依赖此接口):

```ts
interface StorageAdapter {
  getCustomerByUserId(userId: string): Promise<CustomerRow | null>;
  upsertCustomer(row: CustomerRow): Promise<void>;
  claimEvent(eventId: string, type: string): Promise<boolean>; // true=首次,false=重复
  upsertSubscription(row: SubscriptionRow): Promise<void>;
  insertPurchase(row: PurchaseRow): Promise<void>;
  getEntitlementRows(userId: string): Promise<{ subs: SubscriptionRow[]; purchases: PurchaseRow[] }>;
}
```

---

## 6. 适配器规范

### 6.1 Next.js(App Router)

```ts
// app/api/billing/[...billing]/route.ts —— 产品侧全部胶水代码
import { createNextBillingHandler } from '@billing-kit/next';
import { billingConfig } from '@/billing.config';
import { auth } from '@/lib/auth';

const handler = createNextBillingHandler(billingConfig, {
  resolveUser: async (req) => (await auth(req))?.user?.id ?? null,
});
export const { GET, POST } = handler;
```

要求:webhook 分支内部用 `req.text()` 取 raw body;其余分支正常 JSON。

### 6.2 Express

```ts
import { createExpressBillingRouter } from '@billing-kit/express';
app.use('/api/billing', createExpressBillingRouter(billingConfig, {
  resolveUser: async (req) => req.session?.userId ?? null,
}));
```

要求:router 内部对 `/webhook` 路径先挂 `express.raw({ type: 'application/json' })`,其余路径 `express.json()`。**顺序不可颠倒**。

### 6.3 React 包(headless)

```ts
usePlans()          // GET /catalog,返回 { plans, isLoading, error, refresh }
useCheckout()       // 返回 { checkout(planKey, qty?), isPending };内部 POST /checkout 后跳转 url
useBillingStatus()  // GET /me,返回 { status, hasAccess(feature), isLoading, refresh }
usePortal()         // 返回 { openPortal(), isPending };内部 POST /portal 后跳转 url
<PricingSection renderPlan={(plan, { checkout, isPending }) => JSX} />  // headless,数据自取自 /catalog
<SubscriptionGate feature="pro" fallback={<Paywall/>}>{children}</SubscriptionGate>
<BillingPortalButton>管理订阅</BillingPortalButton>
<BillingProvider basePath="/api/billing">…</BillingProvider>  // 仅挂载点非默认时需要
```

---

## 7. 目录结构(core 内部)

```
packages/core/src/
├── index.ts              # 公开 API 出口(全部函数接受 BillingConfig,内部 WeakMap 复用 context)
├── config.ts             # BillingConfig 类型 + 手写校验 + createBillingContext
├── catalog.ts            # 目录拉取 + TTL 缓存 + invalidateCatalogCache + resolvePriceId
├── checkout.ts           # createCheckoutSession(planKey 白名单 + 出站幂等键)
├── portal.ts             # createPortalSession(userId)
├── customers.ts          # getOrCreateCustomer / resolveUserByCustomerId
├── entitlements.ts       # hasAccess / getEntitlements(纯读 storage)
├── sync.ts               # syncStripeToDb(customerId)★ 唯一状态写入口 + syncCheckoutSession 兜底
├── webhook.ts            # 验签 → claimEvent 幂等 → 事件矩阵分发(单文件管线)
├── http.ts               # 框架无关的 5 端点处理器(适配器薄封装它)
├── storage/
│   ├── types.ts          # StorageAdapter 接口
│   ├── pg.ts             # Postgres 实现(PgLike 结构化类型,零硬依赖)
│   ├── prisma.ts         # Prisma 实现(PrismaLike,零硬依赖)
│   └── memory.ts         # 内存实现(单测/本地试跑)
├── testing.ts            # testConfig 单测工厂
└── errors.ts             # BillingError(code → HTTP status 映射)
```

> 实现说明(与最初设计稿的差异):webhook 管线合并为单文件 `webhook.ts`;
> 配置校验用手写规则而非 zod(少一个运行时依赖,校验逻辑 ~40 行);
> 新增 `customers.ts` 承载 user↔customer 映射;`testing.ts` 与 `storage/memory.ts` 服务单测。

## 8. 测试与验证策略

| 层 | 方式 |
|---|---|
| 单测 | catalog 缓存失效、planKey 白名单、幂等 claimEvent、entitlement 派生逻辑(stripe SDK 全 mock) |
| 集成 | Stripe sandbox + `stripe listen --forward-to localhost:3000/api/billing/webhook`;测试卡 `4242 4242 4242 4242`(成功)、`4000 0000 0000 9995`(失败) |
| 重放 | `stripe events resend evt_xxx` 验证幂等 |
| E2E 清单 | 见 INTEGRATION.md 第 6 节(接入后逐项打勾) |
