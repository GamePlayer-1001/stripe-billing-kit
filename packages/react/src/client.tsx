'use client';

import { createContext, useContext, type ReactNode } from 'react';

export interface BillingClientConfig {
  /** 后端挂载前缀,默认 /api/billing */
  basePath: string;
  /** 定价轮询间隔(毫秒),默认 300000(5分钟);设为 0 禁用轮询 */
  refetchInterval?: number;
}

const BillingClientContext = createContext<BillingClientConfig>({ 
  basePath: '/api/billing',
  refetchInterval: 300000,
});

/** 可选:仅当后端挂载点不是 /api/billing 或需要自定义轮询间隔时才需要包裹 */
export function BillingProvider({ 
  basePath, 
  refetchInterval,
  children 
}: { 
  basePath?: string; 
  refetchInterval?: number;
  children: ReactNode;
}) {
  return (
    <BillingClientContext.Provider value={{ 
      basePath: basePath ?? '/api/billing',
      refetchInterval: refetchInterval ?? 300000,
    }}>
      {children}
    </BillingClientContext.Provider>
  );
}

export function useBillingBasePath(): string {
  return useContext(BillingClientContext).basePath;
}

export function useBillingConfig(): BillingClientConfig {
  return useContext(BillingClientContext);
}

export async function billingFetch<T>(basePath: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${basePath}/${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `billing 请求失败(${res.status})`);
  }
  return (await res.json()) as T;
}
