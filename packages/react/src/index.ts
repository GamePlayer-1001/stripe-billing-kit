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

export { BillingProvider, useBillingBasePath } from './client.js';
export type { BillingClientConfig } from './client.js';

export { usePlans, useCheckout, useBillingStatus, usePortal, useReferrals, useReferralEvents } from './hooks.js';
export type {
  UsePlansResult,
  UseCheckoutResult,
  UseBillingStatusResult,
  UsePortalResult,
  UseReferralsResult,
  UseReferralEventsOptions,
  ReferralEventsMode,
} from './hooks.js';

export { PricingSection, SubscriptionGate, BillingPortalButton } from './components.js';
export type {
  PricingSectionProps,
  PricingSectionRenderProps,
  SubscriptionGateProps,
  BillingPortalButtonProps,
} from './components.js';
