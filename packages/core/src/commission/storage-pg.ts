import type { PgLike } from '../storage/pg.js';
import type {
  CommissionRuleRow,
  CommissionStorage,
  ReferralCodeRow,
  ReferralRelationshipRow,
} from './types.js';

/** 行映射:snake_case → camelCase(jsonb 列 pg 已自动反序列化) */
function toCodeRow(r: any): ReferralCodeRow {
  return {
    id: r.id,
    code: r.code,
    userId: r.user_id,
    isActive: r.is_active,
    totalInvites: r.total_invites,
    convertedCount: r.converted_count,
    createdAt: new Date(r.created_at),
  };
}

function toRelationshipRow(r: any): ReferralRelationshipRow {
  return {
    id: r.id,
    referrerUserId: r.referrer_user_id,
    refereeUserId: r.referee_user_id,
    originalCode: r.original_code,
    status: r.status,
    createdAt: new Date(r.created_at),
    activatedAt: r.activated_at ? new Date(r.activated_at) : null,
    metadata: r.metadata ?? undefined,
  };
}

function toRuleRow(r: any): CommissionRuleRow {
  return {
    id: r.id,
    programId: r.program_id,
    planKey: r.plan_key,
    triggerScope: r.trigger_scope,
    tierLevel: r.tier_level,
    components: r.components,
    commissionBase: r.commission_base,
    platformFeeHandlingMode: r.platform_fee_handling_mode,
    holdPeriodDays: r.hold_period_days,
    autoApproveUnderCents: r.auto_approve_under_cents,
    requireReviewOverCents: r.require_review_over_cents,
    isActive: r.is_active,
    priority: r.priority,
  };
}

/**
 * Postgres 佣金存储实现。建表 SQL 见 templates/schema/billing.sql 佣金部分。
 * 幂等关键点:insertCommission 用 ON CONFLICT (order_id, referrer_user_id, tier_level)
 * DO NOTHING 在数据库层拦截重复计佣(webhook 重放/并发投递)。
 */
export function pgCommissionStorage(db: PgLike): CommissionStorage {
  return {
    async getReferralCodeByCode(code) {
      const { rows } = await db.query(
        'SELECT id, code, user_id, is_active, total_invites, converted_count, created_at FROM referral_codes WHERE code = $1',
        [code],
      );
      const row = rows[0];
      return row ? toCodeRow(row) : null;
    },

    async getReferralCodeByUserId(userId) {
      const { rows } = await db.query(
        'SELECT id, code, user_id, is_active, total_invites, converted_count, created_at FROM referral_codes WHERE user_id = $1',
        [userId],
      );
      const row = rows[0];
      return row ? toCodeRow(row) : null;
    },

    async insertReferralCode(row) {
      await db.query(
        `INSERT INTO referral_codes (id, code, user_id, is_active, total_invites, converted_count, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.id, row.code, row.userId, row.isActive, row.totalInvites, row.convertedCount, row.createdAt],
      );
    },

    async setReferralCodeActive(code, isActive) {
      await db.query('UPDATE referral_codes SET is_active = $2, updated_at = now() WHERE code = $1', [
        code,
        isActive,
      ]);
    },

    async incrementCodeStats(code, field) {
      // 列名白名单映射,禁止拼接外部输入
      const column = field === 'totalInvites' ? 'total_invites' : 'converted_count';
      await db.query(
        `UPDATE referral_codes SET ${column} = ${column} + 1, updated_at = now() WHERE code = $1`,
        [code],
      );
    },

    async getActiveReferrer(refereeUserId) {
      const { rows } = await db.query(
        `SELECT id, referrer_user_id, referee_user_id, original_code, status, created_at, activated_at, metadata
         FROM referral_relationships
         WHERE referee_user_id = $1 AND status IN ('PENDING', 'ACTIVE')
         ORDER BY created_at DESC LIMIT 1`,
        [refereeUserId],
      );
      const row = rows[0];
      return row ? toRelationshipRow(row) : null;
    },

    async insertRelationship(row) {
      await db.query(
        `INSERT INTO referral_relationships
           (id, referrer_user_id, referee_user_id, original_code, status, created_at, activated_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.id,
          row.referrerUserId,
          row.refereeUserId,
          row.originalCode,
          row.status,
          row.createdAt,
          row.activatedAt,
          row.metadata ? JSON.stringify(row.metadata) : null,
        ],
      );
    },

    async setRelationshipStatus(relationshipId, status, activatedAt) {
      await db.query(
        'UPDATE referral_relationships SET status = $2, activated_at = COALESCE($3, activated_at) WHERE id = $1',
        [relationshipId, status, activatedAt ?? null],
      );
    },

    async listActiveRules(programId) {
      const { rows } = await db.query(
        `SELECT id, program_id, plan_key, trigger_scope, tier_level, components, commission_base,
                platform_fee_handling_mode, hold_period_days, auto_approve_under_cents,
                require_review_over_cents, is_active, priority
         FROM commission_rules
         WHERE program_id = $1 AND is_active = true`,
        [programId],
      );
      return rows.map(toRuleRow);
    },

    async insertCommission(row) {
      const { rowCount } = await db.query(
        `INSERT INTO commissions
           (id, referrer_user_id, order_id, plan_key, amount, currency, rate_breakdown,
            grant_status, tier_level, status, review_status, valid_until, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (order_id, referrer_user_id, tier_level) DO NOTHING`,
        [
          row.id,
          row.referrerUserId,
          row.orderId,
          row.planKey,
          row.amount,
          row.currency,
          JSON.stringify(row.rateBreakdown),
          row.grantStatus,
          row.tierLevel,
          row.status,
          row.reviewStatus,
          row.validUntil,
          row.createdAt,
        ],
      );
      return (rowCount ?? 0) > 0;
    },

    async countMonthlyConversions(referrerUserId, monthStart) {
      const { rows } = await db.query(
        'SELECT COUNT(*)::int AS count FROM commissions WHERE referrer_user_id = $1 AND created_at >= $2',
        [referrerUserId, monthStart],
      );
      return rows[0]?.count ?? 0;
    },
  };
}
