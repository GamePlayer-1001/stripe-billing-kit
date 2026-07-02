import { Router, raw, json, type Request, type Response } from 'express';
import type { BillingConfig, BillingHttpRequest } from '@billing-kit/core';
import { handleBillingRequest } from '@billing-kit/core';

export interface ExpressAdapterOptions {
  /** 从请求解析当前登录用户,未登录返回 null。产品側自己实现 */
  resolveUser: (req: Request) => Promise<string | null> | string | null;
}

/**
 * Express 适配器。产品側用法:
 *
 *   app.use('/api/billing', createExpressBillingRouter(billingConfig, { resolveUser }));
 *
 * webhook 的 raw body 中间件已在 router 内部按路径挂好;
 * 若产品已全局 app.use(express.json()),必须把本 router 挂在其之前,否则验签必失败。
 */
export function createExpressBillingRouter(config: BillingConfig, options: ExpressAdapterOptions): Router {
  const router = Router();

  // webhook:raw body(验签必需),不走 json 解析
  router.post('/webhook', raw({ type: 'application/json' }), async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'];
    const billingReq: BillingHttpRequest = {
      method: 'POST',
      path: 'webhook',
      headers: { 'stripe-signature': Array.isArray(sig) ? sig[0] : sig },
      rawBody: req.body as Buffer,
      userId: null,
    };
    const result = await handleBillingRequest(config, billingReq);
    res.status(result.status).json(result.body);
  });

  // 其余端点:正常 JSON
  router.use(json());
  router.all('/:action', async (req: Request, res: Response) => {
    const action = req.params['action'];
    const billingReq: BillingHttpRequest = {
      method: req.method,
      path: typeof action === 'string' ? action : (action?.[0] ?? ''),
      headers: {},
      jsonBody: req.body,
      userId: await options.resolveUser(req),
    };
    const result = await handleBillingRequest(config, billingReq);
    res.status(result.status).json(result.body);
  });

  return router;
}
