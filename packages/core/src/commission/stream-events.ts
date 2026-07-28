/**
 * 邀请返利实时事件总线（对应 docs/COMMISSION-SYSTEM-SPEC.md 6.3 SSE 推送）
 *
 * 设计：
 * - core 只定义事件类型与总线抽象；SSE 长连接端点由适配层实现（Express 天然支持流式响应）
 * - 内存实现适用单实例部署；多实例需自行实现 ReferralEventBus 接 Redis Pub/Sub 或 PG LISTEN/NOTIFY
 * - publish 为 fire-and-forget：监听器异常不得影响计佣主流程
 */

/** 推送给推荐人的实时事件（6.3.2） */
export type ReferralStreamEvent =
  | { type: 'commission.created'; data: { commissionId: string; amount: number; currency: string; tierLevel: number } }
  | { type: 'commission.approved'; data: { commissionId: string; amount: number } }
  | { type: 'commission.paid'; data: { commissionId: string; amount: number } }
  | { type: 'referral.registered'; data: { maskedEmail: string | null } };

export type ReferralEventListener = (event: ReferralStreamEvent) => void;

/**
 * 事件总线抽象：按推荐人 userId 定向分发（一个用户可有多个活跃订阅 = 多标签页）。
 */
export interface ReferralEventBus {
  publish(referrerUserId: string, event: ReferralStreamEvent): void;
  /** @returns 取消订阅函数（SSE 连接关闭时必须调用，防泄漏） */
  subscribe(referrerUserId: string, listener: ReferralEventListener): () => void;
}

/** 单实例内存总线（多实例部署请自行实现跨实例分发） */
export class InMemoryReferralEventBus implements ReferralEventBus {
  private listeners = new Map<string, Set<ReferralEventListener>>();

  publish(referrerUserId: string, event: ReferralStreamEvent): void {
    const set = this.listeners.get(referrerUserId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // 监听器异常不影响其他订阅者，也不影响计佣主流程
      }
    }
  }

  subscribe(referrerUserId: string, listener: ReferralEventListener): () => void {
    let set = this.listeners.get(referrerUserId);
    if (!set) {
      set = new Set();
      this.listeners.set(referrerUserId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(referrerUserId);
    };
  }

  /** 活跃订阅数（测试/监控用） */
  subscriberCount(referrerUserId: string): number {
    return this.listeners.get(referrerUserId)?.size ?? 0;
  }
}
