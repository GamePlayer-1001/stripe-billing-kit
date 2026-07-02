import type { BillingConfig } from './config.js';
import { createBillingContext } from './config.js';
import { getCatalog } from './catalog.js';
import { createCheckoutSession } from './checkout.js';
import { createPortalSession } from './portal.js';
import { getEntitlements } from './entitlements.js';
import { handleWebhookRequest } from './webhook.js';
import { isBillingError } from './errors.js';

/**
 * 框架无关的 HTTP 抽象:适配器把各自框架的 request 翻译成 BillingHttpRequest,
 * 把 BillingHttpResponse 翻译回各自框架的 response。5 个端点的路由与逻辑全部在这里。
 */
export interface BillingHttpRequest {
  method: string;
  /** 挂载点之后的相对路径,如 "catalog" / "webhook"(不带前导斜杠) */
  path: string;
  headers: Record<string, string | undefined>;
  /** webhook 需要 raw body;其余端点为已解析 JSON 或 undefined */
  rawBody?: string | Buffer;
  jsonBody?: unknown;
  /** 由适配器注入的当前登录用户;未登录为 null */
  userId: string | null;
}

export interface BillingHttpResponse {
  status: number;
  body: unknown;
}

const json = (status: number, body: unknown): BillingHttpResponse => ({ status, body });

/** 5 个标准端点(HTTP 契约见 ARCHITECTURE.md 第 4 节) */
export async function handleBillingRequest(
  config: BillingConfig,
  req: BillingHttpRequest,
): Promise<BillingHttpResponse> {
  const ctx = createBillingContext(config);
  const route = `${req.method.toUpperCase()} ${req.path.replace(/^\/+|\/+$/g, '')}`;

  try {
    switch (route) {
      case 'GET catalog': {
        return json(200, await getCatalog(ctx));
      }

      case 'POST checkout': {
        if (!req.userId) return json(401, { error: 'unauthorized', message: '请先登录' });
        const body = (req.jsonBody ?? {}) as { planKey?: unknown; quantity?: unknown };
        if (typeof body.planKey !== 'string' || !body.planKey) {
          return json(400, { error: 'invalid_plan', message: 'planKey 必填' });
        }
        const quantity =
          typeof body.quantity === 'number' && Number.isInteger(body.quantity) && body.quantity >= 1
            ? body.quantity
            : 1;
        const result = await createCheckoutSession(ctx, { userId: req.userId, planKey: body.planKey, quantity });
        return json(200, { url: result.url });
      }

      case 'POST portal': {
        if (!req.userId) return json(401, { error: 'unauthorized', message: '请先登录' });
        return json(200, await createPortalSession(ctx, req.userId));
      }

      case 'GET me': {
        if (!req.userId) return json(401, { error: 'unauthorized', message: '请先登录' });
        return json(200, await getEntitlements(ctx, req.userId));
      }

      case 'POST webhook': {
        if (req.rawBody == null) {
          return json(500, { error: 'config', message: '适配器未传入 raw body,webhook 无法验签' });
        }
        const result = await handleWebhookRequest(ctx, req.rawBody, req.headers['stripe-signature'] ?? null);
        return json(200, result);
      }

      default:
        return json(404, { error: 'not_found', message: `未知端点:${route}` });
    }
  } catch (err) {
    if (isBillingError(err)) {
      ctx.logger.warn('billing.http.error', { route, code: err.code, message: err.message });
      return json(err.status, { error: err.code, message: err.message });
    }
    ctx.logger.error('billing.http.unhandled', { route, err: String(err) });
    return json(500, { error: 'internal', message: '服务器内部错误' });
  }
}
