export type {
  Catalog,
  CatalogPlan,
  CatalogPrice,
  CatalogProduct,
  Entitlement,
  BillingStatus,
  ReferralStats,
  ReferralInvite,
  ReferralCommission,
  ReferralClientEvent,
} from './types.js';

export { provideBillingConfig, useBillingConfig } from './client.js';
export type { BillingClientConfig } from './client.js';

export {
  usePlans,
  useCheckout,
  useBillingStatus,
  usePortal,
  useReferrals,
  useReferralEvents,
} from './composables.js';
export type {
  UsePlansResult,
  UseCheckoutResult,
  UseBillingStatusResult,
  UsePortalResult,
  UseReferralsResult,
  UseReferralEventsOptions,
  ReferralEventsMode,
} from './composables.js';
