import type { CommissionStorage } from './types.js';

/**
 * 结构化兼容 PrismaClient(模型定义见 templates/schema/billing.prisma 佣金部分)。
 * 用 any 换取零依赖:产品侧传入真实 PrismaClient 即可,类型安全由模型模板保证。
 */
export interface PrismaCommissionLike {
  referralCode: any;
  referralRelationship: any;
  commissionRule: any;
  commission: any;
  auditQueueItem: any;
  configurationVersion: any;
  payout: any;
  commissionJob: any;
}

export function prismaCommissionStorage(prisma: PrismaCommissionLike): CommissionStorage {
  return {
    async getReferralCodeByCode(code) {
      return prisma.referralCode.findUnique({ where: { code } });
    },

    async getReferralCodeByUserId(userId) {
      return prisma.referralCode.findUnique({ where: { userId } });
    },

    async insertReferralCode(row) {
      await prisma.referralCode.create({
        data: {
          id: row.id,
          code: row.code,
          userId: row.userId,
          isActive: row.isActive,
          totalInvites: row.totalInvites,
          convertedCount: row.convertedCount,
          createdAt: row.createdAt,
        },
      });
    },

    async setReferralCodeActive(code, isActive) {
      await prisma.referralCode.update({ where: { code }, data: { isActive } });
    },

    async incrementCodeStats(code, field) {
      await prisma.referralCode.update({
        where: { code },
        data: { [field]: { increment: 1 } },
      });
    },

    async getActiveReferrer(refereeUserId) {
      return prisma.referralRelationship.findFirst({
        where: { refereeUserId, status: { in: ['PENDING', 'ACTIVE'] } },
        orderBy: { createdAt: 'desc' },
      });
    },

    async insertRelationship(row) {
      await prisma.referralRelationship.create({
        data: {
          id: row.id,
          referrerUserId: row.referrerUserId,
          refereeUserId: row.refereeUserId,
          originalCode: row.originalCode,
          status: row.status,
          createdAt: row.createdAt,
          activatedAt: row.activatedAt,
          metadata: (row.metadata ?? undefined) as object | undefined,
        },
      });
    },

    async setRelationshipStatus(relationshipId, status, activatedAt) {
      await prisma.referralRelationship.update({
        where: { id: relationshipId },
        data: { status, ...(activatedAt ? { activatedAt } : {}) },
      });
    },

    async listActiveRules(programId) {
      return prisma.commissionRule.findMany({ where: { programId, isActive: true } });
    },

    async insertCommission(row) {
      try {
        await prisma.commission.create({
          data: {
            id: row.id,
            referrerUserId: row.referrerUserId,
            orderId: row.orderId,
            planKey: row.planKey,
            amount: row.amount,
            currency: row.currency,
            rateBreakdown: row.rateBreakdown as unknown as object,
            grantStatus: row.grantStatus,
            tierLevel: row.tierLevel,
            status: row.status,
            reviewStatus: row.reviewStatus,
            validUntil: row.validUntil,
            createdAt: row.createdAt,
          },
        });
        return true;
      } catch (err: any) {
        // P2002 = 唯一约束冲突 [orderId, referrerUserId, tierLevel] → 已计过佣,幂等跳过
        if (err?.code === 'P2002') return false;
        throw err;
      }
    },

    async countMonthlyConversions(referrerUserId, monthStart) {
      return prisma.commission.count({
        where: { referrerUserId, createdAt: { gte: monthStart } },
      });
    },

    async getCommissionById(commissionId) {
      return prisma.commission.findUnique({ where: { id: commissionId } });
    },

    async listCommissionsByOrder(orderId) {
      return prisma.commission.findMany({ where: { orderId } });
    },

    async listCommissionsByReferrer(referrerUserId, opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
      const offset = Math.max(opts?.offset ?? 0, 0);
      return prisma.commission.findMany({
        where: { referrerUserId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      });
    },

    async markCommissionsRefunded(orderId) {
      // Layer 3 单向流转:带前置状态条件的条件更新,PAID 记录不受影响(需人工追回)
      const result = await prisma.commission.updateMany({
        where: { orderId, status: { in: ['PENDING', 'APPROVED'] } },
        data: { status: 'REFUNDED' },
      });
      return result.count;
    },

    async transitionCommissionStatus(commissionId, from, to) {
      // Layer 3 单向流转:updateMany 带前置状态条件(乐观并发控制),count=0 表示状态不符
      const result = await prisma.commission.updateMany({
        where: { id: commissionId, status: { in: from } },
        data: { status: to },
      });
      return result.count > 0;
    },

    async insertAuditQueueItem(row) {
      try {
        await prisma.auditQueueItem.create({
          data: {
            id: row.id,
            commissionId: row.commissionId,
            reason: row.reason,
            riskScore: row.riskScore,
            riskFactors: row.riskFactors as unknown as object,
            status: row.status,
            assignedTo: row.assignedTo,
            reviewedAt: row.reviewedAt,
            reviewNotes: row.reviewNotes,
            createdAt: row.createdAt,
          },
        });
        return true;
      } catch (err: any) {
        // P2002 = commissionId 唯一约束冲突 → 已入队,幂等跳过
        if (err?.code === 'P2002') return false;
        throw err;
      }
    },

    async listAuditQueue(opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
      const offset = Math.max(opts?.offset ?? 0, 0);
      return prisma.auditQueueItem.findMany({
        where: opts?.status ? { status: opts.status } : undefined,
        orderBy: { riskScore: 'desc' },
        take: limit,
        skip: offset,
      });
    },

    async setAuditQueueStatus(commissionId, status, opts) {
      await prisma.auditQueueItem.updateMany({
        where: { commissionId },
        data: {
          status,
          ...(opts?.reviewedAt ? { reviewedAt: opts.reviewedAt } : {}),
          ...(opts?.reviewNotes != null ? { reviewNotes: opts.reviewNotes } : {}),
        },
      });
    },

    async insertConfigVersion(row) {
      try {
        await prisma.configurationVersion.create({
          data: {
            id: row.id,
            programId: row.programId,
            versionNumber: row.versionNumber,
            snapshot: row.snapshot as unknown as object,
            notes: row.notes,
            createdBy: row.createdBy,
            createdAt: row.createdAt,
            activatedAt: row.activatedAt,
            isLatest: row.isLatest,
          },
        });
        return true;
      } catch (err: any) {
        // P2002 = (programId, versionNumber) 唯一约束冲突 → 并发创建,调用方重试
        if (err?.code === 'P2002') return false;
        throw err;
      }
    },

    async getMaxConfigVersionNumber(programId) {
      const latest = await prisma.configurationVersion.findFirst({
        where: { programId },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true },
      });
      return latest?.versionNumber ?? 0;
    },

    async listConfigVersions(programId, opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
      const offset = Math.max(opts?.offset ?? 0, 0);
      return prisma.configurationVersion.findMany({
        where: { programId },
        orderBy: { versionNumber: 'desc' },
        take: limit,
        skip: offset,
      });
    },

    async getConfigVersion(programId, versionNumber) {
      return prisma.configurationVersion.findFirst({ where: { programId, versionNumber } });
    },

    async markConfigVersionActive(programId, versionNumber, activatedAt) {
      await prisma.configurationVersion.updateMany({
        where: { programId },
        data: { isLatest: false },
      });
      await prisma.configurationVersion.updateMany({
        where: { programId, versionNumber },
        data: { isLatest: true, activatedAt },
      });
    },

    async replaceRules(programId, rules) {
      // 回滚应用快照:整体替换该 program 的规则(建议产品侧在事务内调用)
      await prisma.commissionRule.deleteMany({ where: { programId } });
      for (const r of rules) {
        await prisma.commissionRule.create({
          data: {
            id: r.id,
            programId: r.programId,
            planKey: r.planKey,
            triggerScope: r.triggerScope,
            tierLevel: r.tierLevel,
            components: r.components as unknown as object,
            commissionBase: r.commissionBase,
            platformFeeHandlingMode: r.platformFeeHandlingMode,
            holdPeriodDays: r.holdPeriodDays,
            autoApproveUnderCents: r.autoApproveUnderCents,
            requireReviewOverCents: r.requireReviewOverCents,
            isActive: r.isActive,
            priority: r.priority,
          },
        });
      }
    },

    async getReferralStats(referrerUserId, opts) {
      const now = new Date();
      const monthStart = opts?.monthStart ?? new Date(now.getFullYear(), now.getMonth(), 1);
      const [code, activeRelationships, total, pending, paidThisMonth] = await Promise.all([
        prisma.referralCode.findUnique({ where: { userId: referrerUserId } }),
        prisma.referralRelationship.count({
          where: { referrerUserId, status: 'ACTIVE' },
        }),
        prisma.commission.aggregate({
          where: { referrerUserId, status: { in: ['PENDING', 'APPROVED', 'PAID'] } },
          _sum: { amount: true },
        }),
        prisma.commission.aggregate({
          where: { referrerUserId, status: { in: ['PENDING', 'APPROVED'] } },
          _sum: { amount: true },
        }),
        prisma.commission.aggregate({
          where: { referrerUserId, status: 'PAID', createdAt: { gte: monthStart } },
          _sum: { amount: true },
        }),
      ]);
      return {
        totalInvites: code?.totalInvites ?? 0,
        convertedCount: code?.convertedCount ?? 0,
        activeRelationships,
        totalEarningsCents: total._sum?.amount ?? 0,
        pendingCents: pending._sum?.amount ?? 0,
        paidThisMonthCents: paidThisMonth._sum?.amount ?? 0,
      };
    },

    async insertPayout(row) {
      try {
        await prisma.payout.create({
          data: {
            id: row.id,
            referrerUserId: row.referrerUserId,
            commissionIds: row.commissionIds as unknown as object,
            amount: row.amount,
            currency: row.currency,
            feeAmount: row.feeAmount,
            provider: row.provider,
            providerTransactionId: row.providerTransactionId,
            idempotencyKey: row.idempotencyKey,
            status: row.status,
            failureReason: row.failureReason,
            createdAt: row.createdAt,
            processedAt: row.processedAt,
            settledAt: row.settledAt,
          },
        });
        return true;
      } catch (err: any) {
        // P2002 = idempotencyKey 唯一约束冲突 → 重复入账,幂等跳过(Layer 4)
        if (err?.code === 'P2002') return false;
        throw err;
      }
    },

    async getPayout(payoutId) {
      return prisma.payout.findUnique({ where: { id: payoutId } });
    },

    async updatePayoutStatus(payoutId, patch) {
      await prisma.payout.updateMany({
        where: { id: payoutId },
        data: {
          status: patch.status,
          ...(patch.providerTransactionId != null ? { providerTransactionId: patch.providerTransactionId } : {}),
          ...(patch.failureReason != null ? { failureReason: patch.failureReason } : {}),
          ...(patch.processedAt ? { processedAt: patch.processedAt } : {}),
          ...(patch.settledAt ? { settledAt: patch.settledAt } : {}),
        },
      });
    },

    async listPayouts(opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
      const offset = Math.max(opts?.offset ?? 0, 0);
      return prisma.payout.findMany({
        where: {
          ...(opts?.referrerUserId ? { referrerUserId: opts.referrerUserId } : {}),
          ...(opts?.status ? { status: opts.status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      });
    },

    async enqueueJob(row) {
      try {
        await prisma.commissionJob.create({
          data: {
            id: row.id,
            eventId: row.eventId,
            jobType: row.jobType,
            payload: row.payload as unknown as object,
            status: row.status,
            attempts: row.attempts,
            nextRunAt: row.nextRunAt,
            createdAt: row.createdAt,
          },
        });
        return true;
      } catch (err: any) {
        // P2002 = eventId 唯一约束冲突 → webhook 重放,幂等跳过
        if (err?.code === 'P2002') return false;
        throw err;
      }
    },

    async claimDueJobs(limit, now) {
      // 逐个 CAS 领取(updateMany 带前置状态条件),规避 Prisma 无 SKIP LOCKED 的限制
      const due = await prisma.commissionJob.findMany({
        where: { status: 'PENDING', nextRunAt: { lte: now } },
        orderBy: { nextRunAt: 'asc' },
        take: limit,
      });
      const claimed: typeof due = [];
      for (const job of due) {
        const res = await prisma.commissionJob.updateMany({
          where: { id: job.id, status: 'PENDING' },
          data: { status: 'RUNNING' },
        });
        if (res.count > 0) claimed.push({ ...job, status: 'RUNNING' });
      }
      return claimed;
    },

    async markJobDone(jobId) {
      await prisma.commissionJob.updateMany({ where: { id: jobId }, data: { status: 'DONE' } });
    },

    async markJobFailed(jobId, opts) {
      await prisma.commissionJob.updateMany({
        where: { id: jobId },
        data: { status: opts.dead ? 'DEAD' : 'PENDING', attempts: opts.attempts, nextRunAt: opts.nextRunAt },
      });
    },
  };
}
