import { inject, provide, type InjectionKey } from 'vue';

export interface BillingClientConfig {
  /** API 基础路径，默认 /api/billing */
  basePath?: string;
  /** 价格刷新间隔（毫秒），默认 300000（5分钟），设为 0 禁用轮询 */
  refetchInterval?: number;
}

export const BillingConfigKey: InjectionKey<Required<BillingClientConfig>> = Symbol('billing-config');

export function provideBillingConfig(config: BillingClientConfig = {}) {
  const resolved: Required<BillingClientConfig> = {
    basePath: config.basePath ?? '/api/billing',
    refetchInterval: config.refetchInterval ?? 300000,
  };
  provide(BillingConfigKey, resolved);
  return resolved;
}

export function useBillingConfig(): Required<BillingClientConfig> {
  const config = inject(BillingConfigKey);
  if (!config) {
    throw new Error('useBillingConfig 必须在 provideBillingConfig 内部调用');
  }
  return config;
}
