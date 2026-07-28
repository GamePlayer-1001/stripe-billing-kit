/**
 * fraud.ts 单元测试（7.2 反作弊风险评分）。
 */
import { describe, expect, it } from 'vitest';
import { calculateRiskScore, collectRiskFactors, DEFAULT_FRAUD_THRESHOLDS } from './fraud.js';

describe('calculateRiskScore', () => {
  it('无风险信号 → 0 分 LOW/APPROVE', () => {
    const result = calculateRiskScore({});
    expect(result).toEqual({ score: 0, level: 'LOW', action: 'APPROVE', reasons: [] });
  });

  it('规范示例组合：新号+高退款+可疑时段 → 80 分 HIGH/BLOCK', () => {
    const result = calculateRiskScore({
      accountAge: 3,
      transactionHistory: { refundRate: 0.5 },
      behaviorPatterns: { suspiciousTiming: true },
    });
    expect(result.score).toBe(30 + 25 + 25);
    expect(result.level).toBe('HIGH');
    expect(result.action).toBe('BLOCK');
    expect(result.reasons).toEqual(['new_account', 'high_refund_rate', 'suspicious_timing']);
  });

  it('单一中风险因子（设备集群 45 分组合）→ MEDIUM/REVIEW', () => {
    const result = calculateRiskScore({
      networkAnalysis: { clusterSize: 11 },
      behaviorPatterns: { suspiciousTiming: true },
    });
    expect(result.score).toBe(20 + 25);
    expect(result.level).toBe('MEDIUM');
    expect(result.action).toBe('REVIEW');
  });

  it('总分封顶 100', () => {
    const result = calculateRiskScore({
      accountAge: 0,
      transactionHistory: { refundRate: 1 },
      networkAnalysis: { clusterSize: 99, referralDepth: 9 },
      behaviorPatterns: { suspiciousTiming: true, simultaneousRegistrations: 9 },
    });
    expect(result.score).toBe(100);
    expect(result.reasons).toHaveLength(6);
  });

  it('阈值可覆盖：调低 highScore 后同分判 HIGH', () => {
    const metrics = { networkAnalysis: { clusterSize: 11 } };
    expect(calculateRiskScore(metrics).level).toBe('LOW');
    expect(calculateRiskScore(metrics, { highScore: 10 }).level).toBe('HIGH');
  });

  it('边界值不触发：账龄等于阈值 / 退款率等于阈值', () => {
    const factors = collectRiskFactors({
      accountAge: DEFAULT_FRAUD_THRESHOLDS.minAccountAgeDays,
      transactionHistory: { refundRate: DEFAULT_FRAUD_THRESHOLDS.maxRefundRate },
      networkAnalysis: { clusterSize: DEFAULT_FRAUD_THRESHOLDS.maxClusterSize },
    });
    expect(factors).toEqual([]);
  });

  it('传销深度与批量注册因子', () => {
    const factors = collectRiskFactors({
      networkAnalysis: { referralDepth: 4 },
      behaviorPatterns: { simultaneousRegistrations: 3 },
    });
    expect(factors).toEqual(['deep_referral_chain', 'simultaneous_registrations']);
  });
});
