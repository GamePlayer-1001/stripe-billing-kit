'use client';

import { useCallback, useEffect, useState } from 'react';
import { billingFetch, useBillingBasePath } from './client.js';
import type { BillingStatus, Catalog, CatalogPlan } from './types.js';

export interface UsePlansResult {
  plans: CatalogPlan[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
}

/** 定价页数据源:GET /catalog(价格全部来自 Stripe,前端零硬编码) */
export function usePlans(): UsePlansResult {
  const basePath = useBillingBasePath();
  const [plans, setPlans] = useState<CatalogPlan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    billingFetch<Catalog>(basePath, 'catalog')
      .then((catalog) => {
        if (cancelled) return;
        setPlans(catalog.plans);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [basePath, tick]);

  return { plans, isLoading, error, refresh: useCallback(() => setTick((t) => t + 1), []) };
}

export interface UseCheckoutResult {
  /** 调用后自动跳转 Stripe Checkout */
  checkout: (planKey: string, quantity?: number) => Promise<void>;
  isPending: boolean;
  error: Error | null;
}

export function useCheckout(): UseCheckoutResult {
  const basePath = useBillingBasePath();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const checkout = useCallback(
    async (planKey: string, quantity?: number) => {
      setIsPending(true);
      setError(null);
      try {
        const { url } = await billingFetch<{ url: string }>(basePath, 'checkout', {
          method: 'POST',
          body: JSON.stringify({ planKey, quantity }),
        });
        window.location.assign(url);
      } catch (err) {
        setError(err as Error);
        setIsPending(false);
        throw err;
      }
    },
    [basePath],
  );

  return { checkout, isPending, error };
}

export interface UseBillingStatusResult {
  status: BillingStatus | null;
  hasAccess: (feature: string) => boolean;
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
}

/** 当前用户权益:GET /me(未登录时 error 为 401,status 保持 null) */
export function useBillingStatus(): UseBillingStatusResult {
  const basePath = useBillingBasePath();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    billingFetch<BillingStatus>(basePath, 'me')
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [basePath, tick]);

  const hasAccess = useCallback((feature: string) => status?.hasAccess[feature] === true, [status]);

  return { status, hasAccess, isLoading, error, refresh: useCallback(() => setTick((t) => t + 1), []) };
}

export interface UsePortalResult {
  openPortal: () => Promise<void>;
  isPending: boolean;
  error: Error | null;
}

export function usePortal(): UsePortalResult {
  const basePath = useBillingBasePath();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const openPortal = useCallback(async () => {
    setIsPending(true);
    setError(null);
    try {
      const { url } = await billingFetch<{ url: string }>(basePath, 'portal', { method: 'POST', body: '{}' });
      window.location.assign(url);
    } catch (err) {
      setError(err as Error);
      setIsPending(false);
      throw err;
    }
  }, [basePath]);

  return { openPortal, isPending, error };
}
