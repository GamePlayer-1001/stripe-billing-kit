'use client';

import { useCallback, useEffect, useState } from 'react';
import { useBillingStatus, useCheckout, usePlans, usePortal } from './hooks.js';
import type { CatalogPlan } from './types.js';

// ──────────────────────────────────────────────────────────────────────
// Headless core + default Tailwind styles (drop-in)
// ──────────────────────────────────────────────────────────────────────

/** Render props passed to renderPlan */
export interface PricingSectionRenderProps {
  checkout: (planKey: string, quantity?: number) => Promise<void>;
  isPending: boolean;
}

export interface PricingSectionProps {
  /**
   * headless mode: you define the markup for each plan.
   * If not provided, a nice default Tailwind-renderer will be used automatically.
   */
  renderPlan?: (plan: CatalogPlan, actions: PricingSectionRenderProps) => React.ReactNode;
  renderLoading?: () => React.ReactNode;
  renderError?: (error: Error) => React.ReactNode;
  as?: keyof HTMLElementTagNameMap;
  className?: string;

  /** Built-in style variants (overrides renderPlan). Best for quick-start. */
  variant?: 'cards' | 'list';
}

/** Default Tailwind renderer for pricing cards (no external deps) */
function DefaultPricingRenderer({ plans, onCheckout }: { plans: CatalogPlan[]; onCheckout: (planKey: string) => void }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {plans.map((plan) => (
        <div key={plan.key} className="rounded-lg border border-slate-200 p-6 shadow-sm hover:shadow-md transition-shadow bg-white">
          <h3 className="text-lg font-semibold text-slate-900">{plan.product.name}</h3>
          <p className="mt-2 text-sm text-slate-600 min-h-[40px]">{plan.product.description ?? '—'}</p>
          <div className="mt-4 flex items-baseline gap-2">
            {plan.price.unitAmount !== null && (
              <>
                <span className="text-3xl font-bold text-slate-900">
                  ${Math.round(plan.price.unitAmount / 100)}.{(plan.price.unitAmount % 100).toString().padStart(2, '0')}
                </span>
                <span className="text-sm text-slate-600">/{plan.price.interval ?? 'month'}</span>
              </>
            )}
          </div>
          <ul className="mt-4 space-y-2 text-sm text-slate-700">
            <li>✓ {plan.key}</li>
            {plan.features.slice(0, 5).map((f, i) => (
              <li key={i}>✓ {f}</li>
            ))}
          </ul>
          <button
            onClick={() => onCheckout(plan.key)}
            disabled={false}
            className="mt-6 w-full inline-flex justify-center items-center px-4 py-2.5 rounded-md bg-indigo-600 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
          >
            立即订阅
          </button>
        </div>
      ))}
    </div>
  );
}

/** Unstyled headless component */
export function PricingSection({ renderPlan, renderLoading, renderError, as, className, variant }: PricingSectionProps) {
  const { plans, isLoading, error } = usePlans();
  const { checkout, isPending } = useCheckout();
  const Tag = (as ?? 'div') as 'div';

  if (isLoading) return <>{renderLoading?.() ?? null}</>;
  if (error) return <>{renderError?.(error) ?? null}</>;

  // Use built-in default renderer unless user explicitly provides renderPlan
  if (!renderPlan) {
    return <DefaultPricingRenderer plans={plans} onCheckout={checkout} />;
  }

  // Pure headless fallback
  return <Tag className={className}>{plans.map((plan) => renderPlan(plan, { checkout, isPending }))}</Tag>;
}

// ──────────────────────────────────────────────────────────────────────
// Additional UI components
// ──────────────────────────────────────────────────────────────────────

export interface SubscriptionGateProps {
  feature: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
  loading?: React.ReactNode;
}

/** Frontend access gate (UX only; server must enforce with hasAccess too) */
export function SubscriptionGate({ feature, children, fallback, loading }: SubscriptionGateProps) {
  const { hasAccess, isLoading } = useBillingStatus();
  if (isLoading) return <>{loading ?? null}</>;
  return hasAccess(feature) ? <>{children}</> : <>{fallback ?? null}</>;
}

export interface BillingPortalButtonProps {
  children?: React.ReactNode;
  className?: string;
  onError?: (error: Error) => void;
}

/** "Manage subscription" button that opens Stripe Customer Portal */
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
