# CHECKLIST · Stripe 信息采集与配置总清单

> **本文档是接入前信息采集的唯一事实源**:接入一个新产品,需要从 Stripe 网站获取的**每一项信息**、需要在后台完成的**每一项配置**,全部列在这里。
> 交接卡(STRIPE-SETUP.md 第 4 节)按本清单生成;产品开发 AI 在 INTEGRATION.md 第 0 节按本清单验收输入。
> 分级:**P0 = 缺了必然失败;P1 = 缺了功能降级或体验差;P2 = 可选增强**。

---

## 第一部分 · 需要「获取」的信息(有具体的值,要复制出来交接)

### A. 密钥类(P0,三把钥匙)

| # | 信息 | 形如 | 在 Stripe 哪里拿 | 用在哪 | 缺了会怎样 |
|---|---|---|---|---|---|
| A1 | Secret Key | `sk_test_…`(沙箱)/ `sk_live_…`(正式) | **Developers → API keys → Secret key → Reveal** | 后端环境变量 `STRIPE_SECRET_KEY` | 后端所有 Stripe 调用失败 |
| A2 | Publishable Key | `pk_test_…` / `pk_live_…` | 同上页面 → Publishable key | 前端环境变量(可公开) | v1 托管 Checkout 模式下前端暂不直接用,但按契约必须交接,后续嵌入式支付/Elements 必需 |
| A3 | Webhook Signing Secret | `whsec_…` | **Developers → Webhooks → 选中 endpoint → Signing secret**(线上);本地开发用 `stripe listen` 启动时打印的临时值 | 后端环境变量 `STRIPE_WEBHOOK_SECRET` | webhook 全部验签失败(400),支付后权益不开通 |

> ⚠️ **沙箱和正式环境是两套完全独立的密钥**。A1~A3 三个值必须来自**同一个** account 的**同一个**环境,混用是最常见的排障黑洞。
> ⚠️ 每个 sandbox 有自己独立的 API keys,不要拿 account 正式 key 当沙箱 key 用。

### B. 商品与价格类(P0,每个套餐一行)

| # | 信息 | 形如 | 在 Stripe 哪里拿 | 用在哪 | 缺了会怎样 |
|---|---|---|---|---|---|
| B1 | lookup_key(推荐)| `pro_monthly` | **Product catalog → 选中商品 → 价格区块 → 该 Price 详情**(创建时在 Advanced → Lookup key 设置) | `billing.config.ts` 的 `ref.lookupKey` | 无 lookup_key 则退回用 B2,失去「改价零沟通」能力 |
| B2 | Price ID(备选)| `price_1Nxxxx…` | 同上,Price 行右侧「…」→ Copy price ID | `billing.config.ts` 的 `ref.priceId` | B1/B2 至少要有一个,否则该套餐无法接入 |
| B3 | 价格类型 | `subscription` / `one_time` | 建 Price 时的 Recurring / One-off 选择 | `billing.config.ts` 的 `type` | 类型填错 → checkout mode 错误,支付直接失败 |
| B4 | 金额与货币 | `$19.00 USD` | Price 详情 | **只用于交接时人工核对**,代码里绝不硬编码(前端价格来自 catalog 接口) | 无法核对 catalog 返回是否正确 |
| B5 | 计费周期 | `month` / `year` | Price 详情(Billing period) | 同 B4,人工核对用 | 同上 |
| B6 | 试用期天数 | `7`(无则不填) | Price 详情(Free trial) | 同 B4;catalog 接口会自动返回 | 前端不知道要展示试用标签 |
| B7 | planKey 与 features 映射 | `pro_monthly → [pro]` | **不在 Stripe 上**,由所有者定义(产品内部标识 + 该套餐解锁哪些能力) | `billing.config.ts` 的 `key` 与 `features` | AI 无法生成权益判断逻辑 |

> 按上表整理成**套餐信息表**(交接卡内嵌),一行一个套餐,这是交接卡的主体。

### C. 环境与账号标识类(P0 确认 + P1 记录)

| # | 信息 | 形如 | 在 Stripe 哪里拿 | 优先级 | 用途 |
|---|---|---|---|:---:|---|
| C1 | 环境声明 | `sandbox` / `live` | 左上角账户切换器当前所处位置 | **P0** | 交接卡必须显式写明,防止 AI 把沙箱配置部署上线 |
| C2 | Account ID | `acct_1Nxxxx` | **Settings → Business → Account details**(或 API keys 页顶部) | P1 | 排障、区分多产品账号、Stripe 支持工单必填 |
| C3 | 默认结算货币 | `USD` | Settings → Business → Bank accounts and currencies | P1 | 多币种定价时核对;单币种产品可省 |

### D. 产品侧信息(P0,不在 Stripe 上,但交接卡必须一起给)

| # | 信息 | 示例 | 由谁定 | 用途 |
|---|---|---|---|---|
| D1 | 应用对外地址 APP_URL | `https://app.example.com` | 所有者/产品 | 拼 checkout 成功/取消回跳、portal 返回地址 |
| D2 | 用户标识体系说明 | 「用 Supabase auth 的 user.id(uuid)」 | 产品 | `resolveUser` 实现依据;**checkout 与权益查询必须用同一套稳定 userId** |
| D3 | 数据库类型 | Postgres 直连 / Prisma | 产品 | 决定 storage adapter 选型 |
| D4 | 前端框架 | Next.js / Vue / … | 产品 | 决定用 React 包还是裸 HTTP 契约 |

---

## 第二部分 · 需要在 Stripe 后台「完成的配置」(不产生交接值,但缺了会出错)

### E. 必须配置(P0)

