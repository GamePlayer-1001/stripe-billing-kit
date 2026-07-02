# INTEGRATION · 产品接入指南(写给产品开发 AI)

> **你是谁**:正在开发一个新产品的 AI。本文档是你把 Stripe 支付接入该产品的**唯一操作手册**,按顺序执行即可,预计 2~4 小时。
> **不要**自行发明支付逻辑、**不要**绕过本套件直接调 Stripe API(catalog/checkout/webhook/权益判断都必须走套件)。
> 深入原理见 `ARCHITECTURE.md`(仅当你需要移植到本套件未覆盖的框架时才需要读)。

---

## 0. 开始前:收取并校验「交接卡」(缺一不可)

所有者会发给你一张 **交接卡 v2**(模板见 `CHECKLIST.md` 第三部分)。你要拿到的完整信息分五组——**逐组校验,任何一项缺失或不合法就停下向所有者索要,禁止编造占位值继续**:

| 组 | 内容 | 校验规则 |
|---|---|---|
| **环境与账号** | 环境声明(sandbox/live)、Account ID(建议) | 环境声明必填;后续所有 key 前缀必须与之一致 |
| **三把钥匙** | `STRIPE_SECRET_KEY`(sk_)、`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`(pk_)、`STRIPE_WEBHOOK_SECRET`(whsec_) | 前缀合法;`sk_test_` 必须配 `pk_test_`,`sk_live_` 必须配 `pk_live_`;webhook secret 在本地开发阶段允许标注「用 `stripe listen` 自取」 |
| **套餐信息表** | 每套餐一行:planKey / 类型 / lookup_key / price_id / 金额货币周期(核对用)/ 试用期 / features | planKey 唯一非空;lookup_key 与 price_id 至少一项;类型 ∈ {subscription, one_time};features 非空 |
| **后台配置确认** | E1 webhook 9 事件、E2 Portal 已保存、E3 Portal 产品目录、E4 商品价格已建 | 四项勾选齐全(本地开发 E1 可豁免;E3 可标「不适用」) |
| **产品側信息** | APP_URL、用户标识体系、数据库类型、前端框架 | 四项齐全 |

> 每一项信息在 Stripe 后台的具体位置、缺漏后果、优先级分级(P0/P1/P2),都在 **`CHECKLIST.md` 第一、二部分**,遇到不确定就查它。

**套餐信息表示例**(若只给了 price_id 没给 lookup_key 也能用):

| planKey(产品内标识) | 类型 | lookup_key(推荐) | price_id(备选) | 金额(核对用) | features |
|---|---|---|---|---|---|
| pro_monthly | subscription | pro_monthly | price_xxx | $19 USD/月 | pro |
| pro_yearly | subscription | pro_yearly | price_yyy | $190 USD/年 | pro |
| lifetime | one_time | lifetime | price_zzz | $399 USD | pro, lifetime |

## 0.1 交接卡之外,你要自查产品自身的三件事

1. **登录体系**:产品如何拿到当前登录用户的稳定 `userId`(接入时要写 `resolveUser` 函数)。支付必须登录后发起;checkout 与权益查询必须用同一套 userId。
2. **数据库**:产品用什么库(Postgres 直连还是 Prisma),决定选哪个 storage adapter。
3. **前端框架**:React 用现成包;其他框架按第 3.3 节 HTTP 契约自行渲染。

---

## 1. 安装与配置(约 15 分钟)

### 1.1 安装

套件包位于本仓库 `packages/`(未发布公共 npm)。两种安装方式:

```bash
# 方式 A:git 子目录依赖(推荐,产品仓库独立时)
pnpm add "github:<owner>/stripe-billing-kit#path:/packages/core" \
         "github:<owner>/stripe-billing-kit#path:/packages/adapter-next" \
         "github:<owner>/stripe-billing-kit#path:/packages/react"

# 方式 B:本地路径依赖(产品与套件同机开发时)
pnpm add file:../stripe-billing-kit/packages/core \
         file:../stripe-billing-kit/packages/adapter-next \
         file:../stripe-billing-kit/packages/react

# Express 产品把 adapter-next 换成 adapter-express;安装后需先在套件目录跑一次 pnpm install && pnpm build
```

> 若所有者已将包发到私有 registry,直接 `pnpm add @billing-kit/core @billing-kit/next @billing-kit/react` 即可。

### 1.2 环境变量(复制 `templates/env.template`)

```bash
# .env.local —— 三把钥匙 + 应用地址
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_xxx
APP_URL=http://localhost:3000
```

> 规则:secret/webhook key 绝不进前端代码与 git;`NEXT_PUBLIC_` 前缀仅给 publishable key。

### 1.3 写 `billing.config.ts`(复制 `templates/billing.config.template.ts`)

把「套餐信息表」逐行翻译成 `plans` 数组——**这是整个接入中唯一需要动脑的映射**:

