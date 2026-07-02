# PRD · Stripe Billing Kit(可复用支付接入套件)

| 字段 | 内容 |
|---|---|
| 文档版本 | v1.0 |
| 日期 | 2026-07-02 |
| 作者 | 产品经理(KC 团队) |
| 状态 | 待评审 → 待开发 |
| 代号 | `stripe-billing-kit` |

---

## 1. 背景与问题

所有者维护多条产品线(同一 Stripe 登录邮箱下多个独立 Stripe account,每个产品一个 account,并使用 sandbox 做测试环境)。每上一个新产品,都要重新接一遍 Stripe:

- 后端:Checkout Session、Webhook 验签、幂等去重、订阅状态同步,每次从零写,反复踩同样的坑(raw body 验签失败、webhook 重复投递导致双发权益等)。
- 前端:价格、套餐文案硬编码在代码里,Stripe 后台改价后必须改代码、重新发版,商品更新被迫变成产品更新。
- 协作:产品开发由 AI 执行,但没有一份标准文档告诉 AI「该预留什么、怎么接、怎么验证」,每次都靠临场发挥,质量不稳定。

## 2. 一句话定义

> 一套**框架无关、随拿随用**的 Stripe 支付接入套件:所有者只需在 Stripe 后台完成配置并提供密钥与套餐信息,产品开发 AI 按照套件内置文档即可在**半天内**完成前后端支付接入;价格与套餐展示完全由 Stripe 数据驱动,**改价永不发版**。

## 3. 目标与非目标

### 3.1 目标(v1)

1. **接入提效**:新产品从零到支付可用 ≤ 0.5 人天(现状约 2~3 人天)。
2. **价格动态化**:前端不硬编码任何价格/套餐信息,Stripe 后台修改后前端在缓存 TTL 内自动跟随,零代码变更、零发版。
3. **双支付形态**:同时支持订阅(subscription)与一次性买断(one-time payment),业务侧用统一的权益模型消费。
4. **AI 可执行**:套件内置 `INTEGRATION.md`,任何产品开发 AI 拿到「套件 + 三把钥匙 + 套餐信息」即可独立完成接入,无需人工讲解。
5. **正确性**:webhook 验签、幂等去重、状态同步一次做对,所有产品复用同一份经过验证的实现。

### 3.2 非目标(v1 不做)

| 项 | 原因 | 归属 |
|---|---|---|
| 用量计费(Meter API) | 当前产品线无此需求 | v2 备选 |
| 自建订阅管理 UI(升降级/换卡/取消) | 直接复用 Stripe Customer Portal | 永久非目标 |
| 税务(Stripe Tax)深度集成 | 后台一键开关即可,无需代码 | 文档提示 |
| 多 Stripe 账号在同一产品内切换 | 一个产品 = 一个 account,天然隔离 | 永久非目标 |
| 自建支付表单(Elements 深度定制) | v1 用 Stripe 托管 Checkout,安全合规成本最低 | v2 备选 |

## 4. 角色与使用场景

### 4.1 角色

| 角色 | 描述 | 与套件的关系 |
|---|---|---|
| **所有者**(哥) | 持有 Stripe 账号,负责商业决策 | 在 Stripe 后台建产品/价格/webhook,提供密钥与套餐清单;按 `STRIPE-SETUP.md` 操作 |
| **产品开发 AI** | 负责新产品的实际编码 | 消费套件:装包、填配置、挂路由、放组件;按 `INTEGRATION.md` 操作 |
| **终端付费用户** | 新产品的顾客 | 走 Stripe 托管 Checkout 付款,在 Customer Portal 自助管理订阅 |

### 4.2 核心场景:新产品接入(黄金路径)

```
所有者(约 20 分钟,全程 Stripe 后台 + 复制粘贴):
  1. Stripe 新建 account(或复用沙箱)
  2. 建 Product + Price,按命名规范设置 lookup_key(如 pro_monthly)
  3. 配置 Webhook endpoint,勾选套件要求的事件列表
  4. 收集三把钥匙:SECRET_KEY / PUBLISHABLE_KEY / WEBHOOK_SECRET
  5. 把「三把钥匙 + 套餐信息表」交给产品开发 AI

产品开发 AI(约 2~4 小时):
  6. 读套件 INTEGRATION.md
  7. 安装套件包 → 填 billing.config.ts → 配环境变量
  8. 挂 5 个标准路由(catalog/checkout/portal/me/webhook)
  9. 执行建表迁移(套件提供 SQL / Prisma schema)
  10. 前端放 <PricingSection/> 等组件(或按 HTTP 契约自行渲染)
  11. 跑套件验证清单(stripe CLI + 测试卡)→ 全绿 → 完成
```

