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

-- 配置版本快照（8.2 版本控制）：(program_id, version_number) 唯一，快照 = 当时生效规则集
CREATE TABLE IF NOT EXISTS configuration_versions (
  id             VARCHAR(64)  NOT NULL,
  program_id     VARCHAR(100) NOT NULL,
  version_number INT          NOT NULL,
  snapshot       JSON         NOT NULL COMMENT '{ rules: CommissionRuleRow[] }',
  notes          TEXT         NULL,
  created_by     VARCHAR(255) NULL COMMENT '操作管理员 ID',
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  activated_at   DATETIME(3)  NULL,
  is_latest      TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '当前生效版本（同一 program 至多一个 1）',
  PRIMARY KEY (id),
  UNIQUE KEY uq_config_version (program_id, version_number),
  KEY idx_config_versions_program (program_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 打款记录（4.1 Payout）：付佣腿唯一事实来源；idempotency_key 唯一 = Layer 4 防重复打款
CREATE TABLE IF NOT EXISTS payouts (
  id                      VARCHAR(64)  NOT NULL,
  referrer_user_id        VARCHAR(255) NOT NULL,
  commission_ids          JSON         NOT NULL COMMENT '本次打款覆盖的佣金 ID 列表（批量结算）',
  amount                  INT          NOT NULL COMMENT 'cents（各佣金之和）',
  currency                VARCHAR(10)  NOT NULL,
  fee_amount              INT          NOT NULL DEFAULT 0 COMMENT '通道手续费（如 PayPal $0.25/笔）',
  provider                VARCHAR(30)  NOT NULL COMMENT 'STRIPE_CONNECT / PAYPAL / MANUAL',
  provider_transaction_id VARCHAR(255) NULL COMMENT '通道侧流水号（对账主键）',
  idempotency_key         VARCHAR(64)  NOT NULL COMMENT '= payout.id，防重复打款',
  status                  VARCHAR(20)  NOT NULL DEFAULT 'CREATED' COMMENT 'CREATED/PROCESSING/SUCCEEDED/FAILED/UNCLAIMED/RETURNED',
  failure_reason          TEXT         NULL,
  created_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at            DATETIME(3)  NULL,
  settled_at              DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payout_idem (idempotency_key),
  KEY idx_payouts_referrer (referrer_user_id),
  KEY idx_payouts_status (status),
  KEY idx_payouts_provider_txn (provider, provider_transaction_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Outbox 异步任务（5.4.2 webhook 快速响应）：event_id 唯一，失败指数退避重试
CREATE TABLE IF NOT EXISTS commission_jobs (
  id          VARCHAR(64)  NOT NULL,
  event_id    VARCHAR(255) NOT NULL COMMENT 'Stripe event.id，与 claimEvent 联动',
  job_type    VARCHAR(30)  NOT NULL COMMENT 'CALC_COMMISSION / CLAWBACK / GRANT_PRODUCT / PAYOUT',
  payload     JSON         NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING / RUNNING / DONE / DEAD',
  attempts    INT          NOT NULL DEFAULT 0,
  next_run_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '指数退避重试',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_commission_job_event (event_id),
  KEY idx_commission_jobs_due (status, next_run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
