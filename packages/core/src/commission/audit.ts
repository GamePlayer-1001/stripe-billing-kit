/**
 * 风控审核（对应 docs/COMMISSION-SYSTEM-SPEC.md 7.1 三层审核机制）。
 *
 * Level 1 自动化实时审核：纯函数 evaluateAutoReview，产品侧在注册/绑定前调用。
 * core 不掌握邮箱/IP/设备数据，只做规则判定；数据采集与限流由产品侧实现。
 * Level 2 人工审核队列：引擎在 MANUAL_REVIEW 时自动入队（见 engine.ts），
 * 管理端通过 GET /admin/audit-queue 消费、POST /admin/commissions/:id/review 处置。
 */
import type { ReviewTrigger } from './types.js';

/** Level 1 自动化审核规则（全部可选：未配置的规则不参与判定） */
export interface AutoReviewRules {
  /** 一次性邮箱域黑名单，如 ['tempmail.com', '10minutemail.com'] */
  blockedEmailDomains?: string[];
  /** 必须完成邮箱验证 */
  requireVerifiedEmail?: boolean;
  /** 注册冷却期：注册后 N 小时内不能作为推荐人产生佣金 */
  cooldownHoursAfterRegistration?: number;
  /** 单日最高邀请数（超过 → RAPID_GROWTH 标记） */
  maxInvitesPerDay?: number;
  /** 同一设备关联新账户数阈值（达到 → SAME_DEVICE 标记） */
  sameDeviceThreshold?: number;
}

/** 判定输入：由产品侧采集后传入（缺省字段跳过对应规则） */
export interface AutoReviewInput {
  /** 推荐人邮箱 */
  email?: string;
  /** 邮箱是否已验证 */
  emailVerified?: boolean;
  /** 推荐人注册时间 */
  registeredAt?: Date;
  /** 推荐人今日邀请数 */
  invitesToday?: number;
  /** 同一设备下的关联账户数 */
  sameDeviceAccounts?: number;
  /** 判定时刻（默认当前时间） */
  now?: Date;
}

export interface AutoReviewResult {
  /** 是否放行（false = 违反硬性规则，应拒绝计佣/绑定） */
  allowed: boolean;
  /** 放行但存在风险信号（应入人工审核队列） */
  flagged: boolean;
  /** 风险评分 0-100（阻断项 40 分、标记项 20 分，封顶 100） */
  riskScore: number;
  /** 命中的风险因子标签 */
  riskFactors: string[];
  /** 建议的入队原因（flagged 时有值） */
  trigger: ReviewTrigger | null;
}

const BLOCK_SCORE = 40;
const FLAG_SCORE = 20;

/**
 * Level 1 自动化实时审核（纯函数，无 IO）。
 * 阻断类规则（邮箱黑名单/未验证/冷却期内）→ allowed=false；
 * 标记类规则（邀请数/同设备超阈值）→ allowed=true 但 flagged=true。
 */
export function evaluateAutoReview(rules: AutoReviewRules, input: AutoReviewInput): AutoReviewResult {
  const now = input.now ?? new Date();
  const riskFactors: string[] = [];
  let blocked = false;
  let trigger: ReviewTrigger | null = null;

  // 邮箱域黑名单
  if (rules.blockedEmailDomains?.length && input.email) {
    const domain = input.email.split('@')[1]?.toLowerCase() ?? '';
    if (rules.blockedEmailDomains.some((d) => d.toLowerCase() === domain)) {
      riskFactors.push('blocked_email_domain');
      blocked = true;
    }
  }

  // 邮箱验证
  if (rules.requireVerifiedEmail && input.emailVerified === false) {
    riskFactors.push('email_unverified');
    blocked = true;
  }

  // 注册冷却期
  if (rules.cooldownHoursAfterRegistration != null && input.registeredAt) {
    const hours = (now.getTime() - input.registeredAt.getTime()) / (60 * 60 * 1000);
    if (hours < rules.cooldownHoursAfterRegistration) {
      riskFactors.push('registration_cooldown');
      blocked = true;
    }
  }

  // 单日邀请数（标记，不阻断）
  if (rules.maxInvitesPerDay != null && (input.invitesToday ?? 0) > rules.maxInvitesPerDay) {
    riskFactors.push('rapid_growth');
    trigger = 'RAPID_GROWTH';
  }

  // 同设备关联账户（标记，不阻断）
  if (rules.sameDeviceThreshold != null && (input.sameDeviceAccounts ?? 0) >= rules.sameDeviceThreshold) {
    riskFactors.push('same_device_cluster');
    trigger = trigger ?? 'SAME_DEVICE';
  }

  const flagged = !blocked && trigger !== null;
  const blockedCount = riskFactors.filter((f) =>
    ['blocked_email_domain', 'email_unverified', 'registration_cooldown'].includes(f),
  ).length;
  const flaggedCount = riskFactors.length - blockedCount;
  const riskScore = Math.min(100, blockedCount * BLOCK_SCORE + flaggedCount * FLAG_SCORE);

  return { allowed: !blocked, flagged, riskScore, riskFactors, trigger: flagged ? trigger : null };
}
