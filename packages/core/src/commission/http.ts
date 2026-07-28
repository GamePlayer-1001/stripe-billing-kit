/**
 * 佣金/邀请返利 REST 端点（对应 docs/COMMISSION-SYSTEM-SPEC.md 6.0）。
 *
 * 路由挂在主管线 handleBillingRequest 的兜底分支：主端点未命中时才进入这里，
 * 未启用佣金模块（config.commission 缺失）返回 null → 主管线照常 404。
 *
 * 鉴权约定（与主管线一致，由适配器注入身份）：
 * - 登录态端点：req.userId 为空 → 401
 * - 仅本人端点：路径 :userId ≠ req.userId → 403
 * - 管理端点：req.isAdmin !== true → 403
 * - validate-code 为公开端点：限流（IP + code 双维度）由适配层/网关实现，core 不做
 */
import type { BillingContext } from '../config.js';
import type { BillingHttpRequest, BillingHttpResponse } from '../http.js';

const json = (status: number, body: unknown): BillingHttpResponse => ({ status, body });
const unauthorized = () => json(401, { error: 'unauthorized', message: '请先登录' });
const forbidden = () => json(403, { error: 'forbidden', message: '无权访问' });

/** 解析分页参数：limit 默认 20（1~100），offset 默认 0（≥0） */
function parsePagination(query: Record<string, string | undefined> | undefined): {
  limit: number;
  offset: number;
} {
  const rawLimit = Number(query?.['limit']);
  const rawOffset = Number(query?.['offset']);
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  return { limit, offset };
}

/**
 * 佣金端点路由。命中则返回响应，未命中返回 null（交回主管线 404）。
 */
export async function handleCommissionRequest(
  ctx: BillingContext,
  req: BillingHttpRequest,
): Promise<BillingHttpResponse | null> {
  const commission = ctx.config.commission;
  if (!commission) return null;

  const method = req.method.toUpperCase();
  const path = req.path.replace(/^\/+|\/+$/g, '');
  const route = `${method} ${path}`;
  const referrals = commission.referrals;
  const engine = commission.engine;

  // ── POST referrals/generate：生成/获取我的邀请码与链接（登录态） ──
  if (route === 'POST referrals/generate') {
    if (!referrals) return null; // 未装配 ReferralService → 端点不存在
    if (!req.userId) return unauthorized();
    const row = await referrals.getOrCreateCode(req.userId);
    return json(200, {
      code: row.code,
      link: referrals.buildInviteLink(row.code),
      isActive: row.isActive,
      totalInvites: row.totalInvites,
      convertedCount: row.convertedCount,
    });
  }

  // ── POST referrals/validate-code：注册页校验（公开；不回传 referrerUserId 防用户枚举） ──
  if (route === 'POST referrals/validate-code') {
    if (!referrals) return null;
    const body = (req.jsonBody ?? {}) as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code : null;
    const result = await referrals.validateCode(code, req.userId ?? undefined);
    return json(200, { valid: result.valid, reason: result.reason ?? null });
  }

  // ── POST referral/change-referrer：更换推荐人（登录态；频率限制由产品侧配置） ──
  if (route === 'POST referral/change-referrer') {
    if (!referrals) return null;
    if (!req.userId) return unauthorized();
    const body = (req.jsonBody ?? {}) as { code?: unknown };
    if (typeof body.code !== 'string' || !body.code) {
      return json(400, { error: 'invalid_code', message: 'code 必填' });
    }
    const result = await referrals.changeReferrer(req.userId, body.code);
    if (!result.bound) {
      return json(400, { error: 'change_rejected', reason: result.reason });
    }
    return json(200, { bound: true, relationshipId: result.relationshipId });
  }

  // ── GET referrals/:userId/commissions：佣金明细分页（登录态，仅本人） ──
  const mCommissions = method === 'GET' ? path.match(/^referrals\/([^/]+)\/commissions$/) : null;
  if (mCommissions) {
    const targetUserId = decodeURIComponent(mCommissions[1]!);
    if (!req.userId) return unauthorized();
    if (req.userId !== targetUserId && !req.isAdmin) return forbidden();
    const { limit, offset } = parsePagination(req.query);
    const rows = await engine.storage.listCommissionsByReferrer(targetUserId, { limit, offset });
    return json(200, { items: rows, limit, offset });
  }

  // ── GET admin/audit-queue：人工审核队列（管理员；riskScore 倒序） ──
  if (route === 'GET admin/audit-queue') {
    if (!req.isAdmin) return forbidden();
    const { limit, offset } = parsePagination(req.query);
    const rawStatus = req.query?.['status'];
    const status =
      rawStatus === 'PENDING' || rawStatus === 'IN_PROGRESS' || rawStatus === 'APPROVED' ||
      rawStatus === 'REJECTED' || rawStatus === 'ESCALATED'
        ? rawStatus
        : undefined;
    const items = await engine.storage.listAuditQueue({ status, limit, offset });
    return json(200, { items, limit, offset });
  }

  // ── POST admin/commissions/:id/review：审批/拒绝佣金（管理员；拒绝必填原因） ──
  const mReview = method === 'POST' ? path.match(/^admin\/commissions\/([^/]+)\/review$/) : null;
  if (mReview) {
    if (!req.isAdmin) return forbidden();
    const commissionId = decodeURIComponent(mReview[1]!);
    const body = (req.jsonBody ?? {}) as { action?: unknown; reason?: unknown };
    if (body.action !== 'approve' && body.action !== 'reject') {
      return json(400, { error: 'invalid_action', message: 'action 必须为 approve 或 reject' });
    }
    if (body.action === 'reject' && (typeof body.reason !== 'string' || !body.reason.trim())) {
      return json(400, { error: 'reason_required', message: '拒绝佣金必须填写原因' });
    }
    const ok =
      body.action === 'approve'
        ? await engine.approveCommission(commissionId)
        : await engine.rejectCommission(commissionId, body.reason as string);
    if (!ok) {
      // Layer 3 状态机拒绝：非 PENDING（已审/已拒/已退款）或 ID 不存在
      return json(409, { error: 'invalid_state', message: '佣金不存在或状态不允许该操作' });
    }
    return json(200, { ok: true, action: body.action });
  }

  return null;
}
