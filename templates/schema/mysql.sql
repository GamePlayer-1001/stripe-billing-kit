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
