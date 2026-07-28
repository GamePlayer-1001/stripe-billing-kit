import { describe, expect, it } from 'vitest';
import { handleBillingRequest, type BillingHttpRequest } from '../http.js';
import { testConfig } from '../testing.js';
import type { BillingConfig } from '../config.js';
import { InMemoryCommissionStorage } from './storage-memory.js';
import { ReferralService } from './referrals.js';
import { CommissionEngine } from './engine.js';
import { evaluateAutoReview } from './audit.js';
import type { AuditQueueItemRow, CommissionRuleRow } from './types.js';

/** 组装启用佣金模块的完整 BillingConfig（requireReview=true 时所有佣金进人工审核） */
function setup(opts?: { requireReview?: boolean }) {
  const storage = new InMemoryCommissionStorage();
  const referrals = new ReferralService({ storage, inviteLinkTemplate: 'https://app.test/r/{CODE}' });
  const engine = new CommissionEngine({ config: { programId: 'default', storage } });
  const rule: CommissionRuleRow = {
    id: 'rule_audit',
    programId: 'default',
    planKey: null,
    triggerScope: 'FIRST_PAYMENT',
    tierLevel: null,
    components: [
      { componentType: 'CASH_PERCENT', valueMode: 'FIXED', fixedValue: 0.2 },
    ],
    commissionBase: 'GROSS_BASED',
    platformFeeHandlingMode: 'CONSUMED_BY_PLATFORM',
    holdPeriodDays: 30,
    autoApproveUnderCents: null,
    requireReviewOverCents: opts?.requireReview ? 0 : null,
    isActive: true,
    priority: 0,
  };
  storage.addRule(rule);
  const config: BillingConfig = testConfig({ commission: { engine, referrals } });
  return { storage, referrals, engine, config };
}

function req(partial: Partial<BillingHttpRequest>): BillingHttpRequest {
  return { method: 'GET', path: '', headers: {}, userId: null, ...partial };
}

/** 绑定关系并产生一笔佣金，返回佣金 ID */
async function seedCommission(s: ReturnType<typeof setup>, orderId: string): Promise<string> {
  const code = (await s.referrals.getOrCreateCode('referrer')).code;
  await s.referrals.bindReferee('buyer', code);
  await s.engine.calculateCommissions({
    userId: 'buyer',
    orderId,
    planKey: 'pro',
    planType: 'one_time',
    triggerScope: 'FIRST_PAYMENT',
    amountTotal: 10000,
    currency: 'USD',
  });
  return s.storage.allCommissions().find((c) => c.orderId === orderId)!.id;
}

function auditItem(partial: Partial<AuditQueueItemRow> & { commissionId: string }): AuditQueueItemRow {
  return {
    id: `aq_${partial.commissionId}`,
    reason: 'HIGH_AMOUNT',
    riskScore: 50,
    riskFactors: ['high_amount'],
    status: 'PENDING',
    assignedTo: null,
    reviewedAt: null,
    reviewNotes: null,
    createdAt: new Date(),
    ...partial,
  };
}

describe('evaluateAutoReview（Level 1 自动化实时审核）', () => {
  it('无规则/无输入时放行且零风险', () => {
    const r = evaluateAutoReview({}, {});
    expect(r).toEqual({ allowed: true, flagged: false, riskScore: 0, riskFactors: [], trigger: null });
  });

  it('邮箱域黑名单命中 → 阻断（大小写不敏感）', () => {
    const r = evaluateAutoReview(
      { blockedEmailDomains: ['TempMail.com'] },
      { email: 'abuse@tempmail.COM' },
    );
    expect(r.allowed).toBe(false);
    expect(r.riskFactors).toContain('blocked_email_domain');
    expect(r.riskScore).toBe(40);
  });

  it('要求邮箱验证但未验证 → 阻断；未提供验证状态则跳过规则', () => {
    expect(evaluateAutoReview({ requireVerifiedEmail: true }, { emailVerified: false }).allowed).toBe(false);
    expect(evaluateAutoReview({ requireVerifiedEmail: true }, {}).allowed).toBe(true);
  });

  it('注册冷却期内 → 阻断；冷却期已过 → 放行', () => {
    const now = new Date('2026-07-27T12:00:00Z');
    const rules = { cooldownHoursAfterRegistration: 24 };
    const fresh = evaluateAutoReview(rules, { registeredAt: new Date('2026-07-27T00:00:00Z'), now });
    expect(fresh.allowed).toBe(false);
    expect(fresh.riskFactors).toContain('registration_cooldown');

    const aged = evaluateAutoReview(rules, { registeredAt: new Date('2026-07-20T00:00:00Z'), now });
    expect(aged.allowed).toBe(true);
  });

  it('单日邀请数超限 → 标记不阻断，trigger=RAPID_GROWTH', () => {
    const r = evaluateAutoReview({ maxInvitesPerDay: 10 }, { invitesToday: 11 });
    expect(r.allowed).toBe(true);
    expect(r.flagged).toBe(true);
    expect(r.trigger).toBe('RAPID_GROWTH');
    expect(r.riskScore).toBe(20);
  });

  it('同设备关联账户达阈值 → trigger=SAME_DEVICE；与阻断项并存时不再 flagged', () => {
    const flag = evaluateAutoReview({ sameDeviceThreshold: 3 }, { sameDeviceAccounts: 3 });
    expect(flag.trigger).toBe('SAME_DEVICE');

    // 阻断优先：allowed=false 时 flagged=false 且 trigger 置空，评分累加
    const both = evaluateAutoReview(
      { requireVerifiedEmail: true, sameDeviceThreshold: 3 },
      { emailVerified: false, sameDeviceAccounts: 5 },
    );
    expect(both.allowed).toBe(false);
    expect(both.flagged).toBe(false);
    expect(both.trigger).toBeNull();
    expect(both.riskScore).toBe(60); // 40（阻断）+ 20（标记）
  });
});

