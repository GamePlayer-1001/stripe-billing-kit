/**
 * billing.config.ts 模板 —— 复制到产品根目录后按「套餐信息表」修改 plans。
 * 这是产品接入 Stripe Billing Kit 时唯一需要编写的配置文件。
 * 字段说明见 docs/ARCHITECTURE.md 第 3 节;接入步骤见 docs/INTEGRATION.md。
 */
import type { BillingConfig } from '@billing-kit/core';
import { pgStorage } from '@billing-kit/core/storage/pg';
// import { prismaStorage } from '@billing-kit/core/storage/prisma';
import { pool } from './src/lib/db'; // ← 换成产品自己的数据库实例

export const billingConfig: BillingConfig = {
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!,
  },

  // ── 套餐声明:每行对应所有者交接卡「套餐信息表」的一行 ──
  // key      = 产品内部稳定标识,业务代码只认它
  // ref      = 优先 { lookupKey },所有者只给了 price_id 时用 { priceId }
  // features = 该套餐解锁的能力标签,配合 hasAccess(userId, feature) 使用
  plans: [
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
  // storage: prismaStorage(prisma),

  // ── 以下全部可选 ──
  // catalogTtlSeconds: 600,
  // logger: console,
  // hooks: {
  //   onPaymentFailed: async ({ userId, invoice }) => { /* 发提醒邮件 */ },
  //   onSubscriptionCanceled: async ({ userId }) => { /* 挽留流程 */ },
  // },
};
