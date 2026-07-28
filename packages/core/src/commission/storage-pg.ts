import type { PgLike } from '../storage/pg.js';
import type {
  AuditQueueItemRow,
  CommissionRow,
  CommissionRuleRow,
  CommissionStorage,
  ConfigVersionRow,
  ReferralCodeRow,
  ReferralRelationshipRow,
  ReferralStatsRow,
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

function toCommissionRow(r: any): CommissionRow {
  return {
    id: r.id,
    referrerUserId: r.referrer_user_id,
    orderId: r.order_id,
    planKey: r.plan_key,
    amount: r.amount,
    currency: r.currency,
    rateBreakdown: r.rate_breakdown ?? [],
    grantStatus: r.grant_status,
    tierLevel: r.tier_level,
    status: r.status,
    reviewStatus: r.review_status,
    validUntil: new Date(r.valid_until),
    createdAt: new Date(r.created_at),
  };
}

function toAuditRow(r: any): AuditQueueItemRow {
  return {
    id: r.id,
    commissionId: r.commission_id,
    reason: r.reason,
    riskScore: r.risk_score,
    riskFactors: r.risk_factors ?? [],
    status: r.status,
    assignedTo: r.assigned_to ?? null,
    reviewedAt: r.reviewed_at ? new Date(r.reviewed_at) : null,
    reviewNotes: r.review_notes ?? null,
    createdAt: new Date(r.created_at),
  };
}

function toVersionRow(r: any): ConfigVersionRow {
  return {
    id: r.id,
    programId: r.program_id,
    versionNumber: r.version_number,
    snapshot: r.snapshot ?? { rules: [] },
    notes: r.notes ?? null,
    createdBy: r.created_by ?? null,
    createdAt: new Date(r.created_at),
    activatedAt: r.activated_at ? new Date(r.activated_at) : null,
    isLatest: r.is_latest,
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

    async getCommissionById(commissionId) {
      const { rows } = await db.query(
        `SELECT id, referrer_user_id, order_id, plan_key, amount, currency, rate_breakdown,
                grant_status, tier_level, status, review_status, valid_until, created_at
         FROM commissions WHERE id = $1`,
        [commissionId],
      );
      const row = rows[0];
      return row ? toCommissionRow(row) : null;
    },

    async countMonthlyConversions(referrerUserId, monthStart) {
      const { rows } = await db.query(
        'SELECT COUNT(*)::int AS count FROM commissions WHERE referrer_user_id = $1 AND created_at >= $2',
        [referrerUserId, monthStart],
      );
      return rows[0]?.count ?? 0;
    },

    async listCommissionsByOrder(orderId) {
      const { rows } = await db.query(
        `SELECT id, referrer_user_id, order_id, plan_key, amount, currency, rate_breakdown,
                grant_status, tier_level, status, review_status, valid_until, created_at
         FROM commissions WHERE order_id = $1`,
        [orderId],
      );
      return rows.map(toCommissionRow);
    },

    async listCommissionsByReferrer(referrerUserId, opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
      const offset = Math.max(opts?.offset ?? 0, 0);
      const { rows } = await db.query(
        `SELECT id, referrer_user_id, order_id, plan_key, amount, currency, rate_breakdown,
                grant_status, tier_level, status, review_status, valid_until, created_at
         FROM commissions WHERE referrer_user_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [referrerUserId, limit, offset],
      );
      return rows.map(toCommissionRow);
    },

    async markCommissionsRefunded(orderId) {
      // Layer 3 单向流转:带前置状态条件的条件更新,PAID 记录不受影响(需人工追回)
      const { rowCount } = await db.query(
        `UPDATE commissions SET status = 'REFUNDED'
         WHERE order_id = $1 AND status IN ('PENDING', 'APPROVED')`,
        [orderId],
      );
      return rowCount ?? 0;
    },

    async transitionCommissionStatus(commissionId, from, to) {
      // Layer 3 单向流转:WHERE status = ANY(前置状态) 的乐观并发控制
      const { rowCount } = await db.query(
        'UPDATE commissions SET status = $3 WHERE id = $1 AND status = ANY($2)',
        [commissionId, from, to],
      );
      return (rowCount ?? 0) > 0;
    },

    async insertAuditQueueItem(row) {
      // commission_id 唯一约束:重复入队静默跳过
      const { rowCount } = await db.query(
        `INSERT INTO audit_queue_items
           (id, commission_id, reason, risk_score, risk_factors, status, assigned_to, reviewed_at, review_notes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (commission_id) DO NOTHING`,
        [
          row.id,
          row.commissionId,
          row.reason,
          row.riskScore,
          JSON.stringify(row.riskFactors),
          row.status,
          row.assignedTo,
          row.reviewedAt,
          row.reviewNotes,
          row.createdAt,
        ],
      );
      return (rowCount ?? 0) > 0;
    },

    async listAuditQueue(opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
      const offset = Math.max(opts?.offset ?? 0, 0);
      const where = opts?.status ? 'WHERE status = $3' : '';
      const values: unknown[] = [limit, offset];
      if (opts?.status) values.push(opts.status);
      const { rows } = await db.query(
        `SELECT id, commission_id, reason, risk_score, risk_factors, status,
                assigned_to, reviewed_at, review_notes, created_at
         FROM audit_queue_items ${where}
         ORDER BY risk_score DESC LIMIT $1 OFFSET $2`,
        values,
      );
      return rows.map(toAuditRow);
    },

    async setAuditQueueStatus(commissionId, status, opts) {
      await db.query(
        `UPDATE audit_queue_items
         SET status = $2, reviewed_at = COALESCE($3, reviewed_at), review_notes = COALESCE($4, review_notes)
         WHERE commission_id = $1`,
        [commissionId, status, opts?.reviewedAt ?? null, opts?.reviewNotes ?? null],
      );
    },

    async insertConfigVersion(row) {
      // (program_id, version_number) 唯一约束:并发创建冲突时静默返回 false
      const { rowCount } = await db.query(
        `INSERT INTO configuration_versions
           (id, program_id, version_number, snapshot, notes, created_by, created_at, activated_at, is_latest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (program_id, version_number) DO NOTHING`,
        [
          row.id,
          row.programId,
          row.versionNumber,
          JSON.stringify(row.snapshot),
          row.notes,
          row.createdBy,
          row.createdAt,
          row.activatedAt,
          row.isLatest,
        ],
      );
      return (rowCount ?? 0) > 0;
    },

    async getMaxConfigVersionNumber(programId) {
      const { rows } = await db.query(
        'SELECT COALESCE(MAX(version_number), 0)::int AS max FROM configuration_versions WHERE program_id = $1',
        [programId],
      );
      return rows[0]?.max ?? 0;
    },

    async listConfigVersions(programId, opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
      const offset = Math.max(opts?.offset ?? 0, 0);
      const { rows } = await db.query(
        `SELECT id, program_id, version_number, snapshot, notes, created_by, created_at, activated_at, is_latest
         FROM configuration_versions WHERE program_id = $1
         ORDER BY version_number DESC LIMIT $2 OFFSET $3`,
        [programId, limit, offset],
      );
      return rows.map(toVersionRow);
    },

    async getConfigVersion(programId, versionNumber) {
      const { rows } = await db.query(
        `SELECT id, program_id, version_number, snapshot, notes, created_by, created_at, activated_at, is_latest
         FROM configuration_versions WHERE program_id = $1 AND version_number = $2`,
        [programId, versionNumber],
      );
      const row = rows[0];
      return row ? toVersionRow(row) : null;
    },

    async markConfigVersionActive(programId, versionNumber, activatedAt) {
      await db.query('UPDATE configuration_versions SET is_latest = false WHERE program_id = $1', [programId]);
      await db.query(
        `UPDATE configuration_versions SET is_latest = true, activated_at = $3
         WHERE program_id = $1 AND version_number = $2`,
        [programId, versionNumber, activatedAt],
      );
    },

    async replaceRules(programId, rules) {
      // 回滚应用快照:整体替换该 program 的规则(建议产品侧在事务内调用)
      await db.query('DELETE FROM commission_rules WHERE program_id = $1', [programId]);
      for (const r of rules) {
        await db.query(
          `INSERT INTO commission_rules
             (id, program_id, plan_key, trigger_scope, tier_level, components, commission_base,
              platform_fee_handling_mode, hold_period_days, auto_approve_under_cents,
              require_review_over_cents, is_active, priority)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            r.id,
            r.programId,
            r.planKey,
            r.triggerScope,
            r.tierLevel,
            JSON.stringify(r.components),
            r.commissionBase,
            r.platformFeeHandlingMode,
            r.holdPeriodDays,
            r.autoApproveUnderCents,
            r.requireReviewOverCents,
            r.isActive,
            r.priority,
          ],
        );
      }
    },

    async getReferralStats(referrerUserId, opts) {
      const now = new Date();
      const monthStart = opts?.monthStart ?? new Date(now.getFullYear(), now.getMonth(), 1);
      const [codeRes, relRes, comRes] = await Promise.all([
        db.query('SELECT total_invites, converted_count FROM referral_codes WHERE user_id = $1', [
          referrerUserId,
        ]),
        db.query(
          `SELECT COUNT(*)::int AS count FROM referral_relationships
           WHERE referrer_user_id = $1 AND status = 'ACTIVE'`,
          [referrerUserId],
        ),
        db.query(
          `SELECT
             COALESCE(SUM(amount) FILTER (WHERE status IN ('PENDING', 'APPROVED', 'PAID')), 0)::int AS total_earnings,
             COALESCE(SUM(amount) FILTER (WHERE status IN ('PENDING', 'APPROVED')), 0)::int AS pending,
             COALESCE(SUM(amount) FILTER (WHERE status = 'PAID' AND created_at >= $2), 0)::int AS paid_this_month
           FROM commissions WHERE referrer_user_id = $1`,
          [referrerUserId, monthStart],
        ),
      ]);
      const code = codeRes.rows[0];
      const agg = comRes.rows[0];
      return {
        totalInvites: code?.total_invites ?? 0,
        convertedCount: code?.converted_count ?? 0,
        activeRelationships: relRes.rows[0]?.count ?? 0,
        totalEarningsCents: agg?.total_earnings ?? 0,
        pendingCents: agg?.pending ?? 0,
        paidThisMonthCents: agg?.paid_this_month ?? 0,
      } satisfies ReferralStatsRow;
    },
  };
}