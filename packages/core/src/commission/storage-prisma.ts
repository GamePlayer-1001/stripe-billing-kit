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

    async listCommissionsByOrder(orderId) {
      return prisma.commission.findMany({ where: { orderId } });
    },

    async markCommissionsRefunded(orderId) {
      // Layer 3 单向流转:带前置状态条件的条件更新,PAID 记录不受影响(需人工追回)
      const result = await prisma.commission.updateMany({
        where: { orderId, status: { in: ['PENDING', 'APPROVED'] } },
        data: { status: 'REFUNDED' },
      });
      return result.count;
    },
  };
}
