import type { CustomerRow, PurchaseRow, StorageAdapter, SubscriptionRow } from './types.js';

/** 内存存储:单测与本地试跑用,不要用于生产 */
export function memoryStorage(): StorageAdapter & {
  dump(): { customers: CustomerRow[]; subs: SubscriptionRow[]; purchases: PurchaseRow[]; events: string[] };
} {
  const customers = new Map<string, CustomerRow>();
  const subs = new Map<string, SubscriptionRow>();
  const purchases = new Map<string, PurchaseRow>();
  const events = new Set<string>();

  return {
    async getCustomerByUserId(userId) {
      return customers.get(userId) ?? null;
    },
    async getCustomerByStripeCustomerId(stripeCustomerId) {
      for (const row of customers.values()) {
        if (row.stripeCustomerId === stripeCustomerId) return row;
      }
      return null;
    },
    async upsertCustomer(row) {
      customers.set(row.userId, row);
    },
    async claimEvent(eventId) {
      if (events.has(eventId)) return false;
      events.add(eventId);
      return true;
    },
    async upsertSubscription(row) {
      subs.set(row.stripeSubscriptionId, row);
    },
    async insertPurchase(row) {
      if (!purchases.has(row.stripeSessionId)) purchases.set(row.stripeSessionId, row);
    },
    async getEntitlementRows(userId) {
      return {
        subs: [...subs.values()].filter((s) => s.userId === userId),
        purchases: [...purchases.values()].filter((p) => p.userId === userId),
      };
    },
    dump() {
      return {
        customers: [...customers.values()],
        subs: [...subs.values()],
        purchases: [...purchases.values()],
        events: [...events],
      };
    },
  };
}