| # | 配置项 | 在哪配 | 缺了会怎样 | 如何验证已完成 |
|---|---|---|---|---|
| E1 | **Webhook endpoint + 9 个事件**(线上环境) | Developers → Webhooks → Add endpoint,URL 填 `https://<域名>/api/billing/webhook`,勾选:`checkout.session.completed`、`customer.subscription.created/updated/deleted`、`invoice.paid`、`invoice.payment_failed`、`price.created/updated`、`product.updated` | 支付成功但权益永远不开通;改价前端不刷新 | endpoint 详情页 Events 列表 = 9 个;发起测试支付后投递记录出现且 200 |
| E2 | **Customer Portal 默认配置保存** | **Settings → Billing → Customer portal** → 检查各开关 → **Save**(沙箱和正式要各保存一次!) | 调 portal 接口直接报错:`You can't create a portal session … until you save your customer portal settings` | 后台该页面显示已保存;产品内点「管理订阅」能打开 Portal |
| E3 | **Portal 产品目录**(仅当允许用户自助升降级) | 同 E2 页面 → Subscriptions → Customers can switch plans → 添加允许切换的 Product/Price | 用户进 Portal 只能取消,不能升降级 | Portal 内可见「切换套餐」选项 |
| E4 | 商品与价格创建(含 lookup_key) | 见 STRIPE-SETUP.md 第 2 节 | catalog 返回空,定价页无内容 | `GET /api/billing/catalog` 返回全部套餐 |

### F. 强烈建议(P1)

| # | 配置项 | 在哪配 | 影响 |
|---|---|---|---|
| F1 | 公共业务信息(Business name 等) | **Settings → Business → Public details** | Checkout / Portal / 账单邮件上显示的名字;Portal 要求 Business name 必填,占位名会显得像钓鱼页 |
| F2 | 品牌设置(logo / 主色) | **Settings → Branding** | Checkout 与 Portal 页面观感;不配则是 Stripe 默认灰白 |
| F3 | 客户邮件开关 | Settings → Emails(勾选 successful payments / refunds 等) | 不开则用户收不到 Stripe 的收据邮件,客服压力转到产品侧 |
| F4 | 支付方式开关 | Settings → Payment methods | 默认只有卡;面向中国用户可开 Alipay/WeChat Pay,面向欧洲可开 SEPA 等(Checkout 自动按开关展示) |
| F5 | 税务(Stripe Tax) | Settings → Tax(开关 + 注册地) | 有合规需求才开;开了之后 Checkout 自动算税,代码零改动 |

### G. 可选增强(P2)

| # | 配置项 | 说明 |
|---|---|---|
| G1 | 优惠券 / Promotion codes | Product catalog → Coupons 创建;套件 checkout 已支持 `allow_promotion_codes`,建好即可在 Checkout 输入 |
| G2 | Checkout / Portal 自定义域名 | Settings → Custom domains(付费功能,提升品牌信任) |
| G3 | 团队成员权限 | Settings → Team,给协作者最小权限角色,避免共享主账号 |
| G4 | 账单收据编号规则 | Settings → Invoice template,B2B 产品建议配 |

---

## 第三部分 · 完整交接卡模板(v2,直接复制使用)

> 所有者填完下表发给产品开发 AI。**「必填」列为空 = 交接不合格**,AI 应停下索要而不是猜。

```markdown
【Stripe 接入交接卡 v2】

■ 环境与账号(C 组)
产品名:__________
环境:sandbox / live(二选一,必填)
Account ID(acct_,建议):__________
结算货币(建议):USD

■ 三把钥匙(A 组,必填)
STRIPE_SECRET_KEY=sk_____________
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_____________
STRIPE_WEBHOOK_SECRET=whsec_______(本地开发阶段可写「AI 用 stripe listen 自取」)

■ 套餐信息表(B 组,必填,一行一个套餐)
| planKey | 类型(subscription/one_time) | lookup_key | price_id(无 lookup_key 时必填) | 金额/货币/周期(核对用) | 试用期 | 解锁 features |
|---------|------|------------|----------|----------------|------|----------|
| pro_monthly | subscription | pro_monthly | price_xxx | $19 USD /月 | 无 | pro |

■ 后台配置确认(E 组,必须逐项勾选)
- [ ] E1 Webhook endpoint 已建,9 个事件已全部勾选(线上环境;本地开发可暂缺)
- [ ] E2 Customer Portal 设置已在【当前环境】保存
- [ ] E3 Portal 产品目录已配置(不允许自助升降级则写「不适用」)
- [ ] E4 全部商品/价格已创建,lookup_key 已按规范设置

■ 产品側信息(D 组,必填)
APP_URL=__________
用户标识体系:__________(例:Supabase auth user.id)
数据库:Postgres 直连 / Prisma
前端框架:__________

■ 套件文档:<stripe-billing-kit 仓库>/docs/INTEGRATION.md
```

---

## 第四部分 · AI 收卡验收规则(写给产品开发 AI)

收到交接卡后,按以下规则校验,**任何一条不过就停下向所有者索要,禁止编造占位值继续**:

1. 三把钥匙前缀合法:`sk_` / `pk_` / `whsec_`(webhook secret 允许标注「stripe listen 自取」)。
2. **环境一致性**:`sk_test_` 必须配 `pk_test_`,`sk_live_` 必须配 `pk_live_`;交接卡「环境」栏与 key 前缀一致。
3. 套餐信息表每行:`planKey` 非空且产品内唯一;`lookup_key` 与 `price_id` 至少一项;`类型` ∈ {subscription, one_time};`features` 非空。
4. E 组四个勾选框全部勾选(或标明「不适用」的合理理由;本地开发阶段 E1 可豁免)。
5. D 组四项齐全。
6. 接入完成后,把 INTEGRATION.md 第 6 节验收清单的执行结果回报给所有者。
