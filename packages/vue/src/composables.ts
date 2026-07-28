import { ref, computed, onMounted, onUnmounted, type Ref, type ComputedRef } from 'vue';
import { useBillingConfig } from './client.js';
import type {
  Catalog,
  BillingStatus,
  ReferralClientEvent,
  ReferralCommission,
  ReferralInvite,
  ReferralStats,
} from './types.js';

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

export interface UseReferralsResult {
  /** 邀请统计面板（null = 加载中/未登录） */
  stats: Ref<ReferralStats | null>;
  /** 佣金明细（createdAt 倒序，首页 20 条） */
  commissions: Ref<ReferralCommission[]>;
  /** 待审核佣金（commissions 中 status=PENDING 的子集） */
  pendingCommissions: ComputedRef<ReferralCommission[]>;
  /** 我的邀请码（generateInviteLink 成功后填充） */
  invite: Ref<ReferralInvite | null>;
  /** 生成/获取我的邀请码与链接 */
  generateInviteLink: () => Promise<ReferralInvite>;
  isLoading: Ref<boolean>;
  error: Ref<Error | null>;
  refetch: () => Promise<void>;
}

/** 邀请返利面板数据源（规范 6.2）：GET stats + commissions，POST generate */
export function useReferrals(userId: string): UseReferralsResult {
  const config = useBillingConfig();
  const stats = ref<ReferralStats | null>(null);
  const commissions = ref<ReferralCommission[]>([]);
  const invite = ref<ReferralInvite | null>(null);
  const isLoading = ref(true);
  const error = ref<Error | null>(null);

  const refetch = async () => {
    if (!userId) return;
    try {
      isLoading.value = true;
      error.value = null;
      const uid = encodeURIComponent(userId);
      const [statsRes, commissionsRes] = await Promise.all([
        fetch(`${config.basePath}/referrals/${uid}/stats`),
        fetch(`${config.basePath}/referrals/${uid}/commissions`),
      ]);
      if (!statsRes.ok) throw new Error(`获取邀请统计失败: ${statsRes.status}`);
      if (!commissionsRes.ok) throw new Error(`获取佣金明细失败: ${commissionsRes.status}`);
      stats.value = (await statsRes.json()) as ReferralStats;
      commissions.value = ((await commissionsRes.json()) as { items: ReferralCommission[] }).items;
    } catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e));
    } finally {
      isLoading.value = false;
    }
  };

  const generateInviteLink = async (): Promise<ReferralInvite> => {
    const res = await fetch(`${config.basePath}/referrals/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) throw new Error(`生成邀请码失败: ${res.status}`);
    const data = (await res.json()) as ReferralInvite;
    invite.value = data;
    return data;
  };

  const pendingCommissions = computed(() => commissions.value.filter((c) => c.status === 'PENDING'));

  onMounted(refetch);

  return { stats, commissions, pendingCommissions, invite, generateInviteLink, isLoading, error, refetch };
}

export type ReferralEventsMode = 'connecting' | 'sse' | 'polling';

export interface UseReferralEventsOptions {
  /** 事件到达回调（SSE 真实事件或轮询合成的 stats.refreshed） */
  onEvent?: (event: ReferralClientEvent) => void;
  /** 降级轮询间隔（毫秒），默认 30000（规范 6.3.4） */
  pollingIntervalMs?: number;
}

const REFERRAL_SSE_EVENT_TYPES = [
  'commission.created',
  'commission.approved',
  'commission.paid',
  'referral.registered',
] as const;

/**
 * 实时到账推送（规范 6.3）：SSE 优先，连接失败 3 次自动降级 30 秒轮询 stats，
 * 轮询期间持续尝试重建 SSE，恢复后切回。Serverless 部署（无 SSE 端点）天然走轮询。
 */
export function useReferralEvents(userId: string, options?: UseReferralEventsOptions): { mode: Ref<ReferralEventsMode> } {
  const config = useBillingConfig();
  const mode = ref<ReferralEventsMode>('connecting');
  const pollingIntervalMs = options?.pollingIntervalMs ?? 30_000;

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
    es = new EventSource(`${config.basePath}/referrals/stream`);
    for (const type of REFERRAL_SSE_EVENT_TYPES) {
      es.addEventListener(type, (e) => {
        const data = JSON.parse((e as MessageEvent).data as string) as never;
        options?.onEvent?.({ type, data } as ReferralClientEvent);
      });
    }
    es.onopen = () => {
      if (disposed) return;
      failures = 0;
      stopPolling();
      mode.value = 'sse';
    };
    es.onerror = () => {
      if (disposed) return;
      failures += 1;
      // 失败 3 次降级轮询（6.3.4）；未满 3 次由 EventSource 自动重连
      if (failures >= 3 && !pollTimer) {
        es?.close();
        es = null;
        startPolling();
      }
    };
  };

  const startPolling = () => {
    if (pollTimer) return;
    mode.value = 'polling';
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${config.basePath}/referrals/${encodeURIComponent(userId)}/stats`);
        if (res.ok && !disposed) {
          options?.onEvent?.({ type: 'stats.refreshed', data: (await res.json()) as ReferralStats });
        }
      } catch {
        // 下个周期重试
      }
      // 尝试恢复 SSE：再失败一次（failures=3）即刻放弃，轮询不中断
      if (!disposed && !es) {
        failures = 2;
        startSse();
      }
    }, pollingIntervalMs);
  };

  onMounted(() => {
    if (!userId || typeof EventSource === 'undefined') return;
    startSse();
  });

  onUnmounted(() => {
    disposed = true;
    es?.close();
    stopPolling();
  });

  return { mode };
}
