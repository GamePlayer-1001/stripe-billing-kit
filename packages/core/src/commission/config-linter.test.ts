/**
 * config-linter.ts 单元测试（8.3 Wizard 智能辅助：配方库 / 盈亏预估 / Linter）。
 */
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_RECIPES,
  estimateProfitability,
  lintCommissionConfig,
} from './config-linter.js';
import type { CommissionRuleRow, RewardComponent } from './types.js';

let seq = 0;

function makeRule(patch: Partial<CommissionRuleRow>): CommissionRuleRow {
  seq += 1;
  return {
    id: `rule_${seq}`,
    programId: 'default',
    planKey: null,
    triggerScope: 'FIRST_PAYMENT',
    tierLevel: 1,
    components: [{ componentType: 'CASH_PERCENT', valueMode: 'FIXED', fixedValue: 0.2 }],
    commissionBase: 'NET_BASED',
    platformFeeHandlingMode: 'CONSUMED_BY_PLATFORM',
    holdPeriodDays: 30,
    autoApproveUnderCents: null,
    requireReviewOverCents: null,
    isActive: true,
    priority: 0,
    ...patch,
  };
}

const percent = (rate: number): RewardComponent => ({
  componentType: 'CASH_PERCENT',
  valueMode: 'FIXED',
  fixedValue: rate,
});

/** 健康配置的公共 lint 选项（避免风控/打款类告警干扰断言目标） */
const SAFE_OPTS = {
  autoReviewRules: { requireVerifiedEmail: true, maxInvitesPerDay: 10 },
  payout: { provider: 'PAYPAL' as const, minPayoutThresholdCents: 5000 },
  hasProductGrantHook: true,
};

describe('EXAMPLE_RECIPES', () => {
  it('包含规范 8.3.1 的三套配方，且订阅制配方数值一致', () => {
    expect(EXAMPLE_RECIPES.map((r) => r.name)).toEqual([
      '订阅制常见搭配',
      '业绩阶梯 + 产品奖励',
      '按量付费',
    ]);
    const sub = EXAMPLE_RECIPES[0]!;
    expect(sub.rules[0]!.components[0]!.fixedValue).toBe(0.25);
    expect(sub.rules[1]!.components[0]!.dynamicConfig?.ladder).toEqual([
      { from: 1, to: 13, value: 0.15 },
      { from: 13, to: null, value: 0 },
    ]);
  });
});

describe('estimateProfitability', () => {
  it('复现规范 8.3.2 面板：$100 订单，NET 计佣 20/10/5% 三级', () => {
    const estimate = estimateProfitability({
      orderAmountCents: 10000,
      rules: [
        makeRule({ tierLevel: 1, components: [percent(0.2)] }),
        makeRule({ tierLevel: 2, components: [percent(0.1)] }),
        makeRule({ tierLevel: 3, components: [percent(0.05)] }),
      ],
      stripeFee: { percentRate: 0.029, fixedCents: 30 },
    });
    expect(estimate.stripeFeeCents).toBe(320);
    expect(estimate.tierBreakdown.map((t) => t.cashCents)).toEqual([1936, 968, 484]);
    expect(estimate.platformNetCents).toBe(6292);
    expect(estimate.health).toBe('HEALTHY');
  });

  it('DYNAMIC 按最坏情况（最高档）演算；亏损 → LOSS', () => {
    const estimate = estimateProfitability({
      orderAmountCents: 10000,
      rules: [
        makeRule({
          commissionBase: 'GROSS_BASED',
          components: [
            {
              componentType: 'CASH_PERCENT',
              valueMode: 'DYNAMIC',
              dynamicConfig: {
                driverVariable: 'REFERRER_MONTHLY_CONVERSIONS',
                ladder: [
                  { from: 0, to: 10, value: 0.3 },
                  { from: 10, to: null, value: 1.1 },
                ],
              },
            },
          ],
        }),
      ],
    });
    expect(estimate.tierBreakdown[0]!.cashCents).toBe(11000); // 最高档 110%
    expect(estimate.platformNetCents).toBeLessThan(0);
    expect(estimate.health).toBe('LOSS');
  });
});

