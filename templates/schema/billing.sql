-- Stripe Billing Kit 建表模板(Postgres)
-- 4 张表全部以 billing_ 前缀隔离,不与产品业务表冲突。

CREATE TABLE IF NOT EXISTS billing_customers (
  user_id            TEXT PRIMARY KEY,
  stripe_customer_id TEXT UNIQUE NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES billing_customers(user_id),
  plan_key               TEXT NOT NULL,
  status                 TEXT NOT NULL,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT false,
  raw                    JSONB NOT NULL,
  synced_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_subs_user ON billing_subscriptions(user_id, status);

CREATE TABLE IF NOT EXISTS billing_purchases (
  stripe_session_id TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  plan_key          TEXT NOT NULL,
  amount_total      INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  purchased_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_purchases_user ON billing_purchases(user_id);

-- webhook 幂等表:event.id 唯一约束是防重复处理的原子锁
CREATE TABLE IF NOT EXISTS billing_events (
  stripe_event_id TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
