'use client';

import type { ReactNode } from 'react';
import { useBillingStatus, useCheckout, usePlans, usePortal } from './hooks.js';
import type { CatalogPlan } from './types.js';

export interface PricingSectionRenderProps {
  checkout: (planKey: string, quantity?: number) => Promise<void>;
  isPending: boolean;
}

export interface PricingSectionProps {
  /** headless:每个套餐怎么画完全交给产品 */
  renderPlan: (plan: CatalogPlan, actions: PricingSectionRenderProps) => ReactNode;
  renderLoading?: () => ReactNode;
  renderError?: (error: Error) => ReactNode;
  /** 容器元素,默认 div */
  as?: keyof HTMLElementTagNameMap;
  className?: string;
}

/** 无样式定价区块:数据来自 GET /catalog,交互走 useCheckout */
export function PricingSection({ renderPlan, renderLoading, renderError, as, className }: PricingSectionProps) {
  const { plans, isLoading, error } = usePlans();
  const { checkout, isPending } = useCheckout();
  const Tag = (as ?? 'div') as 'div';

  if (isLoading) return <>{renderLoading?.() ?? null}</>;
  if (error) return <>{renderError?.(error) ?? null}</>;

  return <Tag className={className}>{plans.map((plan) => renderPlan(plan, { checkout, isPending }))}</Tag>;
}

export interface SubscriptionGateProps {
  /** 能力标签,如 'pro' */
  feature: string;
  children: ReactNode;
  /** 无权益时展示(付费墙/升级引导) */
  fallback?: ReactNode;
  /** 权益加载中展示 */
  loading?: ReactNode;
}

/** 前端付费墙(仅 UX 控制;真正的安全拦截必须在服务端用 hasAccess 再做一遍) */
export function SubscriptionGate({ feature, children, fallback, loading }: SubscriptionGateProps) {
  const { hasAccess, isLoading } = useBillingStatus();
  if (isLoading) return <>{loading ?? null}</>;
  return hasAccess(feature) ? <>{children}</> : <>{fallback ?? null}</>;
}

export interface BillingPortalButtonProps {
  children?: ReactNode;
  className?: string;
  /** portal 会话创建失败时回调(如未登录/从未付费) */
  onError?: (error: Error) => void;
}

/** 「管理订阅」按钮:点击跳 Stripe Customer Portal */
export function BillingPortalButton({ children, className, onError }: BillingPortalButtonProps) {
  const { openPortal, isPending } = usePortal();
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      onClick={() => openPortal().catch((err: Error) => onError?.(err))}
    >
      {children ?? '管理订阅'}
    </button>
  );
}