```ts
import { pgStorage } from '@billing-kit/core/storage/pg';
import type { BillingConfig } from '@billing-kit/core';
import { pool } from '@/lib/db';

export const billingConfig: BillingConfig = {
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!,
  },
  plans: [
    // 有 lookup_key 用 lookupKey(推荐);只有 price_id 用 priceId
    { key: 'pro_monthly', type: 'subscription', ref: { lookupKey: 'pro_monthly' }, features: ['pro'] },
    { key: 'pro_yearly',  type: 'subscription', ref: { lookupKey: 'pro_yearly' },  features: ['pro'] },
    { key: 'lifetime',    type: 'one_time',     ref: { lookupKey: 'lifetime' },    features: ['pro', 'lifetime'] },
  ],
  urls: {
    checkoutSuccess: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    checkoutCancel: `${process.env.APP_URL}/pricing`,
    portalReturn: `${process.env.APP_URL}/account`,
  },
  storage: pgStorage(pool),
};
```

### 1.4 建表

- Postgres 直连:执行 `templates/schema/billing.sql`(4 张表:billing_customers / billing_subscriptions / billing_purchases / billing_events)。
- Prisma:把 `templates/schema/billing.prisma` 追加进 `schema.prisma` 后 `prisma migrate dev`。

---

## 2. 后端接入(约 30 分钟)

### 2.1 Next.js(App Router)——一个文件搞定 5 个端点

```ts
// app/api/billing/[...billing]/route.ts
import { createNextBillingHandler } from '@billing-kit/next';
import { billingConfig } from '@/billing.config';
import { getCurrentUserId } from '@/lib/auth'; // ← 换成产品自己的会话逻辑

const handler = createNextBillingHandler(billingConfig, {
  resolveUser: async (req) => getCurrentUserId(req), // 未登录返回 null
});
export const { GET, POST } = handler;
```

### 2.2 Express

```ts
import { createExpressBillingRouter } from '@billing-kit/express';
app.use('/api/billing', createExpressBillingRouter(billingConfig, {
  resolveUser: async (req) => req.session?.userId ?? null,
}));
// 注意:webhook 的 raw body 处理已在 router 内部完成,不要在它之前全局挂 express.json()
// 如果产品已全局挂了 express.json(),必须把本 router 挂在其【前面】
```

### 2.3 成功回跳页(兜底同步,必须做)

```tsx
// app/billing/success/page.tsx(Server Component)
import { syncCheckoutSession } from '@billing-kit/core';
import { billingConfig } from '@/billing.config';

export default async function SuccessPage({ searchParams }: { searchParams: Promise<{ session_id?: string }> }) {
  const { session_id } = await searchParams;
  if (session_id) await syncCheckoutSession(billingConfig, session_id); // 幂等,可放心调
  return <div>支付成功,权益已开通。</div>;
}
```

> 原理:权益授予以 webhook 为准,这里只是防 webhook 延迟的兜底,让用户付完立刻看到结果。

---

## 3. 前端接入(约 30~60 分钟)

### 3.1 React:定价页

```tsx
'use client';
import { usePlans, useCheckout } from '@billing-kit/react';

export function Pricing() {
  const { plans, isLoading } = usePlans();      // ← 价格全部来自 Stripe,禁止硬编码
  const { checkout, isPending } = useCheckout();
  if (isLoading) return <PricingSkeleton />;

  return (
    <div className="grid grid-cols-3 gap-6">
      {plans.map((p) => (
        <div key={p.key} className="rounded-xl border p-6">
          <h3>{p.product.name}</h3>
          <p className="text-3xl font-bold">
            {formatMoney(p.price.unitAmount, p.price.currency)}
            {p.price.interval && <span className="text-sm">/{p.price.interval}</span>}
          </p>
          <ul>{p.product.marketingFeatures.map((f) => <li key={f}>{f}</li>)}</ul>
          <button disabled={isPending} onClick={() => checkout(p.key)}>
            {p.type === 'subscription' ? '订阅' : '购买'}
          </button>
        </div>
      ))}
    </div>
  );
}

const formatMoney = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100);
```

### 3.2 付费墙与账单入口

```tsx
import { SubscriptionGate, useBillingStatus, BillingPortalButton } from '@billing-kit/react';

// 功能级拦截
<SubscriptionGate feature="pro" fallback={<UpgradeBanner />}>
  <ProFeature />
</SubscriptionGate>

// 用户中心的「管理订阅」按钮(跳 Stripe Customer Portal,升降级/取消/换卡全在里面)
<BillingPortalButton>管理订阅</BillingPortalButton>
```

服务端判断(SSR / API 内):

```ts
import { hasAccess } from '@billing-kit/core';
if (!(await hasAccess(billingConfig, userId, 'pro'))) return new Response('Payment Required', { status: 402 });
```

### 3.3 非 React 前端:直接消费 HTTP 契约