describe('lintCommissionConfig', () => {
  it('健康配置 → ok=true 无 ERROR', () => {
    const report = lintCommissionConfig({ rules: [makeRule({})], ...SAFE_OPTS });
    expect(report.ok).toBe(true);
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(0);
  });

  it('ERROR：多级佣金率合计 ≥ 100% + 最坏情况亏损', () => {
    const report = lintCommissionConfig({
      rules: [
        makeRule({ tierLevel: 1, components: [percent(0.6)] }),
        makeRule({ tierLevel: 2, components: [percent(0.5)] }),
      ],
      ...SAFE_OPTS,
    });
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('RATE_SUM_GTE_100');
    expect(codes).toContain('NEGATIVE_PROFIT');
    expect(report.ok).toBe(false);
  });

  it('ERROR：USAGE_INVOICE CASH_FIXED 未设最低可佣金额 / PRODUCT 缺 ref 与 hook', () => {
    const report = lintCommissionConfig({
      rules: [
        makeRule({
          triggerScope: 'USAGE_INVOICE',
          components: [
            { componentType: 'CASH_FIXED', valueMode: 'FIXED', fixedValue: 500 },
            { componentType: 'PRODUCT', valueMode: 'FIXED', fixedValue: 1 },
          ],
        }),
      ],
      ...SAFE_OPTS,
      hasProductGrantHook: false,
    });
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('USAGE_CASH_FIXED_NO_MIN');
    expect(codes).toContain('PRODUCT_MISSING_REF');
    expect(codes).toContain('PRODUCT_MISSING_HOOK');
  });

  it('ERROR：阶梯重叠/断档；ORDER_AMOUNT 固定金额档超过档位下限', () => {
    const report = lintCommissionConfig({
      rules: [
        makeRule({
          components: [
            {
              componentType: 'CASH_FIXED',
              valueMode: 'DYNAMIC',
              maxValueCents: 100,
              dynamicConfig: {
                driverVariable: 'ORDER_AMOUNT',
                ladder: [
                  { from: 0, to: 500, value: 600 }, // 档内必亏
                  { from: 400, to: 800, value: 100 }, // 与上档重叠
                  { from: 900, to: null, value: 100 }, // 与上档断档
                ],
              },
            },
          ],
        }),
      ],
      ...SAFE_OPTS,
    });
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('LADDER_OVERLAP');
    expect(codes).toContain('LADDER_GAP');
    expect(codes).toContain('LADDER_FIXED_EXCEEDS_BAND');
  });

  it('WARNING：冻结期<7天 / GROSS 比例>30% / DYNAMIC 未封顶 / 风控未配置', () => {
    const report = lintCommissionConfig({
      rules: [
        makeRule({
          holdPeriodDays: 3,
          commissionBase: 'GROSS_BASED',
          components: [
            {
              componentType: 'CASH_PERCENT',
              valueMode: 'DYNAMIC',
              dynamicConfig: {
                driverVariable: 'ORDER_AMOUNT',
                ladder: [{ from: 0, to: null, value: 0.35 }],
              },
            },
          ],
        }),
      ],
      payout: SAFE_OPTS.payout,
    });
    const codes = report.issues.filter((i) => i.level === 'WARNING').map((i) => i.code);
    expect(codes).toContain('SHORT_HOLD_PERIOD');
    expect(codes).toContain('HIGH_GROSS_RATE');
    expect(codes).toContain('DYNAMIC_NO_CAP');
    expect(codes).toContain('EMAIL_VERIFICATION_DISABLED');
    expect(codes).toContain('NO_DAILY_INVITE_LIMIT');
    expect(report.ok).toBe(true); // WARNING 不阻断
  });

  it('INFO：未配置提现门槛/打款通道；非激活规则不参与检查', () => {
    const report = lintCommissionConfig({
      rules: [makeRule({ isActive: false, holdPeriodDays: 0, components: [percent(2)] })],
      autoReviewRules: SAFE_OPTS.autoReviewRules,
    });
    const infoCodes = report.issues.filter((i) => i.level === 'INFO').map((i) => i.code);
    expect(infoCodes).toEqual(['NO_PAYOUT_THRESHOLD', 'NO_PAYOUT_PROVIDER']);
    expect(report.errors).toBe(0); // 非激活规则的问题不报
    expect(report.infos).toBe(2);
  });
});