### 4.3 场景:改价(体现核心价值)

```
所有者:Stripe 后台新建 Price → transfer_lookup_key 把 lookup_key 转移到新价格
套件:webhook 收到 price.* 事件 → 自动失效 catalog 缓存
前端:下一次请求 /api/billing/catalog 拿到新价格 → 页面自动展示新价
代码变更:0 行。发版:0 次。
```

## 5. 功能需求(FR)

优先级:P0 = v1 必须;P1 = v1 应有;P2 = 可延后。

| # | 需求 | 优先级 | 验收标准 |
|---|---|:---:|---|
| FR-1 | **动态商品目录**:`catalog` 模块从 Stripe 拉取 active products/prices(按 lookup_key 过滤),带 TTL 缓存(默认 10 min) | P0 | Stripe 改价后,缓存失效内前端展示新价,无代码变更 |
| FR-2 | **缓存主动失效**:webhook 收到 `price.created/updated`、`product.updated` 时立刻清 catalog 缓存 | P0 | 改价后 ≤ 5s 新请求即返回新价 |
| FR-3 | **订阅支付**:创建 `mode=subscription` 的 Checkout Session,携带 `client_reference_id=userId` 与 customer 复用逻辑 | P0 | 测试卡完成订阅,webhook 同步后 `hasAccess` 返回 true |
| FR-4 | **一次性买断**:创建 `mode=payment` 的 Checkout Session,落 `billing_purchases` | P0 | 测试卡完成买断,权益立即生效且永久有效 |
| FR-5 | **Webhook 处理**:验签(raw body)→ `event.id` 幂等(INSERT … ON CONFLICT DO NOTHING)→ 分发处理 → 快速 2xx | P0 | Stripe CLI 重放同一事件,业务只执行一次;签名错误返回 400 |
| FR-6 | **状态同步**:单一 `syncStripeToDb(customerId)` 函数,从 Stripe 拉当前订阅真相并 upsert 本地表;webhook 与成功回跳页都调它 | P0 | 升级/降级/取消/支付失败后,本地状态与 Stripe 一致 |
| FR-7 | **统一权益模型**:`hasAccess(userId, planKey|feature)`、`getEntitlements(userId)`,屏蔽订阅/买断差异 | P0 | 业务代码仅凭一个函数即可做付费墙 |
| FR-8 | **Customer Portal**:一行调用生成 portal session URL,用户自助升降级/取消/换卡 | P0 | 从产品内点击可进入 Portal 并完成操作,webhook 正确回同步 |
| FR-9 | **HTTP 标准契约**:5 个端点(见架构文档),任何前端框架可直接消费 | P0 | 契约文档化,响应结构有 TypeScript 类型 |
| FR-10 | **框架适配器**:core 零框架依赖;v1 提供 Next.js(App Router)与 Express 适配器,每个 ≤ 100 行 | P0 | 两个框架均可用 ≤ 10 行胶水代码完成挂载 |
| FR-11 | **存储适配器**:`StorageAdapter` 接口抽象持久化;v1 内置 Postgres(pg)与 Prisma 两种实现,并附建表 SQL / schema | P0 | 换数据库只换 adapter,core 不改 |
| FR-12 | **React 前端包**:`usePlans` / `useCheckout` / `useBillingStatus` hooks + headless `<PricingSection/>`(无样式,插槽自定义) | P1 | React 产品 30 分钟内完成定价页 |
| FR-13 | **AI 接入文档**:`INTEGRATION.md` 含前置输入清单、分步指令、代码模板、验证清单、常见坑 | P0 | 一个全新 AI 会话仅凭该文档 + 密钥即可完成接入 |
| FR-14 | **所有者手册**:`STRIPE-SETUP.md` 含建号/建价/lookup_key 规范/webhook 配置/改价 SOP | P0 | 所有者照单操作即可,无需理解代码 |
| FR-15 | **通知钩子**:`onPaymentFailed` / `onSubscriptionCanceled` 等回调接口,业务可挂邮件/IM 通知 | P1 | 钩子被正确触发,未配置时静默 |
| FR-16 | **结构化日志**:所有关键路径(checkout 创建、webhook 收发、sync 结果)输出结构化日志,注入式 logger 接口 | P1 | 排查问题可全链路追踪一次支付 |
| FR-17 | **对账兜底**:`reconcile()` 可被 cron 调用,全量比对 Stripe 与本地订阅状态 | P2 | 手动触发可修复漂移数据 |
| FR-18 | **CLI 脚手架**:`npx billing-kit init` 生成配置模板与路由文件 | P2 | 可选,进一步压缩接入时间 |

## 6. 非功能需求(NFR)

