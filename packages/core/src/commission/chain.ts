/**
 * 多级推荐链构建（对应 docs/COMMISSION-SYSTEM-SPEC.md 2.3.5）
 *
 * 规则：
 * 1. 链深硬上限 maxTierLevels（默认 3）
 * 2. 防环：携带已访问集合，出现环立即截断并告警（环 = 强作弊信号）
 * 3. 中断即止：链上某人关系为 TERMINATED 时，该级及更上级均不计佣
 * 4. 链快照固化由调用方在计佣时写入 rateBreakdown，历史归属永不改写
 */
import type { BillingLogger } from '../config.js';
import type { CommissionStorage } from './types.js';

export interface ChainNode {
  tierLevel: number;
  referrerUserId: string;
  relationshipId: string;
}

export interface BuildChainResult {
  chain: ChainNode[];
  /** 检测到环（作弊信号），已截断 */
  cycleDetected: boolean;
}

/**
 * 从付费用户向上回溯推荐链。
 * @param payerUserId 付费用户 ID
 * @param storage     佣金存储
 * @param maxLevels   最大层级（默认 3）
 * @param logger      可选日志（环告警用）
 */
export async function buildReferralChain(
  payerUserId: string,
  storage: CommissionStorage,
  maxLevels = 3,
  logger?: BillingLogger,
): Promise<BuildChainResult> {
  const chain: ChainNode[] = [];
  const visited = new Set<string>([payerUserId]); // 防环：付费者自身也在集合内
  let cycleDetected = false;

  let currentUserId = payerUserId;
  let level = 0;

  while (level < maxLevels) {
    const rel = await storage.getActiveReferrer(currentUserId);
    if (!rel) break; // 断链：某人无推荐人

    const referrer = rel.referrerUserId;

    // 防环：推荐人已出现在链路上
    if (visited.has(referrer)) {
      cycleDetected = true;
      logger?.warn('commission.chain.cycle_detected', {
        payerUserId,
        referrerUserId: referrer,
        visited: [...visited],
      });
      break;
    }

    // 中断即止：TERMINATED 关系不参与计佣（getActiveReferrer 已过滤，此处双保险）
    if (rel.status === 'TERMINATED' || rel.status === 'EXPIRED') break;

    level += 1;
    chain.push({ tierLevel: level, referrerUserId: referrer, relationshipId: rel.id });
    visited.add(referrer);
    currentUserId = referrer;
  }

  return { chain, cycleDetected };
}
