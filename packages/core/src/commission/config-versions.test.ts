import { describe, expect, it } from 'vitest';
import { handleBillingRequest, type BillingHttpRequest } from '../http.js';
import { testConfig } from '../testing.js';
import type { BillingConfig } from '../config.js';
import { InMemoryCommissionStorage } from './storage-memory.js';
import { CommissionEngine } from './engine.js';
import type { CommissionRuleRow, ConfigVersionRow } from './types.js';

function makeRule(id: string, fixedValue: number): CommissionRuleRow {
  return {
    id,
    programId: 'default',
    planKey: null,
    triggerScope: 'FIRST_PAYMENT',
    tierLevel: null,
    components: [{ componentType: 'CASH_PERCENT', valueMode: 'FIXED', fixedValue }],
    commissionBase: 'GROSS_BASED',
    platformFeeHandlingMode: 'CONSUMED_BY_PLATFORM',
    holdPeriodDays: 30,
    autoApproveUnderCents: null,
    requireReviewOverCents: null,
    isActive: true,
    priority: 0,
  };
}

function setup() {
  const storage = new InMemoryCommissionStorage();
  const engine = new CommissionEngine({ config: { programId: 'default', storage } });
  storage.addRule(makeRule('rule_v1', 0.2));
  const config: BillingConfig = testConfig({ commission: { engine } });
  return { storage, engine, config };
}

function req(partial: Partial<BillingHttpRequest>): BillingHttpRequest {
  return { method: 'GET', path: '', headers: {}, userId: null, ...partial };
}

describe('配置版本控制（快照/回滚）', () => {
  it('snapshotConfigVersion：版本号自增，快照捕获当前规则集并标记 latest', async () => {
    const s = setup();
    const v1 = await s.engine.snapshotConfigVersion({ notes: '初始配置', createdBy: 'ops' });
    expect(v1).not.toBeNull();
    expect(v1!.versionNumber).toBe(1);
    expect(v1!.snapshot.rules.map((r) => r.id)).toEqual(['rule_v1']);
    expect(v1!.isLatest).toBe(true);
    expect(v1!.notes).toBe('初始配置');
    expect(v1!.createdBy).toBe('ops');

    // 改规则后再快照 → 版本 2 成为 latest，版本 1 退位
    await s.storage.replaceRules('default', [makeRule('rule_v2', 0.3)]);
    const v2 = await s.engine.snapshotConfigVersion();
    expect(v2!.versionNumber).toBe(2);
    expect(v2!.snapshot.rules.map((r) => r.id)).toEqual(['rule_v2']);

    const list = await s.storage.listConfigVersions('default');
    expect(list.map((v) => [v.versionNumber, v.isLatest])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it('activateConfigVersion：回滚把快照规则替换回规则表；不存在的版本返回 false', async () => {
    const s = setup();
    await s.engine.snapshotConfigVersion(); // v1: rule_v1 @ 0.2
    await s.storage.replaceRules('default', [makeRule('rule_v2', 0.3)]);
    await s.engine.snapshotConfigVersion(); // v2: rule_v2 @ 0.3

    // 回滚到 v1
    expect(await s.engine.activateConfigVersion(1)).toBe(true);
    const rules = await s.storage.listActiveRules('default');
    expect(rules.map((r) => r.id)).toEqual(['rule_v1']);
    const v1 = await s.storage.getConfigVersion('default', 1);
    expect(v1!.isLatest).toBe(true);
    const v2 = await s.storage.getConfigVersion('default', 2);
    expect(v2!.isLatest).toBe(false);

    expect(await s.engine.activateConfigVersion(99)).toBe(false);
  });

  it('版本号并发冲突时 insertConfigVersion 返回 false（唯一约束）', async () => {
    const s = setup();
    const v1 = await s.engine.snapshotConfigVersion();
    const dup = await s.storage.insertConfigVersion({ ...v1!, id: 'other_id' });
    expect(dup).toBe(false);
  });

  it('GET admin/config/versions：非管理员 403；管理员按版本倒序分页', async () => {
    const s = setup();
    await s.engine.snapshotConfigVersion({ notes: 'v1' });
    await s.engine.snapshotConfigVersion({ notes: 'v2' });

    const noAuth = await handleBillingRequest(s.config, req({ path: 'admin/config/versions', userId: 'u1' }));
    expect(noAuth.status).toBe(403);

    const res = await handleBillingRequest(s.config, req({ path: 'admin/config/versions', userId: 'ops', isAdmin: true }));
    expect(res.status).toBe(200);
    const items = (res.body as { items: ConfigVersionRow[] }).items;
    expect(items.map((v) => v.versionNumber)).toEqual([2, 1]);
  });

  it('POST admin/config/versions：创建快照，createdBy 取当前管理员', async () => {
    const s = setup();
    const res = await handleBillingRequest(s.config, req({
      method: 'POST', path: 'admin/config/versions', jsonBody: { notes: '上线前留档' },
      userId: 'admin_1', isAdmin: true,
    }));
    expect(res.status).toBe(200);
    const body = res.body as ConfigVersionRow;
    expect(body.versionNumber).toBe(1);
    expect(body.notes).toBe('上线前留档');
    expect(body.createdBy).toBe('admin_1');
  });

  it('POST admin/config/versions/:n/activate：回滚生效；版本不存在 404', async () => {
    const s = setup();
    await s.engine.snapshotConfigVersion(); // v1
    await s.storage.replaceRules('default', [makeRule('rule_v2', 0.3)]);
    await s.engine.snapshotConfigVersion(); // v2

    const ok = await handleBillingRequest(s.config, req({
      method: 'POST', path: 'admin/config/versions/1/activate', userId: 'ops', isAdmin: true,
    }));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ activated: true, versionNumber: 1 });
    expect((await s.storage.listActiveRules('default')).map((r) => r.id)).toEqual(['rule_v1']);

    const missing = await handleBillingRequest(s.config, req({
      method: 'POST', path: 'admin/config/versions/99/activate', userId: 'ops', isAdmin: true,
    }));
    expect(missing.status).toBe(404);

    const noAuth = await handleBillingRequest(s.config, req({
      method: 'POST', path: 'admin/config/versions/1/activate', userId: 'u1',
    }));
    expect(noAuth.status).toBe(403);
  });
});
