import { ref, onMounted, onUnmounted, type Ref } from 'vue';
import { useBillingConfig } from './client.js';
import type { Catalog, BillingStatus } from './types.js';

export interface UsePlansResult {
  plans: Ref<Catalog['plans']>;
  isLoading: Ref<boolean>;
  error: Ref<Error | null>;
  refetch: () => Promise<void>;
}

export function usePlans(): UsePlansResult {
  const config = useBillingConfig();
  const plans = ref<Catalog['plans']>([]);
  const isLoading = ref(true);
  const error = ref<Error | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;

  const refetch = async () => {
    try {
      error.value = null;
      const res = await fetch(`${config.basePath}/catalog`);
      if (!res.ok) throw new Error(`获取商品目录失败: ${res.status}`);
      const data = (await res.json()) as Catalog;
      plans.value = data.plans;
    } catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e));
    } finally {
      isLoading.value = false;
    }
  };

  onMounted(async () => {
    await refetch();
    if (config.refetchInterval > 0) {
      timer = setInterval(refetch, config.refetchInterval);
    }
  });

  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });

  return { plans, isLoading, error, refetch };
}

export interface UseCheckoutResult {
  checkout: (planKey: string, quantity?: number) => Promise<void>;
  isPending: Ref<boolean>;
  error: Ref<Error | null>;
}

export function useCheckout(): UseCheckoutResult {
  const config = useBillingConfig();
  const isPending = ref(false);
  const error = ref<Error | null>(null);

  const checkout = async (planKey: string, quantity = 1) => {
    if (isPending.value) return;
    try {
      isPending.value = true;
      error.value = null;
      const res = await fetch(`${config.basePath}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planKey, quantity }),
      });
      if (!res.ok) throw new Error(`创建支付会话失败: ${res.status}`);
      const data = (await res.json()) as { url: string };
      if (typeof window !== 'undefined') {
        window.location.href = data.url;
      }
    } catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e));
      isPending.value = false;
    }
  };

  return { checkout, isPending, error };
}

export interface UseBillingStatusResult {
  status: Ref<BillingStatus | null>;
  isLoading: Ref<boolean>;
  error: Ref<Error | null>;
  refetch: () => Promise<void>;
  hasAccess: (feature: string) => boolean;
}

export function useBillingStatus(): UseBillingStatusResult {
  const config = useBillingConfig();
  const status = ref<BillingStatus | null>(null);
  const isLoading = ref(true);
  const error = ref<Error | null>(null);

  const refetch = async () => {
    try {
      isLoading.value = true;
      error.value = null;
      const res = await fetch(`${config.basePath}/me`);
      if (!res.ok) throw new Error(`获取权益状态失败: ${res.status}`);
      status.value = (await res.json()) as BillingStatus;
    } catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e));
    } finally {
      isLoading.value = false;
    }
  };

  const hasAccess = (feature: string): boolean => {
    if (!status.value) return false;
    return status.value.hasAccess[feature] ?? false;
  };

  onMounted(refetch);

  return { status, isLoading, error, refetch, hasAccess };
}

export interface UsePortalResult {
  openPortal: () => Promise<void>;
  isPending: Ref<boolean>;
  error: Ref<Error | null>;
}

export function usePortal(): UsePortalResult {
  const config = useBillingConfig();
  const isPending = ref(false);
  const error = ref<Error | null>(null);

  const openPortal = async () => {
    if (isPending.value) return;
    try {
      isPending.value = true;
      error.value = null;
      const res = await fetch(`${config.basePath}/portal`, { method: 'POST' });
      if (!res.ok) throw new Error(`打开客户门户失败: ${res.status}`);
      const data = (await res.json()) as { url: string };
      if (typeof window !== 'undefined') {
        window.location.href = data.url;
      }
    } catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e));
      isPending.value = false;
    }
  };

  return { openPortal, isPending, error };
}
