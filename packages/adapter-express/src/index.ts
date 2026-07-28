import { Router, raw, json, type Request, type Response } from 'express';
import type { BillingConfig, BillingHttpRequest } from '@billing-kit/core';
import { handleBillingRequest } from '@billing-kit/core';

export interface ExpressAdapterOptions {
  /** 从请求解析当前登录用户,未登录返回 null。产品側自己实现 */
  resolveUser: (req: Request) => Promise<string | null> | string | null;
  /** 是否管理员(佣金审核等 /admin/* 端点用),缺省一律视为 false */
  resolveAdmin?: (req: Request) => Promise<boolean> | boolean;
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

  // SSE 实时推送(佣金到账/审核通过/打款完成,见规范 6.3):长连接流式响应,不进 core JSON 管线。
  // 需在 CommissionConfig.events 配置事件总线(如 InMemoryReferralEventBus),否则 404。
  router.get('/referrals/stream', async (req: Request, res: Response) => {
    const events = config.commission?.engine.events;
    if (!events) {
      res.status(404).json({ error: 'not_found', message: '实时推送未启用' });
      return;
    }
    const userId = await options.resolveUser(req);
    if (!userId) {
      res.status(401).json({ error: 'unauthorized', message: '请先登录' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 关闭 nginx 缓冲,事件即时下发
    });
    res.write(': connected\n\n');

    const unsubscribe = events.subscribe(userId, (event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    });
    // 心跳注释行防代理/网关空闲超时断连
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  // 其余端点:正常 JSON。正则通配以支持多段路径(如 referrals/:userId/commissions)
  router.use(json());
  router.all(/.*/, async (req: Request, res: Response) => {
    const query: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string') query[k] = v;
    }
    const billingReq: BillingHttpRequest = {
      method: req.method,
      path: req.path.replace(/^\/+/, ''),
      headers: {},
      jsonBody: req.body,
      query,
      userId: await options.resolveUser(req),
      isAdmin: (await options.resolveAdmin?.(req)) ?? false,
    };
    const result = await handleBillingRequest(config, billingReq);
    res.status(result.status).json(result.body);
  });

  return router;
}
