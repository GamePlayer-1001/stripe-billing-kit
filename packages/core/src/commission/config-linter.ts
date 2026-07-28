/**
 * 配置智能辅助（对应 docs/COMMISSION-SYSTEM-SPEC.md 8.3 Wizard 智能辅助系统）。
 *
 * - EXAMPLE_RECIPES（8.3.1）：示例配方库——非系统预设，仅可复制进编辑器的组件组合起点；
 * - estimateProfitability（8.3.2）：实时盈亏预估纯函数，供配置面板演算；
 * - lintCommissionConfig（8.3.3）：Linter 式配置校验，ERROR 阻断发布 / WARNING 需确认 / INFO 提示。
 *
 * 三者均为纯函数（无 IO），Wizard/CLI/CI 皆可直接调用。
 */
import { calculateStripeFee } from './engine.js';
import type { AutoReviewRules } from './audit.js';
import type {
  CommissionRuleRow,
  LadderStep,
  PayoutProviderName,
  RewardComponent,
  StripeFeeConfig,
  TriggerScope,
} from './types.js';

// ──────────────────────────────────────────────────────
// 8.3.1 示例配方库
// ──────────────────────────────────────────────────────

export interface RecipeRule {
  triggerScope: TriggerScope;
  components: RewardComponent[];
}

/** 可复制的组件组合示例：复制后即成为生产者自己的普通配置，可任意修改 */
export interface Recipe {
  name: string;
  description: string;
  rules: RecipeRule[];
}

/** ⚠️ 非系统预设——组件模型是唯一的真实模型，配方只是避免新手面对空白表单的起点 */
export const EXAMPLE_RECIPES: readonly Recipe[] = [
  {
    name: '订阅制常见搭配',
    description: '首付 25% + 续费前 12 期 15%',
    rules: [
      {
        triggerScope: 'FIRST_PAYMENT',
        components: [{ componentType: 'CASH_PERCENT', valueMode: 'FIXED', fixedValue: 0.25 }],
      },
      {
        triggerScope: 'RECURRING_PAYMENT',
        components: [
          {
            componentType: 'CASH_PERCENT',
            valueMode: 'DYNAMIC',
            dynamicConfig: {
              driverVariable: 'PERIOD_INDEX',
              ladder: [
                { from: 1, to: 13, value: 0.15 },
                { from: 13, to: null, value: 0 },
              ],
            },
          },
        ],
      },
    ],
  },
  {
    name: '业绩阶梯 + 产品奖励',
    description: '月转化越多比例越高，另送 1 个月 VIP',
    rules: [
      {
        triggerScope: 'FIRST_PAYMENT',
        components: [
          {
            componentType: 'CASH_PERCENT',
            valueMode: 'DYNAMIC',
            dynamicConfig: {
              driverVariable: 'REFERRER_MONTHLY_CONVERSIONS',
              ladder: [
                { from: 0, to: 6, value: 0.15 },
                { from: 6, to: 21, value: 0.2 },
                { from: 21, to: null, value: 0.25 },
              ],
            },
          },
          { componentType: 'PRODUCT', valueMode: 'FIXED', fixedValue: 1, productRef: 'vip_month' },
        ],
      },
    ],
  },
  {
    name: '按量付费',
    description: '每期账单金额 10%，设最低可佣金额防穿仓',
    rules: [
      {
        triggerScope: 'USAGE_INVOICE',
        components: [
          {
            componentType: 'CASH_PERCENT',
            valueMode: 'FIXED',
            fixedValue: 0.1,
            minCommissionableAmountCents: 500,
          },
        ],
      },
    ],
  },
];

// ──────────────────────────────────────────────────────
// 8.3.2 盈亏预估（纯函数，供实时演算面板）
// ──────────────────────────────────────────────────────

/** 组件在给定订单金额下的最坏情况现金贡献（DYNAMIC 取阶梯最高值档） */
function worstCaseComponentCash(
  component: RewardComponent,
  orderAmountCents: number,
  percentBaseCents: number,
): number {
  if (component.componentType === 'PRODUCT') return 0;
  if (
    component.minCommissionableAmountCents != null &&
    orderAmountCents < component.minCommissionableAmountCents
  ) {
    return 0; // 防穿仓：低于最低可佣金额不触发
  }
  const value =
    component.valueMode === 'DYNAMIC'
      ? Math.max(0, ...(component.dynamicConfig?.ladder ?? []).map((s) => s.value))
      : (component.fixedValue ?? 0);
  let cash =
    component.componentType === 'CASH_PERCENT' ? Math.round(percentBaseCents * value) : Math.round(value);
  if (component.maxValueCents != null && cash > component.maxValueCents) {
    cash = component.maxValueCents;
  }
  return cash;
}

