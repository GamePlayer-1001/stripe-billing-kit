import type { StorageAdapter, SubscriptionRow } from './types.js';

/** 结构化兼容 node-postgres 的 Pool/Client,避免对 pg 的硬依赖 */
export interface PgLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/**
 * Postgres 存储实现。建表 SQL 见 templates/schema/billing.sql。
 * 幂等关键点:claimEvent 用 INSERT … ON CONFLICT DO NOTHING 的原子性防重。
 */
export function pgStorage(db: PgLike): StorageAdapter {
  return {
    async getCustomerByUserId(userId) {
      const { rows } = await db.query(
        'SELECT user_id, stripe_customer_id FROM billing_customers WHERE user_id = $1',
        [userId],
      );
      const row = rows[0];
      return row ? { userId: row.user_id, stripeCustomerId: row.stripe_customer_id } : null;
    },

    async getCustomerByStripeCustomerId(stripeCustomerId) {
      const { rows } = await db.query(
        'SELECT user_id, stripe_customer_id FROM billing_customers WHERE stripe_customer_id = $1',
        [stripeCustomerId],
      );
      const row = rows[0];
      return row ? { userId: row.user_id, stripeCustomerId: row.stripe_customer_id } : null;
    },

    async upsertCustomer(row) {
      await db.query(
        `INSERT INTO billing_customers (user_id, stripe_customer_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
        [row.userId, row.stripeCustomerId],
      );
    },

    async claimEvent(eventId, type) {
      const { rowCount } = await db.query(
        'INSERT INTO billing_events (stripe_event_id, type) VALUES ($1, $2) ON CONFLICT (stripe_event_id) DO NOTHING',
        [eventId, type],
      );
      return (rowCount ?? 0) > 0;
    },

    async upsertSubscription(row: SubscriptionRow) {
      await db.query(
        `INSERT INTO billing_subscriptions
           (stripe_subscription_id, user_id, plan_key, status, current_period_end, cancel_at_period_end, raw, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (stripe_subscription_id) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           plan_key = EXCLUDED.plan_key,
           status = EXCLUDED.status,
           current_period_end = EXCLUDED.current_period_end,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           raw = EXCLUDED.raw,
           synced_at = now()`,
        [
          row.stripeSubscriptionId,
          row.userId,
          row.planKey,
          row.status,
          row.currentPeriodEnd,
          row.cancelAtPeriodEnd,
          JSON.stringify(row.raw),
        ],
      );
    },

    async insertPurchase(row) {
      await db.query(
        `INSERT INTO billing_purchases (stripe_session_id, user_id, plan_key, amount_total, currency)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (stripe_session_id) DO NOTHING`,
        [row.stripeSessionId, row.userId, row.planKey, row.amountTotal, row.currency],
      );
    },

    async getEntitlementRows(userId) {
      const [subsRes, purchasesRes] = await Promise.all([
        db.query(
          `SELECT stripe_subscription_id, user_id, plan_key, status, current_period_end, cancel_at_period_end, raw
           FROM billing_subscriptions WHERE user_id = $1`,
          [userId],
        ),
        db.query(
          `SELECT stripe_session_id, user_id, plan_key, amount_total, currency
           FROM billing_purchases WHERE user_id = $1`,
          [userId],
        ),
      ]);
      return {
        subs: subsRes.rows.map((r) => ({
          stripeSubscriptionId: r.stripe_subscription_id,
          userId: r.user_id,
          planKey: r.plan_key,
          status: r.status,
          currentPeriodEnd: r.current_period_end ? new Date(r.current_period_end) : null,
          cancelAtPeriodEnd: r.cancel_at_period_end,
          raw: r.raw,
        })),
        purchases: purchasesRes.rows.map((r) => ({
          stripeSessionId: r.stripe_session_id,
          userId: r.user_id,
          planKey: r.plan_key,
          amountTotal: r.amount_total,
          currency: r.currency,
        })),
      };
    },
  };
}
