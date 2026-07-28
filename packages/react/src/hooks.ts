'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { billingFetch, useBillingBasePath, useBillingConfig } from './client.js';
import type {
  BillingStatus,
  Catalog,
  CatalogPlan,
  ReferralClientEvent,
  ReferralCommission,
  ReferralInvite,
  ReferralStats,
} from './types.js';

export interface UsePlansResult {
  plans: CatalogPlan[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
}

/** 定价页数据源:GET /catalog(价格全部来自 Stripe,前端零硬编码) */
export function usePlans(): UsePlansResult {
  const { basePath, refetchInterval } = useBillingConfig();
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

  // 轮询机制：根据 refetchInterval 自动刷新价格
  useEffect(() => {
    if (!refetchInterval || refetchInterval <= 0) return;
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, refetchInterval);
    return () => clearInterval(timer);
  }, [refetchInterval]);

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

export interface UseReferralsResult {
  /** 邀请统计面板(null = 加载中/未登录) */
  stats: ReferralStats | null;
  /** 佣金明细(createdAt 倒序,首页 20 条) */
  commissions: ReferralCommission[];
  /** 待审核佣金(commissions 中 status=PENDING 的子集) */
  pendingCommissions: ReferralCommission[];
  /** 我的邀请码(generateInviteLink 成功后填充) */
  invite: ReferralInvite | null;
  /** 生成/获取我的邀请码与链接 */
  generateInviteLink: () => Promise<ReferralInvite>;
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
}

/** 邀请返利面板数据源(规范 6.2):GET stats + commissions,POST generate */
export function useReferrals(userId: string): UseReferralsResult {
  const basePath = useBillingBasePath();
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [commissions, setCommissions] = useState<ReferralCommission[]>([]);
  const [invite, setInvite] = useState<ReferralInvite | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setIsLoading(true);
    const uid = encodeURIComponent(userId);
    Promise.all([
      billingFetch<ReferralStats>(basePath, `referrals/${uid}/stats`),
      billingFetch<{ items: ReferralCommission[] }>(basePath, `referrals/${uid}/commissions`),
    ])
      .then(([s, c]) => {
        if (cancelled) return;
        setStats(s);
        setCommissions(c.items);
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
  }, [basePath, userId, tick]);

  const generateInviteLink = useCallback(async () => {
    const result = await billingFetch<ReferralInvite>(basePath, 'referrals/generate', {
      method: 'POST',
      body: '{}',
    });
    setInvite(result);
    return result;
  }, [basePath]);

  const pendingCommissions = useMemo(
    () => commissions.filter((c) => c.status === 'PENDING'),
    [commissions],
  );

  return {
    stats,
    commissions,
    pendingCommissions,
    invite,
    generateInviteLink,
    isLoading,
    error,
    refresh: useCallback(() => setTick((t) => t + 1), []),
  };
}

export type ReferralEventsMode = 'connecting' | 'sse' | 'polling';

export interface UseReferralEventsOptions {
  /** 事件到达回调(SSE 真实事件或轮询合成的 stats.refreshed) */
  onEvent?: (event: ReferralClientEvent) => void;
  /** 降级轮询间隔(毫秒),默认 30000(规范 6.3.4) */
  pollingIntervalMs?: number;
}

const REFERRAL_SSE_EVENT_TYPES = [
  'commission.created',
  'commission.approved',
  'commission.paid',
  'referral.registered',
] as const;

/**
 * 实时到账推送(规范 6.3):SSE 优先,连接失败 3 次自动降级 30 秒轮询 stats,
 * 轮询期间持续尝试重建 SSE,恢复后切回。Serverless 部署(无 SSE 端点)天然走轮询。
 */
export function useReferralEvents(userId: string, options?: UseReferralEventsOptions): { mode: ReferralEventsMode } {
  const basePath = useBillingBasePath();
  const [mode, setMode] = useState<ReferralEventsMode>('connecting');
  const pollingIntervalMs = options?.pollingIntervalMs ?? 30_000;
  // onEvent 走 ref:回调变化不触发重连
  const onEventRef = useRef(options?.onEvent);
  onEventRef.current = options?.onEvent;

  useEffect(() => {
    if (!userId || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let failures = 0;
    let disposed = false;

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const startSse = () => {
      es = new EventSource(`${basePath}/referrals/stream`);
      for (const type of REFERRAL_SSE_EVENT_TYPES) {
        es.addEventListener(type, (e) => {
          const data = JSON.parse((e as MessageEvent).data as string) as never;
          onEventRef.current?.({ type, data } as ReferralClientEvent);
        });
      }
      es.onopen = () => {
        if (disposed) return;
        failures = 0;
        stopPolling();
        setMode('sse');
      };
      es.onerror = () => {
        if (disposed) return;
        failures += 1;
        // 失败 3 次降级轮询(6.3.4);未满 3 次由 EventSource 自动重连
        if (failures >= 3 && !pollTimer) {
          es?.close();
          es = null;
          startPolling();
        }
      };
    };

    const startPolling = () => {
      if (pollTimer) return;
      setMode('polling');
      pollTimer = setInterval(async () => {
        try {
          const stats = await billingFetch<ReferralStats>(basePath, `referrals/${encodeURIComponent(userId)}/stats`);
          if (!disposed) onEventRef.current?.({ type: 'stats.refreshed', data: stats });
        } catch {
          // 下个周期重试
        }
        // 尝试恢复 SSE:再失败一次(failures=3)即刻放弃,轮询不中断
        if (!disposed && !es) {
          failures = 2;
          startSse();
        }
      }, pollingIntervalMs);
    };

    startSse();

    return () => {
      disposed = true;
      es?.close();
      stopPolling();
    };
  }, [basePath, userId, pollingIntervalMs]);

  return { mode };
}
