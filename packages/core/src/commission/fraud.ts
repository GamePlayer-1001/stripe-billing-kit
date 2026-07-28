/**
 * 反作弊风险评分（对应 docs/COMMISSION-SYSTEM-SPEC.md 7.2 反作弊算法）。
 *
 * 与 audit.ts（Level 1 实时规则）互补：
 * - evaluateAutoReview 是绑定/计佣前的硬性闸门（阻断/标记）；
 * - calculateRiskScore 是对推荐人的综合风险画像（0-100 分 + 建议动作），
 *   供周期性审计（Level 3）与人工审核工作台展示使用。
 * core 不掌握设备/IP/行为数据，指标由产品侧采集后传入，本模块只做纯函数判定。
 */

/** 风险指标输入（产品侧采集；缺省字段视为无风险信号） */
export interface FraudDetectionMetrics {
  /** 账户存活天数 */
  accountAge?: number;
  /** 交易历史 */
  transactionHistory?: {
    /** 退款率 0-1 */
    refundRate?: number;
    /** 平均订单金额（分） */
    avgOrderValue?: number;
    /** 总交易笔数 */
    totalTransactions?: number;
  };
  /** 网络分析 */
  networkAnalysis?: {
    /** 同一设备/IP 下的关联账户数 */
    clusterSize?: number;
    /** 推荐链深度（传销深度检测） */
    referralDepth?: number;
  };
  /** 行为模式 */
  behaviorPatterns?: {
    /** 短时间内注册的关联账户数 */
    simultaneousRegistrations?: number;
    /** 可疑时段密集操作（如凌晨 3 点批量注册） */
    suspiciousTiming?: boolean;
  };
}

/** 判定阈值与权重（全部可覆盖；默认值与规范 7.2 示例一致） */
export interface FraudScoreThresholds {
  /** 账户存活天数 < N 视为新号风险（默认 7 天，+30 分） */
  minAccountAgeDays: number;
  accountAgeWeight: number;
  /** 退款率 > N 视为高退款风险（默认 0.2，+25 分） */
  maxRefundRate: number;
  refundRateWeight: number;
  /** 同设备/IP 关联账户数 > N 视为集群风险（默认 10，+20 分） */
  maxClusterSize: number;
  clusterSizeWeight: number;
  /** 可疑时段操作权重（默认 +25 分） */
  suspiciousTimingWeight: number;
  /** 推荐链深度 > N 视为传销风险（默认 3 级，+20 分） */
  maxReferralDepth: number;
  referralDepthWeight: number;
  /** 短时多账户注册数 >= N 视为批量注册风险（默认 3，+20 分） */
  maxSimultaneousRegistrations: number;
  simultaneousRegistrationsWeight: number;
  /** score > N 判 HIGH/BLOCK（默认 70） */
  highScore: number;
  /** score > N 判 MEDIUM/REVIEW（默认 40） */
  mediumScore: number;
}

export const DEFAULT_FRAUD_THRESHOLDS: FraudScoreThresholds = {
  minAccountAgeDays: 7,
  accountAgeWeight: 30,
  maxRefundRate: 0.2,
  refundRateWeight: 25,
  maxClusterSize: 10,
  clusterSizeWeight: 20,
  suspiciousTimingWeight: 25,
  maxReferralDepth: 3,
  referralDepthWeight: 20,
  maxSimultaneousRegistrations: 3,
  simultaneousRegistrationsWeight: 20,
  highScore: 70,
  mediumScore: 40,
};

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type RiskAction = 'APPROVE' | 'REVIEW' | 'BLOCK';

export interface RiskAssessment {
  /** 综合风险分 0-100（各命中因子权重求和后封顶） */
  score: number;
  level: RiskLevel;
  /** 建议动作：HIGH→BLOCK / MEDIUM→REVIEW / LOW→APPROVE */
  action: RiskAction;
  /** 命中的风险因子标签（与 evaluateAutoReview 的 riskFactors 同风格） */
  reasons: string[];
}

/** 收集命中的风险因子标签（导出便于工作台单独展示） */
export function collectRiskFactors(
  metrics: FraudDetectionMetrics,
  thresholds: FraudScoreThresholds = DEFAULT_FRAUD_THRESHOLDS,
): string[] {
  const reasons: string[] = [];
  if (metrics.accountAge != null && metrics.accountAge < thresholds.minAccountAgeDays) {
    reasons.push('new_account');
  }
  if ((metrics.transactionHistory?.refundRate ?? 0) > thresholds.maxRefundRate) {
    reasons.push('high_refund_rate');
  }
  if ((metrics.networkAnalysis?.clusterSize ?? 0) > thresholds.maxClusterSize) {
    reasons.push('device_cluster');
  }
  if (metrics.behaviorPatterns?.suspiciousTiming) {
    reasons.push('suspicious_timing');
  }
  if ((metrics.networkAnalysis?.referralDepth ?? 0) > thresholds.maxReferralDepth) {
    reasons.push('deep_referral_chain');
  }
  if (
    (metrics.behaviorPatterns?.simultaneousRegistrations ?? 0) >=
    thresholds.maxSimultaneousRegistrations
  ) {
    reasons.push('simultaneous_registrations');
  }
  return reasons;
}

const FACTOR_WEIGHT_KEYS: Record<string, keyof FraudScoreThresholds> = {
  new_account: 'accountAgeWeight',
  high_refund_rate: 'refundRateWeight',
  device_cluster: 'clusterSizeWeight',
  suspicious_timing: 'suspiciousTimingWeight',
  deep_referral_chain: 'referralDepthWeight',
  simultaneous_registrations: 'simultaneousRegistrationsWeight',
};

/**
 * 综合风险评分（纯函数，无 IO）。
 * 默认权重与规范 7.2 一致：新号 +30 / 高退款 +25 / 设备集群 +20 / 可疑时段 +25，
 * 并补充传销深度 +20、批量注册 +20 两个规范指标；总分封顶 100。
 */
export function calculateRiskScore(
  metrics: FraudDetectionMetrics,
  thresholds?: Partial<FraudScoreThresholds>,
): RiskAssessment {
  const t: FraudScoreThresholds = { ...DEFAULT_FRAUD_THRESHOLDS, ...thresholds };
  const reasons = collectRiskFactors(metrics, t);
  const raw = reasons.reduce((sum, r) => {
    const key = FACTOR_WEIGHT_KEYS[r];
    return key ? sum + (t[key] as number) : sum;
  }, 0);
  const score = Math.min(100, raw);
  const level: RiskLevel = score > t.highScore ? 'HIGH' : score > t.mediumScore ? 'MEDIUM' : 'LOW';
  const action: RiskAction = level === 'HIGH' ? 'BLOCK' : level === 'MEDIUM' ? 'REVIEW' : 'APPROVE';
  return { score, level, action, reasons };
}
