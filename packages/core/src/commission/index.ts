/**
 * 佣金模块公共出口。
 *
 * 用法：
 * ```ts
 * import { CommissionEngine, ReferralService, InMemoryCommissionStorage } from '@stripe-billing-kit/core';
 *
 * const storage = new InMemoryCommissionStorage(); // 生产环境换成 Prisma/pg 实现
 * const engine = new CommissionEngine({ config: { programId: 'default', storage } });
 * const referrals = new ReferralService({ storage });
 * ```
 */

// 类型
export type {
  ComponentType,
  ValueMode,
  DriverVariable,
  LadderStep,
  RewardComponent,
  TriggerScope,
  CommissionBase,
  PlatformFeeHandlingMode,
  RelationshipStatus,
  CommissionStatus,
  ReviewStatus,
  GrantStatus,
  ReferralCodeRow,
  ReferralRelationshipRow,
  CommissionRuleRow,
  CommissionRow,
  RateBreakdownEntry,
  CommissionStorage,
  StripeFeeConfig,
  ProductRewardGrantInput,
  CommissionHooks,
  CommissionConfig,
  CalculateCommissionInput,
  TierCommissionResult,
  CommissionCalculationResult,
  ClawbackResult,
  ReviewTrigger,
  QueueStatus,
  AuditQueueItemRow,
  ConfigVersionRow,
  ReferralStatsRow,
} from './types.js';

// 存储
export { InMemoryCommissionStorage } from './storage-memory.js';
export { pgCommissionStorage } from './storage-pg.js';
export { prismaCommissionStorage, type PrismaCommissionLike } from './storage-prisma.js';

// 邀请关系
export {
  ReferralService,
  generateCode,
  type ReferralServiceOptions,
  type ValidateCodeResult,
  type BindResult,
} from './referrals.js';

// 推荐链
export { buildReferralChain, type ChainNode, type BuildChainResult } from './chain.js';

// 计算引擎
export {
  CommissionEngine,
  calculateStripeFee,
  matchRule,
  type CommissionEngineOptions,
} from './engine.js';

// webhook 事件接入
export {
  handleCommissionEvent,
  processCheckoutCompleted,
  processInvoicePaid,
  processChargeRefunded,
  resolveTriggerScope,
} from './events.js';

// REST 端点路由（主管线自动挂载；自定义适配器也可直接调用）
export { handleCommissionRequest } from './http.js';

// 风控审核（Level 1 自动化规则纯函数）
export {
  evaluateAutoReview,
  type AutoReviewRules,
  type AutoReviewInput,
  type AutoReviewResult,
} from './audit.js';