export interface ProfitEstimateOptions {
  /** 演算订单金额(cents)，如 10000 = $100 */
  orderAmountCents: number;
  /** 各级规则（每条视为一条佣金腿，与多级合计口径一致） */
  rules: Array<Pick<CommissionRuleRow, 'components' | 'commissionBase' | 'tierLevel'>>;
  stripeFee?: StripeFeeConfig;
}

/** 到手健康度：>50% 健康 / 30~50% 可接受 / 0~30% 预警 / <0 亏损 */
export type ProfitHealth = 'HEALTHY' | 'ACCEPTABLE' | 'WARNING' | 'LOSS';

export interface ProfitEstimate {
  orderAmountCents: number;
  stripeFeeCents: number;
  /** 每条规则腿的现金佣金（最坏情况：DYNAMIC 取最高档） */
  tierBreakdown: Array<{ tierLevel: number | null; cashCents: number }>;
  totalCommissionCents: number;
  /** 平台实际到手 = 订单 - 手续费 - 佣金合计（手续费按平台承担口径） */
  platformNetCents: number;
  /** 到手比例（相对订单金额） */
  netRatio: number;
  health: ProfitHealth;
}

/**
 * 实时盈亏预估（8.3.2）：DYNAMIC 组件按最坏情况（最高档）演算，
 * 与 Linter 的"最坏情况盈亏为负"口径一致。手续费按 CONSUMED_BY_PLATFORM 计。
 */
export function estimateProfitability(opts: ProfitEstimateOptions): ProfitEstimate {
  const { orderAmountCents, rules, stripeFee } = opts;
  const stripeFeeCents = calculateStripeFee(orderAmountCents, { stripeFee });
  const netBaseCents = orderAmountCents - stripeFeeCents;

  const tierBreakdown = rules.map((rule) => {
    const percentBase = rule.commissionBase === 'GROSS_BASED' ? orderAmountCents : netBaseCents;
    const cashCents = rule.components.reduce(
      (sum, c) => sum + worstCaseComponentCash(c, orderAmountCents, percentBase),
      0,
    );
    return { tierLevel: rule.tierLevel, cashCents };
  });

  const totalCommissionCents = tierBreakdown.reduce((sum, t) => sum + t.cashCents, 0);
  const platformNetCents = orderAmountCents - stripeFeeCents - totalCommissionCents;
  const netRatio = orderAmountCents > 0 ? platformNetCents / orderAmountCents : 0;
  const health: ProfitHealth =
    netRatio < 0 ? 'LOSS' : netRatio < 0.3 ? 'WARNING' : netRatio < 0.5 ? 'ACCEPTABLE' : 'HEALTHY';

  return {
    orderAmountCents,
    stripeFeeCents,
    tierBreakdown,
    totalCommissionCents,
    platformNetCents,
    netRatio,
    health,
  };
}

// ──────────────────────────────────────────────────────
// 8.3.3 Linter 式配置校验
// ──────────────────────────────────────────────────────

export type LintLevel = 'ERROR' | 'WARNING' | 'INFO';

export interface ConfigLintIssue {
  level: LintLevel;
  /** 机器可读规则码，如 RATE_SUM_GTE_100 */
  code: string;
  message: string;
  /** 问题所在规则（全局问题为空） */
  ruleId?: string;
}

export interface ConfigLintOptions {
  rules: CommissionRuleRow[];
  /** Level 1 风控规则（未提供视为未配置，触发相应 WARNING） */
  autoReviewRules?: AutoReviewRules;
  /** 打款配置（Step 4）；未提供触发 INFO 提示 */
  payout?: {
    provider?: PayoutProviderName;
    minPayoutThresholdCents?: number;
  };
  /** 是否已注册 onProductRewardGrant hook（存在 PRODUCT 组件时必须为 true） */
  hasProductGrantHook?: boolean;
  stripeFee?: StripeFeeConfig;
  /** 盈亏演算样本订单金额(cents)，默认 10000 = $100 */
  sampleOrderCents?: number;
}

