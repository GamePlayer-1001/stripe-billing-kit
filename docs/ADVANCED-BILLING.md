# Stripe Billing Kit — 高级付款模式完整指南

> **AI 快速接入指令**（让你的 AI 编码助手自动理解 Stripe API）：
> ```bash
> npx skills add https://docs.stripe.com
> /plugin install stripe@claude-plugins-official
> codex plugin add stripe@openai-curated
> ```

---

## 目录

1. [8 种付款模式速查](#8-种付款模式速查)
2. [模式 1 — 自动包月/包年（subscription）](#模式-1--自动包月包年)
3. [模式 2 — 买断/终身（one_time）](#模式-2--买断终身)
4. [模式 3 — 试用转订阅（trial_then_subscribe）](#模式-3--试用绑卡自动转订阅)
5. [模式 4 — 免费试用到期即止（trial_no_convert）](#模式-4--免费试用到期即止)
6. [模式 5 — 按量计费（metered）](#模式-5--按量计费)
7. [模式 6 — 额度包（credit_package）](#模式-6--额度包)
8. [模式 7 — 单日通行证（daily）](#模式-7--单日通行证)
9. [模式 8 — 新用户专属首次试用（first_trial）](#模式-8--新用户专属首次试用)
10. [Webhook 事件处理](#webhook-事件处理)
11. [前端接入（框架无关）](#前端接入框架无关)
12. [环境变量清单](#环境变量清单)

---

## 8 种付款模式速查

| 模式 | type | Stripe API mode | 适用场景 |
|------|------|----------------|---------|
| 自动包月/包年 | `subscription` | `subscription` | SaaS 主力付费墙 |
| 买断/终身 | `one_time` | `payment` | 工具软件终身授权 |
| 试用绑卡→自动转订阅 | `trial_then_subscribe` | `subscription` + trial | 需要绑卡的试用期 |
| 免费试用→到期即止 | `trial_no_convert` | `subscription` + trial | 不强制绑卡的体验期 |
| 按量计费 | `metered` | `subscription` (usage-based) | AI token/API 调用/带宽 |
| 额度包 | `credit_package` | `payment` | 预付点数、短信包 |
| 单日通行证 | `daily` | `payment` | 日票、单次活动访问 |
| 新用户专属首次试用 | `first_trial` | `subscription` + trial | 仅限首次订阅用户，一次性试用 |

---

## 模式 1 — 自动包月/包年

### Stripe Dashboard 配置
1. Products → 新建产品 → Pricing: **Recurring**
2. 包月选 `Monthly`，包年选 `Yearly`，复制 Price ID

### billing.config.ts
```ts
{ key: 'pro_monthly', type: 'subscription', ref: { priceId: 'price_xxx' }, features: ['pro'] }
```

### 后端（Node/Deno/Bun 均可）
```ts
import { createCheckoutSession } from '@stripe-billing-kit/core';

// POST /api/billing/checkout
app.post('/api/billing/checkout', async (req, res) => {
  const { url } = await createCheckoutSession(ctx, {
    userId: req.user.id,
    planKey: 'pro_monthly',
  });
  res.json({ url });
});
```

### 前端（任意框架）
```ts
const { url } = await fetch('/api/billing/checkout', {
  method: 'POST',
  body: JSON.stringify({ planKey: 'pro_monthly' }),
}).then(r => r.json());
window.location.href = url; // 跳转 Stripe Checkout
```

---

## 模式 2 — 买断/终身

### Stripe Dashboard 配置
1. Products → 新建产品 → Pricing: **One time**，复制 Price ID

### billing.config.ts
```ts
{ key: 'lifetime', type: 'one_time', ref: { priceId: 'price_xxx' }, features: ['pro', 'lifetime'] }
```

### 后端
```ts
const { url } = await createCheckoutSession(ctx, { userId, planKey: 'lifetime' });
```

---

## 模式 3 — 试用绑卡，自动转订阅

> 用户须填写信用卡。试用期结束后 **Stripe 自动扣款**，无需你任何操作。

### Stripe Dashboard 配置
同「自动包月」，使用同一个 Recurring Price ID。

### billing.config.ts
```ts
{
  key:       'trial_auto',
  type:      'trial_then_subscribe',
  trialDays: 7,
  ref:       { priceId: 'price_monthly_xxx' },
  features:  ['pro'],
}
```

### 关键行为
- Stripe Checkout 会要求用户填卡
- 试用期内不扣款，`invoice.amount_due = 0`
- 试用期结束 → Stripe 自动出第一张账单 → 触发 `onSubscriptionChanged({ status: 'active' })`
- 用户在试用期内取消 → 订阅进入 `canceled` 状态

---

## 模式 4 — 免费试用，到期即止

> 用户**无需**填信用卡。到期后 Stripe 因没有支付方式自动 cancel 订阅。

### billing.config.ts
```ts
{
  key:       'trial_free',
  type:      'trial_no_convert',
  trialDays: 3,
  ref:       { priceId: 'price_trial_xxx' },   // 可用 $0 的 Recurring Price
  features:  ['pro'],
}
```

### 关键行为
- Stripe 使用 `trial_settings.end_behavior.missing_payment_method: 'cancel'`
- 到期后触发 `onSubscriptionChanged({ status: 'canceled' })`
- 若想转付费：让用户再次点击「升级」走 `trial_then_subscribe` 或 `subscription` 流程

---

## 模式 5 — 按量计费

> 每次消耗（如 AI token、API 调用）调一次 `reportUsage()`，Stripe 月底汇总出账。

### Stripe Dashboard 配置
1. **Billing → Meters** → 新建 Meter，`event_name` 填 `ai_tokens`，记下 Meter ID
2. Products → Pricing: **Usage-based**，选刚建的 Meter，复制 Price ID

### billing.config.ts
```ts
{
  key:            'metered_tokens',
  type:           'metered',
  meterEventName: 'ai_tokens',
  meterId:        'mtr_xxxxxxxxxxxxxxxx',
  ref:            { priceId: 'price_metered_xxx' },
  features:       ['api_access'],
}
```

### 后端：上报用量
```ts
import { reportUsage, getMeterUsage } from '@stripe-billing-kit/core';

// 每次 AI 调用后上报
await reportUsage(ctx, {
  userId:   req.user.id,
  planKey:  'metered_tokens',
  value:    tokenCount,         // 本次消耗 token 数（正整数）
});

// 查询当前周期累计用量（用于仪表盘展示）
const { totalUsage } = await getMeterUsage(ctx, {
  userId:  req.user.id,
  planKey: 'metered_tokens',
});
```

### 注意事项
- `reportUsage` 已内置幂等 key（用户+计划+秒级时间桶），同一秒同一用户重复调用只计一次
- 补报历史数据：传 `timestamp`（Unix 秒），最多可补报 7 天内的事件
- 生产建议：用队列（BullMQ / SQS）异步上报，避免主流程因网络延迟阻塞

---

## 模式 6 — 额度包

> 用户一次购买 N 点，每次使用调 `consumeUserCredit()` 扣减，用完再买。

### Stripe Dashboard 配置
Products → Pricing: **One time**，复制 Price ID

### billing.config.ts
```ts
{
  key:          'credits_1000',
  type:         'credit_package',
  creditAmount: 1000,
  ref:          { priceId: 'price_credits_xxx' },
  features:     ['api_access'],
}
```

### 后端
```ts
import { getCreditBalance, consumeUserCredit } from '@stripe-billing-kit/core';

// 查余额（展示给用户）
const balance = await getCreditBalance(ctx, req.user.id);

// 使用前扣减（不足时会 throw）
try {
  const remaining = await consumeUserCredit(ctx, req.user.id, cost);
  // 执行实际业务逻辑...
} catch (err) {
  if (err.code === 'insufficient_credits') {
    return res.status(402).json({ error: '额度不足，请购买额度包' });
  }
  throw err;
}
```

### StorageAdapter 最佳实践
强烈建议实现 `getCreditBalance` 和 `consumeCredit` 可选方法，使用数据库行锁保证原子性：
```sql
-- PostgreSQL 示例
UPDATE user_credits
SET balance = balance - $1
WHERE user_id = $2 AND balance >= $1
RETURNING balance;
-- 影响行数为 0 → 余额不足 → throw
```

---

## 模式 7 — 单日通行证

> 非自动续费，购买当天（或指定 N 天）有效，到期自动失效。

### Stripe Dashboard 配置
Products → Pricing: **One time**，复制 Price ID

### billing.config.ts
```ts
{
  key:      'daily_pass',
  type:     'daily',
  ref:      { priceId: 'price_daily_xxx' },
  features: ['pro'],
}
```

### 后端
```ts
import { createCheckoutSession } from '@stripe-billing-kit/core';
import { isDailyPassActive }     from '@stripe-billing-kit/core';

// 购买 3 天通行证
const { url } = await createCheckoutSession(ctx, {
  userId:   req.user.id,
  planKey:  'daily_pass',
  quantity: 3,           // 买 3 天
});

// 校验今天是否有效
const active = await isDailyPassActive(ctx, req.user.id, 'daily_pass');
if (!active) return res.status(403).json({ error: '通行证已过期' });
```

### 注意
- `isDailyPassActive` 依赖 `PurchaseRow.createdAt` 和 `metadata.dailyDays`
- 你的 StorageAdapter 在写入 purchase 时需保存这两个字段
- Webhook `onCheckoutCompleted` 是写入的时机：
```ts
onCheckoutCompleted: async ({ userId, planKey, session }) => {
  const quantity = session.line_items?.data[0]?.quantity ?? 1;
  await db.purchases.insert({
    stripeSessionId: session.id,
    userId, planKey,
    amountTotal: session.amount_total ?? 0,
    currency:    session.currency ?? 'usd',
    createdAt:   new Date(),
    metadata:    { dailyDays: String(quantity) },
  });
}
```

---

## 模式 8 — 新用户专属首次试用

> 仅限从未订阅过任何套餐的新用户使用，一次性试用，不可重复订阅。
> 试用结束需要绑卡自动转正式套餐。

### 适用场景
- **新用户首次体验**：吸引新用户首次订阅，降低转化门槛
- **产品冷启动**：让潜在客户免费体验核心功能
- **不可重复**：已订阅过的用户无法再次使用此套餐

### billing.config.ts
```ts
{
  key:             'first_trial_7d',
  type:            'first_trial',
  trialDays:       7,
  trialConvertsTo: 'pro_monthly',    // 必填：试用结束后的正式套餐 planKey
  ref:             { priceId: 'price_trial_7d_xxx' },
  features:        ['pro'],
}
```

### 前置校验（前端可先检查）
```ts
import { isNewUser, hasUsedFirstTrial } from '@stripe-billing-kit/core';

// 检查用户是否为新用户
const newUser = await isNewUser(ctx, userId);
if (!newUser) {
  return res.status(403).json({ error: '此套餐仅限新用户首次使用' });
}

// 检查用户是否已使用过此首次试用套餐
const used = await hasUsedFirstTrial(ctx, userId);
if (used) {
  return res.status(403).json({ error: '您已使用过首次试用套餐' });
}
```

### 关键行为
- **新用户检查**：订阅前检查用户 `subscriptions` 表是否为空
- **不可重复**：同一用户只能使用一次 `first_trial` 套餐
- **必须绑卡**：`payment_method_collection: 'always'`，用户必须提供信用卡
- **自动转正式**：试用结束后 Stripe 自动扣款转为正式订阅
- **metadata 标记**：订阅 metadata 中会标记 `isFirstTrial: 'true'`

### Stripe Dashboard 配置
1. 创建两个 Product/Price：
   - **试用 Price**：如 `$0 / 7 days`（Recurring）
   - **正式 Price**：如 `$19 / month`（Recurring）
2. 两个 Price 设置相同的 `lookup_key` 前缀（如 `pro_trial` 和 `pro_monthly`）
3. 试用 Price 设置 **Trial period: 7 days**

### 配置示例
```ts
plans: [
  // 新用户专属首次试用
  {
    key:             'first_trial_7d',
    type:            'first_trial',
    trialDays:       7,
    trialConvertsTo: 'pro_monthly',
    ref:             { lookupKey: 'pro_trial_7d' },  // 试用价格
    features:        ['pro'],
  },
  // 正式套餐
  {
    key:      'pro_monthly',
    type:     'subscription',
    ref:      { lookupKey: 'pro_monthly' },         // 正式价格
    features: ['pro'],
  },
]
```

### 前端展示逻辑
```tsx
// 根据用户状态展示不同内容
function PricingPage({ user }) {
  const [isNew] = useState(async () => {
    if (!user) return false;
    return await isNewUser(ctx, user.id);
  });

  if (!user) {
    return <LoginPrompt />;
  }

  if (isNew && !hasUsedFirstTrial(ctx, user.id)) {
    return (
      <>
        <PlanCard key="first_trial" plan={firstTrialPlan} badge="新用户专享" />
        <PlanCard key="monthly" plan={monthlyPlan} />
      </>
    );
  }

  // 已使用过首次试用或非新用户
  return <PlanCard key="monthly" plan={monthlyPlan} />;
}
```

---

## Webhook 事件处理

Stripe Billing Kit 的 Webhook 端点已内置在 `handleBillingRequest` 里：

```ts
// Express
app.post('/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const result = await handleBillingRequest(ctx, {
      method: 'POST',
      url: req.url,
      headers: req.headers as Record<string, string>,
      body: req.body,
    });
    res.status(result.status).json(result.body);
  }
);
```

**关键 Webhook 事件对应的 hooks：**

| Stripe 事件 | Kit hook | 何时触发 |
|------------|---------|---------|
| `checkout.session.completed` | `onCheckoutCompleted` | 支付成功 |
| `customer.subscription.updated` | `onSubscriptionChanged` | 订阅升降级/续费 |
| `customer.subscription.deleted` | `onSubscriptionChanged` | 订阅取消 |
| `invoice.payment_failed` | `onPaymentFailed` | 扣款失败 |

---

## 前端接入（框架无关）

所有框架（React/Vue/Svelte/Vanilla JS）接入方式完全一致：

```ts
// 1. 发起 Checkout
async function startCheckout(planKey: string, quantity = 1) {
  const res = await fetch('/api/billing/checkout', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ planKey, quantity }),
  });
  const { url } = await res.json();
  window.location.href = url;
}

// 2. 打开 Customer Portal（管理订阅/发票）
async function openPortal() {
  const { url } = await fetch('/api/billing/portal', { method: 'POST' })
    .then(r => r.json());
  window.open(url, '_blank');
}

// 3. 查询当前权限（用于 UI 付费墙）
async function checkAccess(feature: string): Promise<boolean> {
  const { hasAccess } = await fetch(`/api/billing/status`).then(r => r.json());
  return hasAccess[feature] === true;
}
```

---

## 环境变量清单

```env
# 必填
STRIPE_SECRET_KEY=sk_live_...          # Stripe 后台 > Developers > API Keys
STRIPE_WEBHOOK_SECRET=whsec_...        # Stripe 后台 > Webhooks > Signing secret
APP_URL=https://yourdomain.com         # 用于拼接 success/cancel URL

# 按量计费时额外需要（可选）
STRIPE_METER_ID=mtr_...                # 可直接写进 billing.config.ts 的 meterId 字段
```

> **安全提醒**：`.env` 文件必须加入 `.gitignore`，绝不提交到代码仓库。
