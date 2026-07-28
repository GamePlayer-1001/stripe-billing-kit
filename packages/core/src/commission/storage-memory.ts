/**
 * 内存版 CommissionStorage（测试 / 本地开发用）。
 * 生产环境请实现 CommissionStorage 接口对接 Prisma / pg。
 */
import type {
  AuditQueueItemRow,
  CommissionJobRow,
  CommissionRow,
  CommissionRuleRow,
  CommissionStatus,
  CommissionStorage,
  ConfigVersionRow,
  PayoutRow,
  PayoutStatus,
  QueueStatus,
  ReferralCodeRow,
  ReferralRelationshipRow,
  ReferralStatsRow,
  RelationshipStatus,
} from './types.js';

export class InMemoryCommissionStorage implements CommissionStorage {
  private codes = new Map<string, ReferralCodeRow>();
  private codesByUser = new Map<string, string>(); // userId -> code
  private relationships = new Map<string, ReferralRelationshipRow>();
  private rules: CommissionRuleRow[] = [];
  private commissions = new Map<string, CommissionRow>(); // id -> row
  private commissionKeys = new Set<string>(); // 幂等键 orderId|referrer|tier
  private auditQueue = new Map<string, AuditQueueItemRow>(); // commissionId -> item
  private configVersions: ConfigVersionRow[] = [];
  private payouts = new Map<string, PayoutRow>(); // id -> row
  private payoutIdemKeys = new Set<string>(); // idempotencyKey 唯一
  private jobs = new Map<string, CommissionJobRow>(); // id -> row
  private jobEventIds = new Set<string>(); // eventId 唯一

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
  async listActiveRules(programId: string): Promise<CommissionRuleRow[]> {
    return this.rules.filter((r) => r.isActive && r.programId === programId).map((r) => ({ ...r }));
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
  async getCommissionById(commissionId: string): Promise<CommissionRow | null> {
    const row = this.commissions.get(commissionId);
    return row ? { ...row } : null;
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
  async listCommissionsByReferrer(
    referrerUserId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<CommissionRow[]> {
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;
    return [...this.commissions.values()]
      .filter((c) => c.referrerUserId === referrerUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit)
      .map((c) => ({ ...c }));
  }
  async listCommissionsSince(
    since: Date,
    opts?: { limit?: number; offset?: number },
  ): Promise<CommissionRow[]> {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    // 升序 + id 次序稳定排序，保证审计翻页不漏行
    return [...this.commissions.values()]
      .filter((c) => c.createdAt.getTime() >= since.getTime())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(offset, offset + limit)
      .map((c) => ({ ...c }));
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

  // ── 审核队列 ──
  async insertAuditQueueItem(row: AuditQueueItemRow): Promise<boolean> {
    if (this.auditQueue.has(row.commissionId)) return false; // commissionId 唯一：重复入队跳过
    this.auditQueue.set(row.commissionId, { ...row });
    return true;
  }
  async listAuditQueue(opts?: {
    status?: QueueStatus;
    limit?: number;
    offset?: number;
  }): Promise<AuditQueueItemRow[]> {
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;
    return [...this.auditQueue.values()]
      .filter((i) => !opts?.status || i.status === opts.status)
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(offset, offset + limit)
      .map((i) => ({ ...i }));
  }
  async setAuditQueueStatus(
    commissionId: string,
    status: QueueStatus,
    opts?: { reviewedAt?: Date; reviewNotes?: string },
  ): Promise<void> {
    const item = this.auditQueue.get(commissionId);
    if (!item) return;
    item.status = status;
    if (opts?.reviewedAt) item.reviewedAt = opts.reviewedAt;
    if (opts?.reviewNotes != null) item.reviewNotes = opts.reviewNotes;
  }

  // ── 配置版本 ──
  async insertConfigVersion(row: ConfigVersionRow): Promise<boolean> {
    if (this.configVersions.some((v) => v.programId === row.programId && v.versionNumber === row.versionNumber)) {
      return false; // (programId, versionNumber) 唯一
    }
    this.configVersions.push({ ...row, snapshot: structuredClone(row.snapshot) });
    return true;
  }
  async getMaxConfigVersionNumber(programId: string): Promise<number> {
    return this.configVersions
      .filter((v) => v.programId === programId)
      .reduce((max, v) => Math.max(max, v.versionNumber), 0);
  }
  async listConfigVersions(
    programId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<ConfigVersionRow[]> {
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;
    return this.configVersions
      .filter((v) => v.programId === programId)
      .sort((a, b) => b.versionNumber - a.versionNumber)
      .slice(offset, offset + limit)
      .map((v) => ({ ...v, snapshot: structuredClone(v.snapshot) }));
  }
  async getConfigVersion(programId: string, versionNumber: number): Promise<ConfigVersionRow | null> {
    const v = this.configVersions.find((x) => x.programId === programId && x.versionNumber === versionNumber);
    return v ? { ...v, snapshot: structuredClone(v.snapshot) } : null;
  }
  async markConfigVersionActive(programId: string, versionNumber: number, activatedAt: Date): Promise<void> {
    for (const v of this.configVersions) {
      if (v.programId !== programId) continue;
      v.isLatest = v.versionNumber === versionNumber;
      if (v.isLatest) v.activatedAt = activatedAt;
    }
  }
  async replaceRules(programId: string, rules: CommissionRuleRow[]): Promise<void> {
    this.rules = this.rules.filter((r) => r.programId !== programId).concat(rules.map((r) => ({ ...r })));
  }

  // ── 数据统计 ──
  async getReferralStats(referrerUserId: string, opts?: { monthStart?: Date }): Promise<ReferralStatsRow> {
    const now = new Date();
    const monthStart = opts?.monthStart ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const code = await this.getReferralCodeByUserId(referrerUserId);
    let activeRelationships = 0;
    for (const rel of this.relationships.values()) {
      if (rel.referrerUserId === referrerUserId && rel.status === 'ACTIVE') activeRelationships += 1;
    }
    let totalEarningsCents = 0;
    let pendingCents = 0;
    let paidThisMonthCents = 0;
    for (const c of this.commissions.values()) {
      if (c.referrerUserId !== referrerUserId) continue;
      if (c.status === 'PENDING' || c.status === 'APPROVED') {
        totalEarningsCents += c.amount;
        pendingCents += c.amount;
      } else if (c.status === 'PAID') {
        totalEarningsCents += c.amount;
        if (c.createdAt >= monthStart) paidThisMonthCents += c.amount;
      }
    }
    return {
      totalInvites: code?.totalInvites ?? 0,
      convertedCount: code?.convertedCount ?? 0,
      activeRelationships,
      totalEarningsCents,
      pendingCents,
      paidThisMonthCents,
    };
  }

  // ── 打款记录 ──
  async insertPayout(row: PayoutRow): Promise<boolean> {
    if (this.payoutIdemKeys.has(row.idempotencyKey)) return false; // Layer 4：幂等键冲突
    this.payoutIdemKeys.add(row.idempotencyKey);
    this.payouts.set(row.id, { ...row, commissionIds: [...row.commissionIds] });
    return true;
  }
  async getPayout(payoutId: string): Promise<PayoutRow | null> {
    const row = this.payouts.get(payoutId);
    return row ? { ...row, commissionIds: [...row.commissionIds] } : null;
  }
  async updatePayoutStatus(
    payoutId: string,
    patch: {
      status: PayoutStatus;
      providerTransactionId?: string;
      failureReason?: string;
      processedAt?: Date;
      settledAt?: Date;
    },
  ): Promise<void> {
    const row = this.payouts.get(payoutId);
    if (!row) return;
    row.status = patch.status;
    if (patch.providerTransactionId != null) row.providerTransactionId = patch.providerTransactionId;
    if (patch.failureReason != null) row.failureReason = patch.failureReason;
    if (patch.processedAt) row.processedAt = patch.processedAt;
    if (patch.settledAt) row.settledAt = patch.settledAt;
  }
  async listPayouts(opts?: {
    referrerUserId?: string;
    status?: PayoutStatus;
    limit?: number;
    offset?: number;
  }): Promise<PayoutRow[]> {
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;
    return [...this.payouts.values()]
      .filter((p) => !opts?.referrerUserId || p.referrerUserId === opts.referrerUserId)
      .filter((p) => !opts?.status || p.status === opts.status)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit)
      .map((p) => ({ ...p, commissionIds: [...p.commissionIds] }));
  }

  // ── Outbox 任务 ──
  async enqueueJob(row: CommissionJobRow): Promise<boolean> {
    if (this.jobEventIds.has(row.eventId)) return false; // eventId 唯一：重放不重复入队
    this.jobEventIds.add(row.eventId);
    this.jobs.set(row.id, { ...row });
    return true;
  }
  async claimDueJobs(limit: number, now: Date): Promise<CommissionJobRow[]> {
    const due = [...this.jobs.values()]
      .filter((j) => j.status === 'PENDING' && j.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
      .slice(0, limit);
    for (const j of due) j.status = 'RUNNING'; // 原子领取
    return due.map((j) => ({ ...j }));
  }
  async markJobDone(jobId: string): Promise<void> {
    const j = this.jobs.get(jobId);
    if (j) j.status = 'DONE';
  }
  async markJobFailed(jobId: string, opts: { attempts: number; nextRunAt: Date; dead: boolean }): Promise<void> {
    const j = this.jobs.get(jobId);
    if (!j) return;
    j.attempts = opts.attempts;
    j.nextRunAt = opts.nextRunAt;
    j.status = opts.dead ? 'DEAD' : 'PENDING';
  }

  // ── 测试辅助 ──
  getCommission(id: string): CommissionRow | undefined {
    return this.commissions.get(id);
  }
  allCommissions(): CommissionRow[] {
    return [...this.commissions.values()];
  }
  getAuditItem(commissionId: string): AuditQueueItemRow | undefined {
    return this.auditQueue.get(commissionId);
  }
}