export interface ConfigLintReport {
  /** 无 ERROR 即可发布（WARNING 需生产者确认"我已知晓"） */
  ok: boolean;
  errors: number;
  warnings: number;
  infos: number;
  issues: ConfigLintIssue[];
}

/** 阶梯档位校验：重叠 / 断档 / 无上限档不在末位 */
function lintLadder(ladder: LadderStep[], ruleId: string, issues: ConfigLintIssue[]): void {
  const sorted = [...ladder].sort((a, b) => a.from - b.from);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const cur = sorted[i]!;
    const next = sorted[i + 1]!;
    if (cur.to === null || next.from < cur.to) {
      issues.push({
        level: 'ERROR',
        code: 'LADDER_OVERLAP',
        message: `阶梯档位重叠：[${cur.from}, ${cur.to ?? '∞'}) 与 [${next.from}, ${next.to ?? '∞'})`,
        ruleId,
      });
    } else if (next.from > cur.to) {
      issues.push({
        level: 'ERROR',
        code: 'LADDER_GAP',
        message: `阶梯档位断档：[${cur.to}, ${next.from}) 区间无取值`,
        ruleId,
      });
    }
  }
}

/**
 * Linter 式配置校验（8.3.3）：发布前扫描全部配置，三级输出问题清单。
 * 无预设兜底后，Linter 是守门员——ERROR 必须阻断发布。
 */
