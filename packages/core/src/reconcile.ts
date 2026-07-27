/**
 * reconcile.ts
 * 对账兜底(FR-17):全量比对 Stripe 与本地订阅状态,修复 webhook 丢失导致的漂移。
 *
 * 原理:遍历 billing_customers 全表,对每个 stripeCustomerId 调 syncStripeToDb()
 * (单一状态写入口,幂等)。Stripe 是唯一事实源,所以"对账"即"重新同步"。
 *
 * 用法(产品侧挂 cron,如每天凌晨一次):
 *   const report = await reconcile(config);
 *   // { customers: 120, synced: 119, failed: 1, durationMs: 8321 }
 */
import type { BillingContext } from './config.js';
import { BillingError } from './errors.js';
import { syncStripeToDb } from './sync.js';

export interface ReconcileOptions {
  /** 每页从存储层取多少个 customer,默认 100 */
  pageSize?: number;
  /** 相邻两个 customer 同步之间的间隔毫秒数,默认 50(控制 Stripe API 调用节奏) */
  delayMs?: number;
  /** 每同步完一个 customer 回调一次(可挂进度上报) */
  onProgress?: (done: number, failed: number) => void;
}

export interface ReconcileReport {
  /** 扫描的 customer 总数 */
  customers: number;
  /** 成功同步数 */
  synced: number;
  /** 失败数(单个失败不中断全局,详情看日志) */
  failed: number;
  durationMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 全量对账。可重复调用(幂等);单个 customer 失败只记日志不中断。
 * 要求 storage 实现可选方法 listCustomers(内置 pg/prisma/memory 均已实现)。
 */
export async function reconcile(ctx: BillingContext, options?: ReconcileOptions): Promise<ReconcileReport> {
  if (!ctx.storage.listCustomers) {
    throw new BillingError('config', 'storage 未实现 listCustomers,无法执行 reconcile(内置 pg/prisma/memory 存储均支持,自定义存储请补实现)');
  }

  const pageSize = options?.pageSize ?? 100;
  const delayMs = options?.delayMs ?? 50;
  const startedAt = Date.now();

  let customers = 0;
  let synced = 0;
  let failed = 0;
  let offset = 0;

  ctx.logger.info('billing.reconcile.started', { pageSize, delayMs });

  for (;;) {
    const page = await ctx.storage.listCustomers(pageSize, offset);
    if (!page.length) break;
    offset += page.length;

    for (const customer of page) {
      customers += 1;
      try {
        await syncStripeToDb(ctx, customer.stripeCustomerId);
        synced += 1;
      } catch (err) {
        failed += 1;
        ctx.logger.error('billing.reconcile.customer_failed', {
          userId: customer.userId,
          stripeCustomerId: customer.stripeCustomerId,
          err: String(err),
        });
      }
      options?.onProgress?.(synced, failed);
      if (delayMs > 0) await sleep(delayMs);
    }

    // 最后一页(不满一页)→ 不用再翻
    if (page.length < pageSize) break;
  }

  const report: ReconcileReport = { customers, synced, failed, durationMs: Date.now() - startedAt };
  ctx.logger.info('billing.reconcile.done', { ...report });
  return report;
}
