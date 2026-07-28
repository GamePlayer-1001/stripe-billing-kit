import type { BillingConfig, BillingHttpRequest } from '@billing-kit/core';
import { handleBillingRequest } from '@billing-kit/core';

export interface NextAdapterOptions {
  /** 从请求解析当前登录用户,未登录返回 null。产品側自己实现(session/JWT 均可) */
  resolveUser: (req: Request) => Promise<string | null> | string | null;
  /** 是否管理员(佣金审核等 /admin/* 端点用),缺省一律视为 false */
  resolveAdmin?: (req: Request) => Promise<boolean> | boolean;
  /** 路由挂载前缀,默认 /api/billing(用于从 URL 提取子路径) */
  basePath?: string;
}

/**
 * Next.js App Router 适配器。产品側用法(catch-all 路由):
 *
 *   // app/api/billing/[...billing]/route.ts
 *   const handler = createNextBillingHandler(billingConfig, { resolveUser });
 *   export const { GET, POST } = handler;
 */
export function createNextBillingHandler(
  config: BillingConfig,
  options: NextAdapterOptions,
): { GET: (req: Request) => Promise<Response>; POST: (req: Request) => Promise<Response> } {
  const basePath = (options.basePath ?? '/api/billing').replace(/\/+$/, '');

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const subPath = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length).replace(/^\/+/, '')
      : url.pathname.replace(/^\/+/, '');

    // SSE 实时推送(佣金到账/审核通过/打款完成,见规范 6.3):流式 Response,不进 core JSON 管线。
    // 需在 CommissionConfig.events 配置事件总线(如 InMemoryReferralEventBus),否则 404。
    if (req.method === 'GET' && subPath === 'referrals/stream') {
      const events = config.commission?.engine.events;
      if (!events) {
        return Response.json({ error: 'not_found', message: '实时推送未启用' }, { status: 404 });
      }
      const userId = await options.resolveUser(req);
      if (!userId) {
        return Response.json({ error: 'unauthorized', message: '请先登录' }, { status: 401 });
      }

      const encoder = new TextEncoder();
      let cleanup: (() => void) | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const write = (chunk: string) => controller.enqueue(encoder.encode(chunk));
          write(': connected\n\n');
          const unsubscribe = events.subscribe(userId, (event) => {
            write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
          });
          // 心跳注释行防代理/网关空闲超时断连
          const heartbeat = setInterval(() => write(': ping\n\n'), 25_000);
          cleanup = () => {
            clearInterval(heartbeat);
            unsubscribe();
          };
          // 客户端断开(EventSource.close/页面关闭)时释放订阅
          req.signal.addEventListener('abort', () => {
            cleanup?.();
            try {
              controller.close();
            } catch {
              // 流已关闭
            }
          });
        },
        cancel() {
          cleanup?.();
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no', // 关闭 nginx 缓冲,事件即时下发
        },
      });
    }

    const isWebhook = subPath === 'webhook';

    const query: Record<string, string | undefined> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });

    const billingReq: BillingHttpRequest = {
      method: req.method,
      path: subPath,
      headers: {
        'stripe-signature': req.headers.get('stripe-signature') ?? undefined,
      },
      // webhook 必须 raw text 验签;其余端点解析 JSON(GET/空 body 容错)
      rawBody: isWebhook ? await req.text() : undefined,
      jsonBody: !isWebhook && req.method === 'POST' ? await req.json().catch(() => ({})) : undefined,
      query,
      userId: isWebhook ? null : await options.resolveUser(req),
      isAdmin: isWebhook ? false : (await options.resolveAdmin?.(req)) ?? false,
    };

    const res = await handleBillingRequest(config, billingReq);
    return Response.json(res.body, { status: res.status });
  }

  return { GET: handle, POST: handle };
}
