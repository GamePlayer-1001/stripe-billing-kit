import type { BillingConfig, BillingHttpRequest } from '@billing-kit/core';
import { handleBillingRequest } from '@billing-kit/core';

export interface NextAdapterOptions {
  /** 从请求解析当前登录用户,未登录返回 null。产品側自己实现(session/JWT 均可) */
  resolveUser: (req: Request) => Promise<string | null> | string | null;
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

    const isWebhook = subPath === 'webhook';

    const billingReq: BillingHttpRequest = {
      method: req.method,
      path: subPath,
      headers: {
        'stripe-signature': req.headers.get('stripe-signature') ?? undefined,
      },
      // webhook 必须 raw text 验签;其余端点解析 JSON(GET/空 body 容错)
      rawBody: isWebhook ? await req.text() : undefined,
      jsonBody: !isWebhook && req.method === 'POST' ? await req.json().catch(() => ({})) : undefined,
      userId: isWebhook ? null : await options.resolveUser(req),
    };

    const res = await handleBillingRequest(config, billingReq);
    return Response.json(res.body, { status: res.status });
  }

  return { GET: handle, POST: handle };
}