export function lintCommissionConfig(opts: ConfigLintOptions): ConfigLintReport {
  const { rules, autoReviewRules, payout, hasProductGrantHook, stripeFee } = opts;
  const sampleOrderCents = opts.sampleOrderCents ?? 10000;
  const issues: ConfigLintIssue[] = [];
  const activeRules = rules.filter((r) => r.isActive);

  // ── 逐规则检查 ──
  for (const rule of activeRules) {
    if (rule.holdPeriodDays < 7) {
      issues.push({
        level: 'WARNING',
        code: 'SHORT_HOLD_PERIOD',
        message: `冻结期 ${rule.holdPeriodDays} 天 < 7 天，退款风险窗口不足`,
        ruleId: rule.id,
      });
    }
    for (const component of rule.components) {
      // PRODUCT 组件：缺 productRef / 未注册发放 hook → 阻断
      if (component.componentType === 'PRODUCT') {
        if (!component.productRef) {
          issues.push({
            level: 'ERROR',
            code: 'PRODUCT_MISSING_REF',
            message: 'PRODUCT 组件缺少 productRef，无法定位要发放的产品',
            ruleId: rule.id,
          });
        }
        if (hasProductGrantHook !== true) {
          issues.push({
            level: 'ERROR',
            code: 'PRODUCT_MISSING_HOOK',
            message: '存在 PRODUCT 组件但未注册 onProductRewardGrant hook，奖励将无法发放',
            ruleId: rule.id,
          });
        }
      }
      // USAGE_INVOICE + CASH_FIXED 未设最低可佣金额 → 一笔 $1 账单返 $5，直接穿仓
      if (
        rule.triggerScope === 'USAGE_INVOICE' &&
        component.componentType === 'CASH_FIXED' &&
        component.minCommissionableAmountCents == null
      ) {
        issues.push({
          level: 'ERROR',
          code: 'USAGE_CASH_FIXED_NO_MIN',
          message: 'USAGE_INVOICE 场景的 CASH_FIXED 组件未设 minCommissionableAmountCents，小额账单会穿仓',
          ruleId: rule.id,
        });
      }
      // DYNAMIC 组件检查
      if (component.valueMode === 'DYNAMIC') {
        const ladder = component.dynamicConfig?.ladder ?? [];
        lintLadder(ladder, rule.id, issues);
        // ORDER_AMOUNT 驱动的固定金额档：某档金额 > 该档订单金额下限 → 该档必亏
        if (
          component.componentType === 'CASH_FIXED' &&
          component.dynamicConfig?.driverVariable === 'ORDER_AMOUNT'
        ) {
          for (const step of ladder) {
            if (step.value > step.from) {
              issues.push({
                level: 'ERROR',
                code: 'LADDER_FIXED_EXCEEDS_BAND',
                message: `阶梯档 [${step.from}, ${step.to ?? '∞'}) 固定佣金 ${step.value} cents 超过该档订单金额下限`,
                ruleId: rule.id,
              });
            }
          }
        }
        // 动态现金组件未设单笔封顶
        if (component.componentType !== 'PRODUCT' && component.maxValueCents == null) {
          issues.push({
            level: 'WARNING',
            code: 'DYNAMIC_NO_CAP',
            message: 'DYNAMIC 现金组件未设 maxValueCents 单笔封顶',
            ruleId: rule.id,
          });
        }
      }
      // GROSS_BASED + 最坏情况比例 > 30%
      if (component.componentType === 'CASH_PERCENT' && rule.commissionBase === 'GROSS_BASED') {
        const worstRate =
          component.valueMode === 'DYNAMIC'
            ? Math.max(0, ...(component.dynamicConfig?.ladder ?? []).map((s) => s.value))
            : (component.fixedValue ?? 0);
        if (worstRate > 0.3) {
          issues.push({
            level: 'WARNING',
            code: 'HIGH_GROSS_RATE',
            message: `GROSS_BASED 计佣且比例 ${(worstRate * 100).toFixed(0)}% > 30%，未扣手续费即分佣利润空间极小`,
            ruleId: rule.id,
          });
        }
      }
    }
  }

  // ── 按触发场景聚合检查（多级合计 / 最坏情况盈亏） ──
  const scopes = [...new Set(activeRules.map((r) => r.triggerScope))];
  for (const scope of scopes) {
    const scopeRules = activeRules.filter((r) => r.triggerScope === scope);
    // 多级佣金率合计 ≥ 100%（最坏情况：DYNAMIC 取最高档）
    const rateSum = scopeRules.reduce((sum, rule) => {
      return (
        sum +
        rule.components.reduce((s, c) => {
          if (c.componentType !== 'CASH_PERCENT') return s;
          const worst =
            c.valueMode === 'DYNAMIC'
              ? Math.max(0, ...(c.dynamicConfig?.ladder ?? []).map((st) => st.value))
              : (c.fixedValue ?? 0);
          return s + worst;
        }, 0)
      );
    }, 0);
    if (rateSum >= 1) {
      issues.push({
        level: 'ERROR',
        code: 'RATE_SUM_GTE_100',
        message: `${scope} 场景多级佣金率合计 ${(rateSum * 100).toFixed(0)}% ≥ 100%`,
      });
    }
    // 最坏情况（最高档 + 多级合计）盈亏为负 → 阻断（含 GROSS 计佣负利润）
    const estimate = estimateProfitability({
      orderAmountCents: sampleOrderCents,
      rules: scopeRules,
      stripeFee,
    });
    if (estimate.platformNetCents < 0) {
      issues.push({
        level: 'ERROR',
        code: 'NEGATIVE_PROFIT',
        message: `${scope} 场景最坏情况下平台亏损 ${-estimate.platformNetCents} cents（样本订单 ${sampleOrderCents} cents）`,
      });
    }
  }

  // ── 风控配置（WARNING） ──
  if (!autoReviewRules?.requireVerifiedEmail) {
    issues.push({
      level: 'WARNING',
      code: 'EMAIL_VERIFICATION_DISABLED',
      message: '未启用邮箱验证（requireVerifiedEmail），批量注册薅羊毛风险高',
    });
  }
  if (autoReviewRules?.maxInvitesPerDay == null) {
    issues.push({
      level: 'WARNING',
      code: 'NO_DAILY_INVITE_LIMIT',
      message: '未设置单日邀请上限（maxInvitesPerDay）',
    });
  }

  // ── 打款配置（INFO） ──
  if (payout?.minPayoutThresholdCents == null) {
    issues.push({
      level: 'INFO',
      code: 'NO_PAYOUT_THRESHOLD',
      message: '未配置提现门槛，建议 ≥ $50 以降低打款手续费占比',
    });
  }
  if (payout?.provider == null) {
    issues.push({
      level: 'INFO',
      code: 'NO_PAYOUT_PROVIDER',
      message: '未选择打款通道，请先完成 Step 4 结算配置',
    });
  }

  const errors = issues.filter((i) => i.level === 'ERROR').length;
  const warnings = issues.filter((i) => i.level === 'WARNING').length;
  return {
    ok: errors === 0,
    errors,
    warnings,
    infos: issues.length - errors - warnings,
    issues,
  };
}