| 动作 | 调用 | 处理 |
|---|---|---|
| 渲染定价页 | `GET /api/billing/catalog` | 遍历 `plans[]` 渲染;金额 = `unitAmount / 100` 后按 `currency` 格式化 |
| 点击购买 | `POST /api/billing/checkout` body `{"planKey":"pro_monthly"}` | 拿到 `url` 后 `window.location.href = url` |
| 管理订阅 | `POST /api/billing/portal` | 同上跳转 |
| 查询权益 | `GET /api/billing/me` | 按 `hasAccess` 字段控制 UI |

> 完整响应结构见 `ARCHITECTURE.md` 第 4 节。

---

## 4. UI 预留清单(新产品设计时就留好这些位置)

- [ ] `/pricing` 定价页(数据源 = catalog 接口,**不写死任何价格数字**)
- [ ] `/billing/success` 支付成功页(含兜底 sync)
- [ ] 用户中心「订阅/账单」区块:当前套餐状态 + `BillingPortalButton`
- [ ] 付费功能处的 `SubscriptionGate` / 402 拦截
- [ ] 订阅异常提示位:`status === 'past_due'` 时提示用户更新支付方式(数据来自 `/me`)

---

## 5. 本地联调(必须完成后才能声称接入成功)

```bash
# 1. 安装 Stripe CLI 并登录该产品 account
stripe login

# 2. 把 webhook 转发到本地(会打印临时 whsec_,填进 .env.local 的 STRIPE_WEBHOOK_SECRET)
stripe listen --forward-to localhost:3000/api/billing/webhook

# 3. 起产品 dev server,走完整流程
```

**测试卡**:成功 `4242 4242 4242 4242`;需要验证 `4000 0025 0000 3155`;余额不足 `4000 0000 0000 9995`。有效期任意未来日期,CVC 任意 3 位。

## 6. 验收清单(逐项打勾,全绿才算完成)

- [ ] `GET /api/billing/catalog` 返回全部套餐,价格与 Stripe 后台一致
- [ ] Stripe 后台改价(或 transfer lookup_key)后,不改代码,catalog 返回新价
- [ ] 未登录 `POST /checkout` 返回 401;非法 planKey 返回 400
- [ ] 测试卡完成**订阅**:webhook 日志出现 `checkout.session.completed` + `customer.subscription.created`;`/me` 的 `hasAccess.pro === true`
- [ ] 测试卡完成**买断**:`billing_purchases` 落行;权益立即生效
- [ ] `stripe events resend evt_xxx` 重放同一事件:`billing_events` 不重复处理(日志显示 duplicate skip)
- [ ] Portal 内取消订阅:webhook 回传后 `/me` 状态变为 `canceled`(或 `cancelAtPeriodEnd: true`)
- [ ] 用失败卡触发 `invoice.payment_failed`:日志可见,`onPaymentFailed` 钩子被调用(若已配置)
- [ ] 全库检索确认:**没有任何硬编码的价格数字或 price_id**(config 与环境变量除外)

## 7. 常见坑(前人踩过,禁止再踩)

| 症状 | 根因 | 解法 |
|---|---|---|
| webhook 一直 400 signature verification failed | body 被 JSON 中间件提前解析,验签拿不到 raw body | Next: 用 `req.text()`;Express: raw 中间件必须先于 json |
| 付款成功但权益没开 | 只做了成功回跳,没起 `stripe listen` / 线上没配 endpoint | 按第 5 节起转发;线上按 STRIPE-SETUP.md 配 endpoint |
| 本地一切正常,线上 webhook 全失败 | 用了本地 `stripe listen` 的 whsec 部署到线上 | 线上环境变量换成 Dashboard endpoint 的 whsec |
| 权益重复发放(重复邮件等) | 绕过套件自写 webhook handler,丢了幂等 | 必须走套件 webhook 管线 |
| catalog 为空 | lookup_key 拼错 / price 未设 active / 用错 account 的 key | 核对套餐信息表与密钥属于同一 account(沙箱≠正式) |
| 点「管理订阅」报错 portal session | 所有者没在**当前环境**保存 Customer Portal 设置(E2) | 让所有者到 Settings → Billing → Customer portal 点 Save(沙箱/正式各一次) |
| 改价后前端一直旧价 | 改价方式是新建 price 但没 transfer lookup_key,config 又是按 lookupKey 引用 | 所有者按 STRIPE-SETUP.md 的改价 SOP 操作 |
| `hasAccess` 永远 false | `resolveUser` 返回的 userId 与 checkout 时不一致(如一边 email 一边 uuid) | 全产品统一稳定 userId |

## 8. 上线切换(sandbox → live)

1. 所有者提供 live 三把钥匙(sk_live / pk_live / 线上 endpoint 的 whsec)。
2. 替换生产环境变量,**代码零改动**。
3. 所有者确认 live account 里已按同样 lookup_key 建好商品(STRIPE-SETUP.md 第 5 节)。
4. 上线后用真实小额支付跑一遍验收清单第 4、6 项,然后退款。
