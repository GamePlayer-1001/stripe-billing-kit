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

-- ══════════════════════════════════════════════════════
-- 佣金模块（可选:未启用 commission 时无需建以下 4 张表）
-- 适配 pgCommissionStorage,详见 docs/COMMISSION-SYSTEM-SPEC.md 4.2
-- ══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS referral_codes (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  user_id         TEXT NOT NULL UNIQUE,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  total_invites   INTEGER NOT NULL DEFAULT 0,
  converted_count INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referral_relationships (
  id               TEXT PRIMARY KEY,
  referrer_user_id TEXT NOT NULL,
  referee_user_id  TEXT NOT NULL,
  original_code    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING/ACTIVE/EXPIRED/TERMINATED
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at     TIMESTAMPTZ,
  metadata         JSONB,
  CONSTRAINT uq_referral_relationship UNIQUE (referrer_user_id, referee_user_id)
);
CREATE INDEX IF NOT EXISTS idx_relationships_referee ON referral_relationships(referee_user_id, status);

CREATE TABLE IF NOT EXISTS commission_rules (
  id                          TEXT PRIMARY KEY,
  program_id                  TEXT NOT NULL,
  plan_key                    TEXT,                  -- NULL = 全局适用
  trigger_scope               TEXT NOT NULL DEFAULT 'FIRST_PAYMENT',
  tier_level                  INTEGER,               -- NULL = 所有层级
  components                  JSONB NOT NULL,        -- RewardComponent[] 组件数组
  commission_base             TEXT NOT NULL DEFAULT 'NET_BASED',
  platform_fee_handling_mode  TEXT NOT NULL DEFAULT 'CONSUMED_BY_PLATFORM',
  hold_period_days            INTEGER NOT NULL DEFAULT 30,
  auto_approve_under_cents    INTEGER,
  require_review_over_cents   INTEGER,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  priority                    INTEGER NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commission_rules_program ON commission_rules(program_id, is_active);

-- 幂等键 (order_id, referrer_user_id, tier_level):webhook 重放/并发投递时数据库层拦截重复计佣
CREATE TABLE IF NOT EXISTS commissions (
  id               TEXT PRIMARY KEY,
  referrer_user_id TEXT NOT NULL,
  order_id         TEXT NOT NULL,
  plan_key         TEXT NOT NULL,
  amount           INTEGER NOT NULL,               -- 现金佣金合计(cents)
  currency         TEXT NOT NULL,
  rate_breakdown   JSONB,                          -- 组件计算明细快照（审计回溯）
  grant_status     TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
  tier_level       INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'PENDING',
  review_status    TEXT NOT NULL DEFAULT 'AUTO_APPROVED',
  valid_until      TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commission UNIQUE (order_id, referrer_user_id, tier_level)
);
CREATE INDEX IF NOT EXISTS idx_commissions_referrer ON commissions(referrer_user_id, status);

-- 人工审核队列(7.1 Level 2):commission_id 唯一,重复入队由 ON CONFLICT 拦截
CREATE TABLE IF NOT EXISTS audit_queue_items (
  id            TEXT PRIMARY KEY,
  commission_id TEXT NOT NULL UNIQUE,
  reason        TEXT NOT NULL,                     -- HIGH_AMOUNT / RAPID_GROWTH / SAME_DEVICE / ...
  risk_score    INTEGER NOT NULL DEFAULT 0,        -- 0-100
  risk_factors  JSONB,                             -- ["high_amount", "temp_email"]
  status        TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING / IN_PROGRESS / APPROVED / REJECTED / ESCALATED
  assigned_to   TEXT,
  reviewed_at   TIMESTAMPTZ,
  review_notes  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_queue_status ON audit_queue_items(status, risk_score DESC);