describe('人工审核队列（Level 2）', () => {
  it('MANUAL_REVIEW 佣金自动入队；AUTO_APPROVED 不入队', async () => {
    const s = setup({ requireReview: true });
    const id = await seedCommission(s, 'order_aq1');
    const item = s.storage.getAuditItem(id);
    expect(item).toBeDefined();
    expect(item!.reason).toBe('HIGH_AMOUNT');
    expect(item!.status).toBe('PENDING');
    expect(item!.riskScore).toBe(50);

    const auto = setup();
    const autoId = await seedCommission(auto, 'order_aq2');
    expect(auto.storage.getAuditItem(autoId)).toBeUndefined();
  });

  it('webhook 重放不重复入队（insert 幂等）', async () => {
    const s = setup({ requireReview: true });
    const id = await seedCommission(s, 'order_aq_replay');
    const first = s.storage.getAuditItem(id)!;
    await s.engine.calculateCommissions({
      userId: 'buyer', orderId: 'order_aq_replay', planKey: 'pro', planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT', amountTotal: 10000, currency: 'USD',
    });
    expect(s.storage.getAuditItem(id)!.id).toBe(first.id);
  });

  it('approve/reject 联动更新队列状态与审核备注', async () => {
    const s = setup({ requireReview: true });
    const id = await seedCommission(s, 'order_aq3');

    expect(await s.engine.approveCommission(id)).toBe(true);
    const approved = s.storage.getAuditItem(id)!;
    expect(approved.status).toBe('APPROVED');
    expect(approved.reviewedAt).toBeInstanceOf(Date);

    const s2 = setup({ requireReview: true });
    const id2 = await seedCommission(s2, 'order_aq4');
    expect(await s2.engine.rejectCommission(id2, '刷单嫌疑')).toBe(true);
    const rejected = s2.storage.getAuditItem(id2)!;
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.reviewNotes).toBe('刷单嫌疑');
  });
});

describe('GET admin/audit-queue 端点', () => {
  it('非管理员 403；管理员按 riskScore 倒序返回', async () => {
    const s = setup({ requireReview: true });
    await s.storage.insertAuditQueueItem(auditItem({ commissionId: 'c_low', riskScore: 30 }));
    await s.storage.insertAuditQueueItem(auditItem({ commissionId: 'c_high', riskScore: 90 }));

    const noAuth = await handleBillingRequest(s.config, req({ path: 'admin/audit-queue', userId: 'u1' }));
    expect(noAuth.status).toBe(403);

    const res = await handleBillingRequest(s.config, req({ path: 'admin/audit-queue', userId: 'ops', isAdmin: true }));
    expect(res.status).toBe(200);
    const items = (res.body as { items: AuditQueueItemRow[] }).items;
    expect(items.map((i) => i.commissionId)).toEqual(['c_high', 'c_low']);
  });

  it('status 白名单过滤：非法值忽略、合法值生效', async () => {
    const s = setup({ requireReview: true });
    await s.storage.insertAuditQueueItem(auditItem({ commissionId: 'c_p', status: 'PENDING' }));
    await s.storage.insertAuditQueueItem(auditItem({ commissionId: 'c_a', status: 'APPROVED' }));

    const filtered = await handleBillingRequest(s.config, req({
      path: 'admin/audit-queue', userId: 'ops', isAdmin: true, query: { status: 'APPROVED' },
    }));
    const items = (filtered.body as { items: AuditQueueItemRow[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.commissionId).toBe('c_a');

    const bogus = await handleBillingRequest(s.config, req({
      path: 'admin/audit-queue', userId: 'ops', isAdmin: true, query: { status: 'HACK' },
    }));
    expect((bogus.body as { items: unknown[] }).items).toHaveLength(2);
  });
});