| 类别 | 要求 |
|---|---|
| 安全 | Secret key / webhook secret 仅存在于服务端环境变量;前端仅可见 publishable key;webhook 必须验签;checkout 仅接受配置内声明的 planKey(服务端白名单),拒绝客户端直传任意 price_id |
| 幂等 | 入站:`event.id` 唯一约束原子去重;出站:Stripe 写操作携带 `idempotencyKey` |
| 正确性 | 权益授予只信 webhook,不信浏览器回跳;成功页仅做「触发一次 sync + 展示」 |
| 兼容性 | Node.js ≥ 20;stripe-node 固定主版本 v22(API 版本 `2026-06-24.dahlia`),升级由套件统一做 |
| 类型安全 | 全 TypeScript,公开 API 100% 类型导出 |
| 可测试 | 支持 Stripe sandbox 全流程;文档含 `stripe listen` 本地转发指引与测试卡清单 |
| 性能 | catalog 接口命中缓存 P95 < 50ms;webhook 处理(不含业务钩子)P95 < 500ms |

## 7. 关键产品决策(已确认)

| 决策点 | 结论 | 理由 |
|---|---|---|
| 支付页形态 | Stripe 托管 Checkout(跳转式),不自建表单 | 安全合规成本最低,支持 40+ 支付方式,移动端体验由 Stripe 保证 |
| 价格引用方式 | 优先 `lookup_key`(命名规范见 STRIPE-SETUP.md),同时兼容直填 `price_id` | lookup_key 支持改价时原子转移,代码零改动;price_id 兼容所有者已有习惯 |
| 官方 Pricing Table 组件 | 不采用 | 上限 4 产品 × 3 价格、样式定制弱、无法融入产品设计体系 |
| 事实源 | Stripe 为唯一事实源,本地库是只读副本 | 2026 业界共识,避免状态漂移 |
| 多产品隔离 | 一个产品 = 一个 Stripe account = 一套环境变量 | Stripe 官方推荐,代码零隔离逻辑 |
| 订阅管理 UI | 全部交给 Stripe Customer Portal | 省一整个模块的开发量 |

## 8. 交付物清单

```
stripe-billing-kit/
├── docs/
│   ├── PRD.md              # 本文档
│   ├── ARCHITECTURE.md     # 架构与接口设计(给架构师/开发 AI)
│   ├── INTEGRATION.md      # 接入文档(给产品开发 AI,核心交付物)
│   ├── CHECKLIST.md        # 信息采集总清单 + 交接卡 v2(所有者与 AI 交接的唯一对表依据)
│   └── STRIPE-SETUP.md     # Stripe 后台操作手册(给所有者)
├── packages/
│   ├── core/               # @billing-kit/core     框架无关核心
│   ├── adapter-next/       # @billing-kit/next     Next.js 适配器
│   ├── adapter-express/    # @billing-kit/express  Express 适配器
│   └── react/              # @billing-kit/react    React hooks + headless 组件
└── templates/
    ├── billing.config.template.ts
    ├── env.template
    └── schema/             # SQL 与 Prisma 建表模板
```

## 9. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1(v1 核心) | core(catalog/checkout/webhook/entitlements/portal)+ Next.js 适配器 + Postgres 存储 + 五份文档 | ✅ 已完成(2026-07-02) |
| M2 | Express 适配器 + Prisma 存储 + React 包 + 通知钩子 + 结构化日志 | ✅ 已完成(2026-07-02,与 M1 同批交付) |
| M3(可选) | 对账 cron + CLI 脚手架 + 用量计费调研 | 未开始,按需 |

## 10. 成功指标

1. 新产品接入耗时 ≤ 0.5 人天(以第一个试点产品实测为准)。
2. Stripe 后台改价 → 前端生效,全程 0 行代码变更、0 次发版。
3. Webhook 重复投递 100% 被幂等拦截(sandbox 重放验证)。
4. 一个无上下文的全新 AI 会话,仅凭 `INTEGRATION.md` + 密钥完成接入(试点验证)。

## 11. 风险与对策

| 风险 | 等级 | 对策 |
|---|:---:|---|
| stripe-node 大版本升级引入破坏性变更 | 中 | 套件锁定主版本,升级只在套件层统一做,产品侧无感 |
| 产品技术栈超出已有适配器(如 Python 后端) | 中 | HTTP 契约与 webhook 逻辑文档化,按 ARCHITECTURE.md 可移植;必要时新增 adapter |
| 所有者忘记配置某个 webhook 事件 | 低 | STRIPE-SETUP.md 提供事件清单;验证清单含逐事件测试;缺事件时日志告警 |
| 本地库与 Stripe 状态漂移 | 低 | 单一 sync 函数 + 成功页兜底 sync + M3 对账 cron |
