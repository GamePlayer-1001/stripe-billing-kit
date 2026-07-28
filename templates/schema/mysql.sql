-- Stripe Billing Kit 建表模板 (MySQL 8.0+)
-- 4 张表全部以 billing_ 前缀隔离，不与产品业务表冲突。
-- 执行方式：mysql -u 用户名 -p 数据库名 < mysql.sql

CREATE TABLE IF NOT EXISTS billing_customers (
  user_id            VARCHAR(255) NOT NULL,
  stripe_customer_id VARCHAR(255) NOT NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_billing_customers_stripe_id (stripe_customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  stripe_subscription_id VARCHAR(255) NOT NULL,
  user_id                VARCHAR(255) NOT NULL,
  plan_key               VARCHAR(255) NOT NULL,
  status                 VARCHAR(64)  NOT NULL,
  current_period_end     DATETIME(3)  NULL,
  cancel_at_period_end   TINYINT(1)   NOT NULL DEFAULT 0,
  raw                    JSON         NOT NULL,
  synced_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (stripe_subscription_id),
  KEY idx_billing_subs_user_status (user_id, status),
  CONSTRAINT fk_billing_subs_customer
    FOREIGN KEY (user_id) REFERENCES billing_customers(user_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_purchases (
  stripe_session_id VARCHAR(255) NOT NULL,
  user_id           VARCHAR(255) NOT NULL,
  plan_key          VARCHAR(255) NOT NULL,
  amount_total      INT          NOT NULL COMMENT '单位为分（cents）',
  currency          VARCHAR(8)   NOT NULL,
  purchased_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (stripe_session_id),
  KEY idx_billing_purchases_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- webhook 幂等表：event.id 唯一约束是防重复处理的原子锁
CREATE TABLE IF NOT EXISTS billing_events (
  stripe_event_id VARCHAR(255) NOT NULL,
  type            VARCHAR(128) NOT NULL,
  processed_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (stripe_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ══════════════════════════════════════════════════════
-- 佣金模块（可选：未启用 commission 时无需建以下 4 张表）
-- 搭配 prismaCommissionStorage（Prisma on MySQL）使用
-- ══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS referral_codes (
  id              VARCHAR(64)  NOT NULL,
  code            VARCHAR(50)  NOT NULL,
  user_id         VARCHAR(255) NOT NULL,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  total_invites   INT          NOT NULL DEFAULT 0,
  converted_count INT          NOT NULL DEFAULT 0,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_referral_codes_code (code),
  UNIQUE KEY uq_referral_codes_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS referral_relationships (
  id               VARCHAR(64)  NOT NULL,
  referrer_user_id VARCHAR(255) NOT NULL,
  referee_user_id  VARCHAR(255) NOT NULL,
  original_code    VARCHAR(50)  NOT NULL,
  status           VARCHAR(20)  NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING/ACTIVE/EXPIRED/TERMINATED',
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  activated_at     DATETIME(3)  NULL,
  metadata         JSON         NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_referral_relationship (referrer_user_id, referee_user_id),
  KEY idx_relationships_referee (referee_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS commission_rules (
  id                         VARCHAR(64)  NOT NULL,
  program_id                 VARCHAR(64)  NOT NULL,
  plan_key                   VARCHAR(100) NULL COMMENT 'NULL = 全局适用',
  trigger_scope              VARCHAR(30)  NOT NULL DEFAULT 'FIRST_PAYMENT',
  tier_level                 INT          NULL COMMENT 'NULL = 所有层级',
  components                 JSON         NOT NULL COMMENT 'RewardComponent[] 组件数组',
  commission_base            VARCHAR(20)  NOT NULL DEFAULT 'NET_BASED',
  platform_fee_handling_mode VARCHAR(30)  NOT NULL DEFAULT 'CONSUMED_BY_PLATFORM',
  hold_period_days           INT          NOT NULL DEFAULT 30,
  auto_approve_under_cents   INT          NULL,
  require_review_over_cents  INT          NULL,
  is_active                  TINYINT(1)   NOT NULL DEFAULT 1,
  priority                   INT          NOT NULL DEFAULT 0,
  created_at                 DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_commission_rules_program (program_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 幂等键 (order_id, referrer_user_id, tier_level)：webhook 重放/并发投递时数据库层拦截重复计佣
CREATE TABLE IF NOT EXISTS commissions (
  id               VARCHAR(64)  NOT NULL,
  referrer_user_id VARCHAR(255) NOT NULL,
  order_id         VARCHAR(255) NOT NULL,
  plan_key         VARCHAR(100) NOT NULL,
  amount           INT          NOT NULL COMMENT '现金佣金合计（cents）',
  currency         VARCHAR(8)   NOT NULL,
  rate_breakdown   JSON         NULL COMMENT '组件计算明细快照（审计回溯）',
  grant_status     VARCHAR(20)  NOT NULL DEFAULT 'NOT_APPLICABLE',
  tier_level       INT          NOT NULL DEFAULT 1,
  status           VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  review_status    VARCHAR(20)  NOT NULL DEFAULT 'AUTO_APPROVED',
  valid_until      DATETIME(3)  NOT NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_commission (order_id, referrer_user_id, tier_level),
  KEY idx_commissions_referrer (referrer_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 人工审核队列（7.1 Level 2）：commission_id 唯一，重复入队由唯一约束拦截
CREATE TABLE IF NOT EXISTS audit_queue_items (
  id            VARCHAR(64)  NOT NULL,
  commission_id VARCHAR(64)  NOT NULL,
  reason        VARCHAR(30)  NOT NULL COMMENT 'HIGH_AMOUNT / RAPID_GROWTH / SAME_DEVICE / ...',
  risk_score    INT          NOT NULL DEFAULT 0 COMMENT '0-100',
  risk_factors  JSON         NULL COMMENT '["high_amount", "temp_email"]',
  status        VARCHAR(20)  NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING / IN_PROGRESS / APPROVED / REJECTED / ESCALATED',
  assigned_to   VARCHAR(255) NULL,
  reviewed_at   DATETIME(3)  NULL,
  review_notes  TEXT         NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_commission (commission_id),
  KEY idx_audit_queue_status (status, risk_score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
