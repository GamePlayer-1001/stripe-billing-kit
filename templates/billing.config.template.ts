/**
 * billing.config.template.ts
 * 把这个文件复制到你的项目根目录，重命名为 billing.config.ts，
 * 填入真实的 Price ID，即可接入全部 8 种付款模式。
 *
 * ⚡ 价格由 Stripe Dashboard 驱动——改价只需在 Stripe 后台新建 Price，
 *    更新这里的 priceId，永不发版。
 *
 * 接入 AI 工具（让 AI 助手快速理解本套件）：
 *   npx skills add https://docs.stripe.com
 *   /plugin install stripe@claude-plugins-official
 *   codex plugin add stripe@openai-curated
 */
import { defineBillingConfig } from '@stripe-billing-kit/core';

export default defineBillingConfig({
  stripe: {
    secretKey:     process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    apiVersion:    '2025-04-30.basil',
  },

  urls: {
    checkoutSuccess: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    checkoutCancel:  `${process.env.APP_URL}/billing/cancel`,
    portalReturn:    `${process.env.APP_URL}/billing`,
  },

  allowPromotionCodes: true,

  plans: [
    // ── 1. 自动包月订阅 ─────────────────────────────────────────
    {
      key:      'pro_monthly',
      type:     'subscription',
      ref:      { priceId: 'price_XXXXXXX_monthly' },
      features: ['pro', 'api_access'],
    },

    // ── 2. 自动包年订阅（享折扣）──────────────────────────────
    {
      key:      'pro_yearly',
      type:     'subscription',
      ref:      { priceId: 'price_XXXXXXX_yearly' },
      features: ['pro', 'api_access'],
    },

    // ── 3. 试用期绑卡，到期自动转包月 ────────────────────────
    //    用户须提供信用卡，7天免费，之后自动按月扣款
    {
      key:           'trial_auto',
      type:          'trial_then_subscribe',
      trialDays:     7,
      trialConvertsTo: 'pro_monthly',          // 转成哪个套餐（仅注释用，Stripe 自动用同一 price）
      ref:           { priceId: 'price_XXXXXXX_monthly' },
      features:      ['pro'],
    },

    // ── 4. 试用期无需绑卡，到期即止 ──────────────────────────
    //    用户无需信用卡，3天免费，到期订阅自动 cancel
    {
      key:       'trial_free',
      type:      'trial_no_convert',
      trialDays: 3,
      ref:       { priceId: 'price_XXXXXXX_trial' },
      features:  ['pro'],
    },

    // ── 5. 按量计费（每次 AI 调用按 token 计费）──────────────
    //    Stripe Dashboard > Billing > Meters 里创建 Meter，
    //    event_name 对应 meterEventName；Price 选 "Usage-based"
    {
      key:            'metered_tokens',
      type:           'metered',
      meterEventName: 'ai_tokens',            // Stripe Meter event_name
      meterId:        'mtr_XXXXXXXXXXXXXXXX', // Stripe Meter ID（用于查余量）
      ref:            { priceId: 'price_XXXXXXX_metered' },
      features:       ['api_access'],
    },

    // ── 6. 额度包（一次买 1000 点，消耗完再买）────────────────
    //    每调用一次 API 消耗 1 点，用 consumeUserCredit() 扣减
    {
      key:          'credits_1000',
      type:         'credit_package',
      creditAmount: 1000,
      ref:          { priceId: 'price_XXXXXXX_credits' },
      features:     ['api_access'],
    },

    // ── 7. 单日通行证（买今天的访问权，非自动续费）───────────
    //    前端传 quantity=N 可买 N 天；isDailyPassActive() 校验有效期
    {
      key:      'daily_pass',
      type:     'daily',
      ref:      { priceId: 'price_XXXXXXX_daily' },
      features: ['pro'],
    },

    // ── 8. 单次试用套餐（只能订阅一次，订阅后不再显示）─────────
    //    用户可能订阅过其他套餐，但只要没订阅过这个套餐就可以购买
    //    试用结束需绑卡自动转正式套餐，trialConvertsTo 指向正式套餐的 planKey
    //    使用流程：新建 Price（如 $0/7天）→ 试用结束 Stripe 自动切换到正式价格
    {
      key:             'first_trial_7d',
      type:            'first_trial',
      trialDays:       7,
      trialConvertsTo: 'pro_monthly',         // 试用结束后的正式套餐
      ref:             { priceId: 'price_XXXXXXX_trial_7d' },
      features:        ['pro'],
    },
  ],

  hooks: {
    // Webhook 触发：checkout 支付成功后落库
    onCheckoutCompleted: async ({ userId, planKey, planType }) => {
      console.log(`[billing] user=${userId} plan=${planKey} type=${planType} paid`);
      // 在这里把订阅/购买写入你自己的数据库
    },

    // Webhook 触发：订阅状态变更（升级/降级/取消/续费）
    onSubscriptionChanged: async ({ userId, planKey, status }) => {
      console.log(`[billing] subscription ${status}: user=${userId} plan=${planKey}`);
    },

    // Webhook 触发：扣款失败
    onPaymentFailed: async ({ userId, invoice }) => {
      console.warn(`[billing] payment failed: user=${userId} invoice=${invoice?.id}`);
    },
  },
});
