/**
 * Next 适配器 SSE 端点测试（6.3 实时推送：/referrals/stream）。
 */
import { describe, expect, it } from 'vitest';
import {
  CommissionEngine,
  InMemoryCommissionStorage,
  InMemoryReferralEventBus,
} from '@billing-kit/core';
import type { BillingConfig } from '@billing-kit/core';
import { createNextBillingHandler } from './index.js';

/** SSE 分支只读 commission.engine.events，最小化伪 config 即可（不进 JSON 管线） */
function makeConfig(events?: InMemoryReferralEventBus): BillingConfig {
  const storage = new InMemoryCommissionStorage();
  const engine = new CommissionEngine({ config: { programId: 'default', storage, events } });
  return { commission: { engine } } as unknown as BillingConfig;
}

const STREAM_URL = 'http://localhost/api/billing/referrals/stream';

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read();
  return new TextDecoder().decode(value);
}

describe('createNextBillingHandler /referrals/stream', () => {
  it('未配置事件总线 → 404；未登录 → 401', async () => {
    const noBus = createNextBillingHandler(makeConfig(), { resolveUser: () => 'alice' });
    expect((await noBus.GET(new Request(STREAM_URL))).status).toBe(404);

    const noUser = createNextBillingHandler(makeConfig(new InMemoryReferralEventBus()), {
      resolveUser: () => null,
    });
    expect((await noUser.GET(new Request(STREAM_URL))).status).toBe(401);
  });

  it('建立 SSE 长连接：下发事件帧，断开后取消订阅', async () => {
    const events = new InMemoryReferralEventBus();
    const handler = createNextBillingHandler(makeConfig(events), { resolveUser: () => 'alice' });

    const controller = new AbortController();
    const res = await handler.GET(new Request(STREAM_URL, { signal: controller.signal }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    expect(await readChunk(reader)).toContain(': connected');
    expect(events.subscriberCount('alice')).toBe(1);

    events.publish('alice', {
      type: 'commission.created',
      data: { commissionId: 'c_1', amount: 2000, currency: 'usd', tierLevel: 1 },
    });
    const frame = await readChunk(reader);
    expect(frame).toContain('event: commission.created');
    expect(frame).toContain('"amount":2000');
    // 定向分发：其他用户的事件不会串流
    events.publish('bob', { type: 'commission.approved', data: { commissionId: 'c_2', amount: 1 } });

    controller.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(events.subscriberCount('alice')).toBe(0); // 断开即释放订阅，防泄漏
  });
});
