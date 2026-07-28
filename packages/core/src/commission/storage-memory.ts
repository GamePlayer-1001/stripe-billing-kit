/**
 * 内存版 CommissionStorage（测试 / 本地开发用）。
 * 生产环境请实现 CommissionStorage 接口对接 Prisma / pg。
 */
import type {
  CommissionRow,
  CommissionRuleRow,
  CommissionStatus,
  CommissionStorage,
  ReferralCodeRow,
  ReferralRelationshipRow,
  RelationshipStatus,
} from './types.js';

export class InMemoryCommissionStorage implements CommissionStorage {
  private codes = new Map<string, ReferralCodeRow>();
  private codesByUser = new Map<string, string>(); // userId -> code
  private relationships = new Map<string, ReferralRelationshipRow>();
  private rules: CommissionRuleRow[] = [];
  private commissions = new Map<string, CommissionRow>(); // id -> row
  private commissionKeys = new Set<string>(); // 幂等键 orderId|referrer|tier

  // ── 邀请码 ──
  async getReferralCodeByCode(code: string): Promise<ReferralCodeRow | null> {
    return this.codes.get(code) ?? null;
  }
  async getReferralCodeByUserId(userId: string): Promise<ReferralCodeRow | null> {
    const code = this.codesByUser.get(userId);
    return code ? this.codes.get(code) ?? null : null;
  }
  async insertReferralCode(row: ReferralCodeRow): Promise<void> {
    this.codes.set(row.code, { ...row });
    this.codesByUser.set(row.userId, row.code);
  }
  async setReferralCodeActive(code: string, isActive: boolean): Promise<void> {
    const row = this.codes.get(code);
    if (row) row.isActive = isActive;
  }
  async incrementCodeStats(code: string, field: 'totalInvites' | 'convertedCount'): Promise<void> {
    const row = this.codes.get(code);
    if (row) row[field] += 1;
  }

  // ── 邀请关系 ──
  async getActiveReferrer(refereeUserId: string): Promise<ReferralRelationshipRow | null> {
    for (const rel of this.relationships.values()) {
      if (rel.refereeUserId === refereeUserId && (rel.status === 'PENDING' || rel.status === 'ACTIVE')) {
        return { ...rel };
      }
    }
    return null;
  }
  async insertRelationship(row: ReferralRelationshipRow): Promise<void> {
    this.relationships.set(row.id, { ...row });
  }
  async setRelationshipStatus(
    relationshipId: string,
    status: RelationshipStatus,
    activatedAt?: Date,
  ): Promise<void> {
    const rel = this.relationships.get(relationshipId);
    if (!rel) return;
    rel.status = status;
    if (activatedAt) rel.activatedAt = activatedAt;
  }

  // ── 佣金规则 ──
  async listActiveRules(): Promise<CommissionRuleRow[]> {
    return this.rules.filter((r) => r.isActive).map((r) => ({ ...r }));
  }
  /** 测试辅助：注入规则 */
  addRule(rule: CommissionRuleRow): void {
    this.rules.push(rule);
  }

  // ── 佣金记录 ──
  async insertCommission(row: CommissionRow): Promise<boolean> {
    const key = `${row.orderId}|${row.referrerUserId}|${row.tierLevel}`;
    if (this.commissionKeys.has(key)) return false; // 幂等：已计过佣
    this.commissionKeys.add(key);
    this.commissions.set(row.id, { ...row });
    return true;
  }
  async countMonthlyConversions(referrerUserId: string, monthStart: Date): Promise<number> {
    let count = 0;
    for (const rel of this.relationships.values()) {
      if (
        rel.referrerUserId === referrerUserId &&
        rel.status === 'ACTIVE' &&
        rel.activatedAt &&
        rel.activatedAt >= monthStart
      ) {
        count += 1;
      }
    }
    return count;
  }
  async listCommissionsByOrder(orderId: string): Promise<CommissionRow[]> {
    return [...this.commissions.values()].filter((c) => c.orderId === orderId).map((c) => ({ ...c }));
  }
  async markCommissionsRefunded(orderId: string): Promise<number> {
    let count = 0;
    for (const c of this.commissions.values()) {
      // Layer 3 单向流转：只回转 PENDING/APPROVED，PAID 需人工追回
      if (c.orderId === orderId && (c.status === 'PENDING' || c.status === 'APPROVED')) {
        c.status = 'REFUNDED';
        count += 1;
      }
    }
    return count;
  }
  async transitionCommissionStatus(
    commissionId: string,
    from: CommissionStatus[],
    to: CommissionStatus,
  ): Promise<boolean> {
    const c = this.commissions.get(commissionId);
    if (!c || !from.includes(c.status)) return false;
    c.status = to;
    return true;
  }

  // ── 测试辅助 ──
  getCommission(id: string): CommissionRow | undefined {
    return this.commissions.get(id);
  }
  allCommissions(): CommissionRow[] {
    return [...this.commissions.values()];
  }
}
