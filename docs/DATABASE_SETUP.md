# 数据库建表指引（AI 可执行）

## 概述
Billing Kit 需要 **4 张表**存储用户订阅、购买记录和 webhook 事件。所有表使用 `billing_` 前缀隔离，不与产品业务表冲突。

**AI 助手执行建议**：读取产品现有数据库类型（检查 `prisma/schema.prisma` 或环境变量 `DATABASE_URL`），选择对应 SQL 方言执行。

---

## 方案选择

### 1️⃣ PostgreSQL（推荐）

```sql
-- 执行前确认：psql -U 用户名 -d 数据库名

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

CREATE TABLE IF NOT EXISTS billing_events (
  stripe_event_id TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 可选：授予应用用户权限
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO your_app_user;
```

**执行命令**：
```bash
psql -U postgres -d your_database -f templates/schema/billing.sql
```

---

### 2️⃣ MySQL / MariaDB

```sql
-- 执行前确认：mysql -u root -p 数据库名

CREATE TABLE IF NOT EXISTS billing_customers (
  user_id            VARCHAR(255) PRIMARY KEY,
  stripe_customer_id VARCHAR(255) UNIQUE NOT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  stripe_subscription_id VARCHAR(255) PRIMARY KEY,
  user_id                VARCHAR(255) NOT NULL,
  plan_key               VARCHAR(100) NOT NULL,
  status                 VARCHAR(50) NOT NULL,
  current_period_end     TIMESTAMP NULL,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT false,
  raw                    JSON NOT NULL,
  synced_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES billing_customers(user_id),
  INDEX idx_billing_subs_user (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_purchases (
  stripe_session_id VARCHAR(255) PRIMARY KEY,
  user_id           VARCHAR(255) NOT NULL,
  plan_key          VARCHAR(100) NOT NULL,
  amount_total      INT NOT NULL,
  currency          VARCHAR(10) NOT NULL,
  purchased_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_billing_purchases_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_events (
  stripe_event_id VARCHAR(255) PRIMARY KEY,
  type            VARCHAR(100) NOT NULL,
  processed_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**执行命令**：
```bash
mysql -u root -p your_database < templates/schema/billing-mysql.sql
```

---

### 3️⃣ SQLite（本地开发/小型应用）

```sql
CREATE TABLE IF NOT EXISTS billing_customers (
  user_id            TEXT PRIMARY KEY,
  stripe_customer_id TEXT UNIQUE NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES billing_customers(user_id),
  plan_key               TEXT NOT NULL,
  status                 TEXT NOT NULL,
  current_period_end     TEXT,
  cancel_at_period_end   INTEGER NOT NULL DEFAULT 0,
  raw                    TEXT NOT NULL,
  synced_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_billing_subs_user ON billing_subscriptions(user_id, status);

CREATE TABLE IF NOT EXISTS billing_purchases (
  stripe_session_id TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  plan_key          TEXT NOT NULL,
  amount_total      INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  purchased_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_billing_purchases_user ON billing_purchases(user_id);

CREATE TABLE IF NOT EXISTS billing_events (
  stripe_event_id TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  processed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**执行命令**：
```bash
sqlite3 database.db < templates/schema/billing-sqlite.sql
```

---

## 验证建表成功

### PostgreSQL
```sql
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' AND table_name LIKE 'billing_%';
```

### MySQL
```sql
SHOW TABLES LIKE 'billing_%';
```

### SQLite
```sql
.tables billing_%
```

**预期输出**：4 张表 `billing_customers`, `billing_subscriptions`, `billing_purchases`, `billing_events`

---

## 如果使用 Prisma

将 `templates/schema/billing.prisma` 内容合并到项目的 `prisma/schema.prisma`，然后运行：

```bash
npx prisma migrate dev --name add_billing_tables
```

---

## 表结构说明

| 表名 | 用途 | 关键字段 |
|------|------|----------|
| `billing_customers` | Stripe Customer ID 映射 | `user_id` ↔ `stripe_customer_id` |
| `billing_subscriptions` | 订阅状态同步 | `status`（active/canceled/past_due） |
| `billing_purchases` | 一次性购买记录 | `plan_key`, `amount_total` |
| `billing_events` | Webhook 幂等保证 | `stripe_event_id`（唯一约束防重复） |

**外键关系**：`billing_subscriptions.user_id` → `billing_customers.user_id`

---

## AI 助手执行流程建议

1. **检测数据库类型**：
   - 读取 `DATABASE_URL` 或 `prisma/schema.prisma` 的 `provider` 字段
   - 识别 postgresql / mysql / sqlite

2. **选择对应 SQL**：
   - 复制上述对应方案的 SQL 语句

3. **执行建表**：
   - 通过 `db_query` 工具执行 SQL（需要用户提供连接串）
   - 或生成 `.sql` 文件让用户手动执行

4. **验证成功**：
   - 执行验证 SQL 确认 4 张表存在
