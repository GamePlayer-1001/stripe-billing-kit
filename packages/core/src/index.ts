import type { BillingConfig } from './config.js';
import { createBillingContext } from './config.js';
import { getCatalog as getCatalogCtx, invalidateCatalogCache as invalidateCtx, resolvePriceId as resolvePriceIdCtx, type Catalog } from './catalog.js';
import { createCheckoutSession as createCheckoutCtx, type CreateCheckoutInput, type CreateCheckoutResult } from './checkout.js';
import { createPortalSession as createPortalCtx } from './portal.js';
import { syncStripeToDb as syncCtx, syncCheckoutSession as syncSessionCtx } from './sync.js';
import { getEntitlements as getEntCtx, hasAccess as hasAccessCtx, type BillingStatus } from './entitlements.js';
import { handleWebhookRequest as handleWebhookCtx, type WebhookResult } from './webhook.js';

/**
 * 公开 API 统一接受 BillingConfig(createBillingContext 内部有 WeakMap 缓存,
 * 同一 config 对象共享同一 Stripe client 与 catalog 缓存,重复调用零开销)。
 */

export async function getCatalog(config: BillingConfig): Promise<Catalog> {
  return getCatalogCtx(createBillingContext(config));
}

export function invalidateCatalogCache(config: BillingConfig): void {
  invalidateCtx(createBillingContext(config));
}

export async function resolvePriceId(config: BillingConfig, planKey: string): Promise<string> {
  return resolvePriceIdCtx(createBillingContext(config), planKey);
}

export async function createCheckoutSession(
  config: BillingConfig,
  input: CreateCheckoutInput,
): Promise<CreateCheckoutResult> {
  return createCheckoutCtx(createBillingContext(config), input);
}

export async function createPortalSession(config: BillingConfig, userId: string): Promise<{ url: string }> {
  return createPortalCtx(createBillingContext(config), userId);
}

export async function syncStripeToDb(config: BillingConfig, stripeCustomerId: string): Promise<void> {
  return syncCtx(createBillingContext(config), stripeCustomerId);
}

export async function syncCheckoutSession(config: BillingConfig, sessionId: string): Promise<void> {
  return syncSessionCtx(createBillingContext(config), sessionId);
}

export async function getEntitlements(config: BillingConfig, userId: string): Promise<BillingStatus> {
  return getEntCtx(createBillingContext(config), userId);
}

export async function hasAccess(config: BillingConfig, userId: string, feature: string): Promise<boolean> {
  return hasAccessCtx(createBillingContext(config), userId, feature);
}

export async function handleWebhookRequest(
  config: BillingConfig,
  rawBody: string | Buffer,
  signature: string | null,
): Promise<WebhookResult> {
  return handleWebhookCtx(createBillingContext(config), rawBody, signature);
}

// ── 配置与上下文 ──
export type {
  BillingConfig,
  BillingContext,
  BillingHooks,
  BillingLogger,
  PlanDef,
  PlanRef,
  PlanType,
  CheckoutCompletedContext,
  SubscriptionChangedContext,
  PaymentFailedContext,
} from './config.js';
export { createBillingContext } from './config.js';

// ── 类型 ──
export type { Catalog, CatalogPlan, CatalogPrice, CatalogProduct } from './catalog.js';
export type { CreateCheckoutInput, CreateCheckoutResult } from './checkout.js';
export type { Entitlement, BillingStatus } from './entitlements.js';
export type { WebhookResult } from './webhook.js';

// ── HTTP 契约(适配器用)──
export type { BillingHttpRequest, BillingHttpResponse } from './http.js';
export { handleBillingRequest } from './http.js';

// ── 存储 ──
export type { StorageAdapter, CustomerRow, SubscriptionRow, PurchaseRow } from './storage/types.js';

// ── 错误 ──
export { BillingError, isBillingError } from './errors.js';

// ── 按量计费（metered）──
export {
  reportUsage,
  getMeterUsage,
} from './metered.js';
export type { ReportUsageInput, ReportUsageResult, GetMeterUsageInput, GetMeterUsageResult } from './metered.js';

// ── 额度包 + 日付通行证（entitlements 扩展）──
export {
  getCreditBalance,
  consumeUserCredit,
  isDailyPassActive,
} from './entitlements.js';

export type { BillingErrorCode } from './errors.js';
