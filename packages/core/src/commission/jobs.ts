/**
 * Outbox 异步任务处理（5.4.2 webhook 快速响应模式）。
 *
 * 模式：webhook 收到事件后只做 enqueueJob（<100ms 内 200 响应），
 * 重活（计佣/追回/发放/打款）由轮询 worker 领取执行。
 * MVP 采用 DB outbox 表 + 轮询即可，无需引入消息队列。
 *
 * 幂等：eventId 唯一约束（与 claimEvent 联动）→ Stripe 重放不重复入队；
 * 失败指数退避重试，超过上限标记 DEAD 待人工介入。
 */
import { randomUUID } from 'node:crypto';
import type { BillingLogger } from '../config.js';
import type { CommissionJobRow, CommissionJobType, CommissionStorage } from './types.js';

/** 各类型任务的处理函数表（缺失类型的任务按失败重试处理） */
export type CommissionJobHandlers = Partial<
  Record<CommissionJobType, (payload: Record<string, unknown>) => Promise<void>>
>;

export interface EnqueueCommissionJobInput {
  /** Stripe event.id（幂等键） */
  eventId: string;
  jobType: CommissionJobType;
  payload: Record<string, unknown>;
  now?: Date;
}

/** 入队 Outbox 任务；eventId 冲突（重放）返回 false */
export async function enqueueCommissionJob(
  storage: CommissionStorage,
  input: EnqueueCommissionJobInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return storage.enqueueJob({
    id: randomUUID(),
    eventId: input.eventId,
    jobType: input.jobType,
    payload: input.payload,
    status: 'PENDING',
    attempts: 0,
    nextRunAt: now,
    createdAt: now,
  });
}

export interface ProcessJobsOptions {
  /** 单轮领取任务数上限，默认 10 */
  batchSize?: number;
  /** 最大重试次数（含首次），超过标记 DEAD，默认 5 */
  maxAttempts?: number;
  /** 退避基数毫秒，第 n 次失败后延迟 base * 2^n，默认 60_000（1min → 2min → 4min…） */
  backoffBaseMs?: number;
  logger?: BillingLogger;
  now?: Date;
}

export interface ProcessJobsResult {
  claimed: number;
  done: number;
  failed: number;
  dead: number;
}

/**
 * 执行一轮任务处理（由产品侧定时器/cron 周期调用）。
 * 逐个执行以保证失败隔离：单个任务异常只影响自身重试，不中断本轮其余任务。
 */
export async function processCommissionJobs(
  storage: CommissionStorage,
  handlers: CommissionJobHandlers,
  opts?: ProcessJobsOptions,
): Promise<ProcessJobsResult> {
  const now = opts?.now ?? new Date();
  const maxAttempts = opts?.maxAttempts ?? 5;
  const backoffBaseMs = opts?.backoffBaseMs ?? 60_000;
  const jobs = await storage.claimDueJobs(opts?.batchSize ?? 10, now);

  const result: ProcessJobsResult = { claimed: jobs.length, done: 0, failed: 0, dead: 0 };
  for (const job of jobs) {
    try {
      const handler = handlers[job.jobType];
      if (!handler) throw new Error(`no handler for jobType ${job.jobType}`);
      await handler(job.payload);
      await storage.markJobDone(job.id);
      result.done += 1;
    } catch (err) {
      const attempts = job.attempts + 1;
      const dead = attempts >= maxAttempts;
      await storage.markJobFailed(job.id, {
        attempts,
        nextRunAt: new Date(now.getTime() + backoffBaseMs * 2 ** attempts),
        dead,
      });
      if (dead) {
        result.dead += 1;
        opts?.logger?.error('commission.job.dead', { jobId: job.id, jobType: job.jobType, attempts, error: String(err) });
      } else {
        result.failed += 1;
        opts?.logger?.warn('commission.job.retry_scheduled', { jobId: job.id, jobType: job.jobType, attempts, error: String(err) });
      }
    }
  }
  return result;
}

export type { CommissionJobRow };
