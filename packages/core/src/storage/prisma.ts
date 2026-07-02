import type { StorageAdapter } from './types.js';

/**
 * 结构化兼容 PrismaClient(模型定义见 templates/schema/billing.prisma)。
 * 用 any 换取零依赖:产品侧传入真实 PrismaClient 即可,类型安全由模型模板保证。
 */
export interface PrismaLike {
  billingCustomer: any;
  billingSubscription: any;
  billingPurchase: any;
  billingEvent: any;
}

export function prismaStorage(prisma: PrismaLike): StorageAdapter {
  return {
    async getCustomerByUserId(userId) {
      const row = await prisma.billingCustomer.findUnique({ where: { userId } });
      return row ? { userId: row.userId, stripeCustomerId: row.stripeCustomerId } : null;
    },

    async getCustomerByStripeCustomerId(stripeCustomerId) {
      const row = await prisma.billingCustomer.findUnique({ where: { stripeCustomerId } });
      return row ? { userId: row.userId, stripeCustomerId: row.stripeCustomerId } : null;
    },

    async upsertCustomer(row) {
      await prisma.billingCustomer.upsert({
        where: { userId: row.userId },
        create: { userId: row.userId, stripeCustomerId: row.stripeCustomerId },
        update: { stripeCustomerId: row.stripeCustomerId },
      });
    },

    async claimEvent(eventId, type) {
      try {
        await prisma.billingEvent.create({ data: { stripeEventId: eventId, type } });
        return true;
      } catch (err: any) {
        // P2002 = Prisma 唯一约束冲突 → 重复事件
        if (err?.code === 'P2002') return false;
        throw err;
      }
    },

    async upsertSubscription(row) {
      const data = {
        userId: row.userId,
        planKey: row.planKey,
        status: row.status,
        currentPeriodEnd: row.currentPeriodEnd,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        raw: row.raw as object,
        syncedAt: new Date(),
      };
      await prisma.billingSubscription.upsert({
        where: { stripeSubscriptionId: row.stripeSubscriptionId },
        create: { stripeSubscriptionId: row.stripeSubscriptionId, ...data },
        update: data,
      });
    },

    async insertPurchase(row) {
      try {
        await prisma.billingPurchase.create({
          data: {
            stripeSessionId: row.stripeSessionId,
            userId: row.userId,
            planKey: row.planKey,
            amountTotal: row.amountTotal,
            currency: row.currency,
          },
        });
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err; // 幂等:重复插入静默忽略
      }
    },

    async getEntitlementRows(userId) {
      const [subs, purchases] = await Promise.all([
        prisma.billingSubscription.findMany({ where: { userId } }),
        prisma.billingPurchase.findMany({ where: { userId } }),
      ]);
      return {
        subs: subs.map((r: any) => ({
          stripeSubscriptionId: r.stripeSubscriptionId,
          userId: r.userId,
          planKey: r.planKey,
          status: r.status,
          currentPeriodEnd: r.currentPeriodEnd,
          cancelAtPeriodEnd: r.cancelAtPeriodEnd,
          raw: r.raw,
        })),
        purchases: purchases.map((r: any) => ({
          stripeSessionId: r.stripeSessionId,
          userId: r.userId,
          planKey: r.planKey,
          amountTotal: r.amountTotal,
          currency: r.currency,
        })),
      };
    },
  };
}
