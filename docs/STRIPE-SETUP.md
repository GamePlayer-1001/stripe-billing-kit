# STRIPE-SETUP · Stripe 后台操作手册(写给所有者)

> **你是谁**:产品所有者。每次上新产品/改价/上线,照本手册操作 Stripe 后台即可,全程不需要写代码。
> 操作完成后,把第 4 节的「交接卡」发给产品开发 AI,它会完成其余全部工作。
> **需要采集哪些信息的完整对照表(含每一项在后台的位置、缺漏后果)见 [`CHECKLIST.md`](CHECKLIST.md),本手册按操作顺序组织,两者配合使用。**

---

## 1. 新产品开号(每个新产品做一次,约 10 分钟)

1. 登录 [dashboard.stripe.com](https://dashboard.stripe.com),点**左上角账户名 → New account**,为新产品创建独立 account(命名 = 产品名)。
   - 原则:**一个产品 = 一个 account**,报表、余额、密钥天然隔离。
2. 开发阶段先用 **Sandbox**:左上角账户切换器 → Sandboxes → Create sandbox(每个 account 最多 5 个)。
   - Sandbox 有独立 API keys,数据与正式环境完全隔离,可随便折腾。
3. 拿密钥:**Developers → API keys**,记录:
   - `Publishable key`(pk_ 开头)
   - `Secret key`(sk_ 开头,点 Reveal;**只在交接时传一次,不要存聊天记录里**)

## 2. 建商品与价格(每个套餐做一次,约 5 分钟)

路径:**Product catalog → Add product**

1. 填 Name(如 `Pro`)、Description(会展示在前端与 Checkout)。
   - 建议填 **Marketing features**(产品详情里的 feature list),前端定价卡会直接展示。
2. 添加 Price:
   - 订阅:Recurring,选月/年,填金额。
   - 买断:One-off,填金额。
3. **关键步骤 —— 设置 lookup_key**:
   - 创建 Price 时展开 **Advanced → Lookup key**,按下面命名规范填写。
   - 这是「改价不改代码」的开关,**每个 Price 都必须设置**。

### 2.1 lookup_key 命名规范(全产品线统一)

```
<套餐名>_<周期>        订阅:pro_monthly / pro_yearly / team_monthly
<套餐名>              买断:lifetime / credits_100
```

- 全小写 + 下划线,不带产品名(account 已隔离产品,无需重复)。
- 同一 account 内唯一;**新产品沿用同样的命名**,AI 侧配置几乎可以直接复制。

## 3. 配置 Webhook 与 Customer Portal(每个环境做一次,约 10 分钟)

### 3.1 Webhook

> 本地开发**不需要**做这一步(AI 会用 `stripe listen`)。部署到线上前必须做。

路径:**Developers → Webhooks → Add endpoint**

1. Endpoint URL:`https://<产品域名>/api/billing/webhook`
2. 事件选择(**逐项勾选,一个都不能少**):

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
price.created
price.updated
product.updated
```

3. 创建后,点开 endpoint 页面,复制 **Signing secret**(whsec_ 开头)。

### 3.2 Customer Portal(容易漏!沙箱和正式要各做一次)

路径:**Settings → Billing → Customer portal**

1. 检查各功能开关(取消订阅、更新支付方式、发票历史等,默认即可),点 **Save**。
   - **不保存的后果**:产品里点「管理订阅」直接报错 `You can't create a portal session … until you save your customer portal settings`。
2. 若允许用户自助升降级:同页 **Subscriptions → Customers can switch plans**,把可切换的 Product/Price 加进目录。
3. 建议顺手完成(影响 Checkout/Portal 页面观感与信任感):
   - **Settings → Business → Public details**:填 Business name(Portal 必需)。
   - **Settings → Branding**:传 logo、设主色。
   - **Settings → Emails**:开启支付成功/退款收据邮件。
   - **Settings → Payment methods**:按目标市场开支付方式(如 Alipay / WeChat Pay)。

## 4. 交接卡(发给产品开发 AI 的全部内容)

> 完整模板与逐项说明见 **[`CHECKLIST.md`](CHECKLIST.md) 第三部分(交接卡 v2)**,那是唯一权威版本,直接复制它填写。
> 核心构成一句话概括:**环境声明 + 三把钥匙 + 套餐信息表(planKey/类型/lookup_key/price_id/金额核对/features)+ 后台配置四项确认(E1~E4)+ 产品側四项(APP_URL/用户标识/数据库/前端框架)**。
> 「必填」栏空着 = 交接不合格,AI 会停下来向你索要,不会瞎猜。

## 5. 日常操作 SOP

### 5.1 改价(核心场景:全程不需要碰代码)

Stripe 的 Price 金额创建后不可修改,正确姿势是「新建价格 + 转移 lookup_key」:

1. 进入该 Product → **Add another price**,填新金额。
2. 新 Price 的 Advanced → Lookup key 填**同一个 key**,并勾选 **Transfer lookup key from existing price**(原子转移)。
3. 旧 Price 点 **Archive**(存量订阅不受影响,继续按旧价扣款;只影响新购)。
4. 完成。前端最迟 10 分钟内自动展示新价(webhook 生效时通常几秒内)。

> ⚠️ 不要用「Archive 旧价 → 新建同名 key」的顺序手工操作,中间会有空窗;必须用 Transfer 选项。

### 5.2 上新套餐

1. 按第 2 节建 Product/Price + lookup_key。
2. 通知产品 AI:「新增套餐 <planKey>,lookup_key=<xxx>,features=<…>」→ AI 在 `billing.config.ts` 加一行即可。

### 5.3 下架套餐

1. Stripe 后台 Archive 对应 Price(新用户买不到,老订阅不受影响)。
2. 通知产品 AI 从 config 移除该 planKey(不删也不报错,catalog 会自动过滤 inactive)。

### 5.4 沙箱 → 正式上线

1. 切到该产品的 **live account**(非 sandbox)。
2. 重跑第 2 节(建同样的 Product/Price/lookup_key,**命名必须与沙箱一致**)与第 3 节(webhook endpoint 用生产域名)。
3. 发新的交接卡(live 三把钥匙)给 AI 替换生产环境变量。**代码零改动**。

### 5.5 退款

Dashboard → Payments → 找到该笔 → Refund。订阅退款不自动取消订阅,如需取消到 Subscriptions 里操作(webhook 会自动同步到产品)。

## 6. 安全红线

- Secret key / Webhook secret 只通过安全渠道传递一次,不进 git、不留聊天记录、不进前端。
- 泄露疑虑时:Developers → API keys → **Roll key** 立即轮换,再把新 key 交给 AI 更新环境变量。
- 团队成员加入用 Stripe 的 Team 功能按角色授权,不共享主账号密码。

## 7. 常用后台入口速查

| 要做什么 | 路径 |
|---|---|
| 切换产品 account / sandbox | 左上角账户切换器 |
| 看某笔支付 | Payments |
| 看/改订阅 | Billing → Subscriptions |
| 商品与价格 | Product catalog |
| Webhook 投递记录与重发 | Developers → Webhooks → 选中 endpoint → 事件列表(可 Resend) |
| API keys | Developers → API keys |
| Customer Portal 功能开关 | Settings → Billing → Customer portal |
| 收入报表 | 首页 / Billing → Revenue |
