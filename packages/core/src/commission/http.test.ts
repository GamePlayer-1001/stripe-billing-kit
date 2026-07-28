import { describe, expect, it } from 'vitest';
import { handleBillingRequest, type BillingHttpRequest } from '../http.js';
import { testConfig } from '../testing.js';
import type { BillingConfig } from '../config.js';
import { InMemoryCommissionStorage } from './storage-memory.js';
import { ReferralService } from './referrals.js';
import { CommissionEngine } from './engine.js';
import type { CommissionRuleRow } from './types.js';

/** 组装启用佣金模块的完整 BillingConfig */
function setup(opts?: { requireReview?: boolean }) {
  const storage = new InMemoryCommissionStorage();
  const referrals = new ReferralService({ storage, inviteLinkTemplate: 'https://app.test/r/{CODE}' });
  const engine = new CommissionEngine({ config: { programId: 'default', storage } });
  const rule: CommissionRuleRow = {
    id: 'rule_http',
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
  return s.storage.allCommissions()[0]!.id;
}

describe('commission REST 端点', () => {
  it('未启用佣金模块时所有佣金端点 404', async () => {
    const config = testConfig();
    const res = await handleBillingRequest(config, req({ method: 'POST', path: 'referrals/generate', userId: 'u1' }));
    expect(res.status).toBe(404);
  });

  it('POST referrals/generate：登录后返回邀请码与链接；未登录 401', async () => {
    const { config } = setup();
    expect((await handleBillingRequest(config, req({ method: 'POST', path: 'referrals/generate' }))).status).toBe(401);

    const res = await handleBillingRequest(config, req({ method: 'POST', path: 'referrals/generate', userId: 'u1' }));
    expect(res.status).toBe(200);
    const body = res.body as { code: string; link: string };
    expect(body.code).toMatch(/^[A-Z0-9]+$/);
    expect(body.link).toBe(`https://app.test/r/${body.code}`);
  });

  it('POST referrals/validate-code：公开端点，不回传 referrerUserId', async () => {
    const s = setup();
    const code = (await s.referrals.getOrCreateCode('referrer')).code;

    const ok = await handleBillingRequest(s.config, req({ method: 'POST', path: 'referrals/validate-code', jsonBody: { code } }));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ valid: true, reason: null }); // 不泄露推荐人 ID

    const bad = await handleBillingRequest(s.config, req({ method: 'POST', path: 'referrals/validate-code', jsonBody: { code: 'NOPE1234' } }));
    expect(bad.body).toEqual({ valid: false, reason: 'NOT_FOUND' });

    // 自推检测：登录者用自己的码 → SELF_REFERRAL
    const self = await handleBillingRequest(s.config, req({ method: 'POST', path: 'referrals/validate-code', jsonBody: { code }, userId: 'referrer' }));
    expect(self.body).toEqual({ valid: false, reason: 'SELF_REFERRAL' });
  });

  it('POST referral/change-referrer：更换推荐人；无效码 400', async () => {
    const s = setup();
    const codeA = (await s.referrals.getOrCreateCode('userA')).code;
    const codeB = (await s.referrals.getOrCreateCode('userB')).code;
    await s.referrals.bindReferee('buyer', codeA);

    const res = await handleBillingRequest(s.config, req({ method: 'POST', path: 'referral/change-referrer', jsonBody: { code: codeB }, userId: 'buyer' }));
    expect(res.status).toBe(200);

    const bad = await handleBillingRequest(s.config, req({ method: 'POST', path: 'referral/change-referrer', jsonBody: { code: 'NOPE1234' }, userId: 'buyer' }));
    expect(bad.status).toBe(400);
  });

  it('GET referrals/:userId/commissions：仅本人可查；他人 403；管理员放行', async () => {
    const s = setup();
    await seedCommission(s, 'order_http1');

    const mine = await handleBillingRequest(s.config, req({ method: 'GET', path: 'referrals/referrer/commissions', userId: 'referrer' }));
    expect(mine.status).toBe(200);
    expect((mine.body as { items: unknown[] }).items).toHaveLength(1);

    const other = await handleBillingRequest(s.config, req({ method: 'GET', path: 'referrals/referrer/commissions', userId: 'someone' }));
    expect(other.status).toBe(403);

    const admin = await handleBillingRequest(s.config, req({ method: 'GET', path: 'referrals/referrer/commissions', userId: 'ops', isAdmin: true }));
    expect(admin.status).toBe(200);
  });

  it('GET commissions 分页：limit/offset 生效且有上限保护', async () => {
    const s = setup();
    await seedCommission(s, 'order_pg1');
    await s.engine.calculateCommissions({
      userId: 'buyer', orderId: 'order_pg2', planKey: 'pro', planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT', amountTotal: 5000, currency: 'USD',
    });

    const page = await handleBillingRequest(s.config, req({
      method: 'GET', path: 'referrals/referrer/commissions', userId: 'referrer',
      query: { limit: '1', offset: '1' },
    }));
    const body = page.body as { items: unknown[]; limit: number; offset: number };
    expect(body.items).toHaveLength(1);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);

    // 非法参数回退默认值
    const fallback = await handleBillingRequest(s.config, req({
      method: 'GET', path: 'referrals/referrer/commissions', userId: 'referrer',
      query: { limit: 'abc', offset: '-5' },
    }));
    expect((fallback.body as { limit: number; offset: number }).limit).toBe(20);
    expect((fallback.body as { limit: number; offset: number }).offset).toBe(0);
  });

  it('POST admin/commissions/:id/review：非管理员 403；approve 走状态机', async () => {
    const s = setup({ requireReview: true });
    const id = await seedCommission(s, 'order_rv1');
    expect(s.storage.getCommission(id)?.status).toBe('PENDING');

    const noAuth = await handleBillingRequest(s.config, req({ method: 'POST', path: `admin/commissions/${id}/review`, jsonBody: { action: 'approve' }, userId: 'u1' }));
    expect(noAuth.status).toBe(403);

    const ok = await handleBillingRequest(s.config, req({ method: 'POST', path: `admin/commissions/${id}/review`, jsonBody: { action: 'approve' }, userId: 'ops', isAdmin: true }));
    expect(ok.status).toBe(200);
    expect(s.storage.getCommission(id)?.status).toBe('APPROVED');

    // 重复审批 → Layer 3 状态机拒绝 409
    const dup = await handleBillingRequest(s.config, req({ method: 'POST', path: `admin/commissions/${id}/review`, jsonBody: { action: 'approve' }, userId: 'ops', isAdmin: true }));
    expect(dup.status).toBe(409);
  });

  it('POST review：拒绝必填原因；reject 后状态 REJECTED', async () => {
    const s = setup({ requireReview: true });
    const id = await seedCommission(s, 'order_rv2');

    const noReason = await handleBillingRequest(s.config, req({ method: 'POST', path: `admin/commissions/${id}/review`, jsonBody: { action: 'reject' }, userId: 'ops', isAdmin: true }));
    expect(noReason.status).toBe(400);

    const ok = await handleBillingRequest(s.config, req({ method: 'POST', path: `admin/commissions/${id}/review`, jsonBody: { action: 'reject', reason: '刷单嫌疑' }, userId: 'ops', isAdmin: true }));
    expect(ok.status).toBe(200);
    expect(s.storage.getCommission(id)?.status).toBe('REJECTED');
  });

  it('未命中的佣金路径仍然 404', async () => {
    const { config } = setup();
    const res = await handleBillingRequest(config, req({ method: 'GET', path: 'referrals/unknown/route/x', userId: 'u1' }));
    expect(res.status).toBe(404);
  });

  it('GET referrals/:userId/stats：仅本人可查；统计口径与转化率正确', async () => {
    const s = setup();
    const id = await seedCommission(s, 'order_st1'); // 首付 10000 × 20% = 2000（转化闭环自增 convertedCount）

    const noAuth = await handleBillingRequest(s.config, req({ path: 'referrals/referrer/stats' }));
    expect(noAuth.status).toBe(401);
    const other = await handleBillingRequest(s.config, req({ path: 'referrals/referrer/stats', userId: 'someone' }));
    expect(other.status).toBe(403);

    const res = await handleBillingRequest(s.config, req({ path: 'referrals/referrer/stats', userId: 'referrer' }));
    expect(res.status).toBe(200);
    const body = res.body as Record<string, number>;
    expect(body.totalInvites).toBe(1);
    expect(body.convertedCount).toBe(1); // 首付计佣后转化闭环
    expect(body.activeRelationships).toBe(1); // PENDING → ACTIVE
    expect(body.conversionRate).toBe(100);
    expect(body.totalEarnings).toBe(2000);
    expect(body.pendingCommissions).toBe(2000); // AUTO_APPROVED → APPROVED 仍属待结算
    expect(body.paidThisMonth).toBe(0);

    // 打款后：待结算清零，本月已发放入账
    await s.engine.markCommissionPaid(id);
    const paid = await handleBillingRequest(s.config, req({ path: 'referrals/referrer/stats', userId: 'referrer' }));
    const paidBody = paid.body as Record<string, number>;
    expect(paidBody.pendingCommissions).toBe(0);
    expect(paidBody.paidThisMonth).toBe(2000);
    expect(paidBody.totalEarnings).toBe(2000);
  });
});
