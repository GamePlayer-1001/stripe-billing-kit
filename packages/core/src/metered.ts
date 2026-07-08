/**
 * metered.ts
 * 按量计费（Stripe Meter）相关操作：
 *   - reportUsage  : 上报一次用量事件（每次消耗时调用）
 *   - getMeterUsage: 查询当前计费周期累计用量
 *
 * Stripe Meter 工作原理：
 *   1. 在 Stripe Dashboard > Billing > Meters 创建一个 Meter，取得 meterEventName
 *   2. PlanDef.meterEventName 对应此 Meter 的 event_name
 *   3. 每次用户消耗资源，调用 reportUsage 上报
 *   4. Stripe 月底按 Meter 汇总值出账
 */
import type { BillingContext } from './config.js';
import { BillingError } from './errors.js';

export interface ReportUsageInput {
  /** 你系统的用户 ID */
  userId: string;
  /** config.plans 中对应的 planKey（metered 类型） */
  planKey: string;
  /** 本次消耗量（正整数，如 token 数、API 调用次数、字节数） */
  value: number;
  /**
   * 事件时间戳（Unix 秒）。
   * 留空表示当前时间；补报历史数据时填实际发生时间
   * （Stripe 允许最多 7 天内的历史事件）。
   */
  timestamp?: number;
  /** 额外维度标签（可选，用于 Stripe Meter 分组分析） */
  dimensions?: Record<string, string>;
}

export interface ReportUsageResult {
  /** Stripe MeterEvent ID */
  eventId: string;
  /** 实际上报的时间戳（Unix 秒） */
  timestamp: number;
}

/**
 * 上报一次用量事件到 Stripe Meter。
 * 每次用户消耗资源（如调用 AI API、发一条消息、下载一份文件）时调用。
 * 幂等：相同 idempotencyKey 的事件 Stripe 只计一次。
 */
export async function reportUsage(
  ctx: BillingContext,
  input: ReportUsageInput,
): Promise<ReportUsageResult> {
  const plan = ctx.plansByKey.get(input.planKey);
  if (!plan) throw new BillingError('invalid_plan', `未知 planKey: ${input.planKey}`);
  if (plan.type !== 'metered') {
    throw new BillingError('config', `planKey ${input.planKey} 不是 metered 类型，不能上报用量`);
  }
  if (!plan.meterEventName) {
    throw new BillingError('config', `planKey ${input.planKey} 未设置 meterEventName`);
  }
  if (!Number.isInteger(input.value) || input.value <= 0) {
    throw new BillingError('invalid_plan', `reportUsage.value 必须是正整数，收到: ${input.value}`);
  }

  const ts = input.timestamp ?? Math.floor(Date.now() / 1000);
  // 幂等 key：用户 + 计划 + 时间桶（秒级），同一秒同一用户不重复计
  const idempotencyKey = `bk:usage:${input.userId}:${plan.key}:${ts}`;

  const event = await ctx.stripe.v2.billing.meterEvents.create(
    {
      event_name: plan.meterEventName,
      payload: {
        value: String(input.value),
        stripe_customer_id: await getCustomerIdForUser(ctx, input.userId),
        ...(input.dimensions ?? {}),
      },
      timestamp: new Date(ts * 1000).toISOString(),
    },
    { idempotencyKey },
  );

  ctx.logger.info('billing.metered.reported', {
    userId: input.userId,
    planKey: input.planKey,
    value: input.value,
    eventId: event.identifier,
    timestamp: ts,
  });

  return { eventId: event.identifier, timestamp: ts };
}

export interface GetMeterUsageInput {
  userId: string;
  planKey: string;
  /** 查询周期起始（ISO string 或 Unix 秒）；不填则取当前订阅周期开始 */
  periodStart?: string | number;
  /** 查询周期结束（ISO string 或 Unix 秒）；不填则取当前时间 */
  periodEnd?: string | number;
}

export interface GetMeterUsageResult {
  /** 周期内累计用量 */
  totalUsage: number;
  periodStart: string;
  periodEnd: string;
}

/**
 * 查询用户在当前计费周期内的累计用量。
 * 用于向用户展示"已用 N/M tokens"之类的用量仪表盘。
 */
export async function getMeterUsage(
  ctx: BillingContext,
  input: GetMeterUsageInput,
): Promise<GetMeterUsageResult> {
  const plan = ctx.plansByKey.get(input.planKey);
  if (!plan) throw new BillingError('invalid_plan', `未知 planKey: ${input.planKey}`);
  if (plan.type !== 'metered') {
    throw new BillingError('config', `planKey ${input.planKey} 不是 metered 类型`);
  }
  if (!plan.meterId) {
    throw new BillingError('config', `planKey ${input.planKey} 未设置 meterId，无法查询用量`);
  }

  const customerId = await getCustomerIdForUser(ctx, input.userId);
  const now = Math.floor(Date.now() / 1000);
  const start = toUnixSec(input.periodStart) ?? (now - 30 * 24 * 3600);
  const end = toUnixSec(input.periodEnd) ?? now;

  const summary = await ctx.stripe.billing.meters.listEventSummaries(plan.meterId, {
    customer: customerId,
    start_time: start,
    end_time: end,
  });

  const totalUsage = summary.data.reduce((acc, s) => acc + s.aggregated_value, 0);

  return {
    totalUsage,
    periodStart: new Date(start * 1000).toISOString(),
    periodEnd: new Date(end * 1000).toISOString(),
  };
}

// ── 内部工具函数 ──────────────────────────────────────────────────────────────

/** 从 storage 拿缓存的 Stripe customer ID（避免每次都打 getOrCreateCustomer） */
async function getCustomerIdForUser(ctx: BillingContext, userId: string): Promise<string> {
  const row = await ctx.storage.getCustomerByUserId(userId);
  if (row) return row.stripeCustomerId;
  // fallback：走完整创建流程
  const { getOrCreateCustomer } = await import('./customers.js');
  return getOrCreateCustomer(ctx, userId);
}

/** 把 ISO string 或 Unix 秒统一转成 Unix 秒 */
function toUnixSec(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return v;
  return Math.floor(new Date(v).getTime() / 1000);
}
