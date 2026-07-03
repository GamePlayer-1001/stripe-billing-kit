# Vue 3 接入指南

> 本文档是 `INTEGRATION.md` 的 Vue 3 前端补充。后端接入、环境变量、建表等步骤完全相同，仅前端部分替换为 Vue Composables。

## 安装

```bash
pnpm add @billing-kit/vue @billing-kit/core
# 后端适配器根据技术栈选择（@billing-kit/next 或 @billing-kit/express）
```

## 1. 根组件注入配置

```vue
<!-- App.vue -->
<script setup lang="ts">
import { provideBillingConfig } from '@billing-kit/vue';

provideBillingConfig({
  basePath: '/api/billing',       // API 路径，默认 /api/billing
  refetchInterval: 300000,         // 价格轮询间隔（毫秒），默认 5 分钟，设为 0 禁用
});
</script>

<template>
  <RouterView />
</template>
```

## 2. 定价页（Pricing.vue）

```vue
<script setup lang="ts">
import { usePlans, useCheckout } from '@billing-kit/vue';

const { plans, isLoading, error } = usePlans();
const { checkout, isPending } = useCheckout();

const formatMoney = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100);
</script>

<template>
  <div v-if="isLoading" class="grid grid-cols-3 gap-6">
    <div v-for="i in 3" :key="i" class="skeleton h-64" />
  </div>

  <div v-else-if="error" class="text-red-600">
    加载失败: {{ error.message }}
  </div>

  <div v-else class="grid grid-cols-3 gap-6">
    <div
      v-for="plan in plans"
      :key="plan.key"
      class="rounded-xl border p-6"
    >
      <h3 class="text-xl font-bold">{{ plan.product.name }}</h3>
      <p class="mt-2 text-3xl font-bold">
        {{ formatMoney(plan.price.unitAmount, plan.price.currency) }}
        <span v-if="plan.price.interval" class="text-sm text-gray-600">
          /{{ plan.price.interval }}
        </span>
      </p>
      <ul class="mt-4 space-y-2">
        <li v-for="feature in plan.product.marketingFeatures" :key="feature">
          ✓ {{ feature }}
        </li>
      </ul>
      <button
        :disabled="isPending"
        @click="checkout(plan.key)"
        class="mt-6 w-full rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {{ plan.type === 'subscription' ? '订阅' : '购买' }}
      </button>
    </div>
  </div>
</template>
```

## 3. 权益检查与付费墙

```vue
<script setup lang="ts">
import { useBillingStatus } from '@billing-kit/vue';
import { computed } from 'vue';

const { status, isLoading, hasAccess } = useBillingStatus();

const canAccessPro = computed(() => hasAccess('pro'));
</script>

<template>
  <div v-if="isLoading">加载中...</div>
  
  <!-- 付费墙 -->
  <div v-else-if="!canAccessPro">
    <div class="rounded-lg border-2 border-yellow-400 bg-yellow-50 p-6">
      <h3>🔒 专业版功能</h3>
      <p>升级解锁更多功能</p>
      <RouterLink to="/pricing" class="btn-primary">立即升级</RouterLink>
    </div>
  </div>

  <!-- 实际内容 -->
  <div v-else>
    <ProFeature />
  </div>
</template>
```

## 4. 账户页 - 管理订阅

```vue
<script setup lang="ts">
import { useBillingStatus, usePortal } from '@billing-kit/vue';

const { status, isLoading } = useBillingStatus();
const { openPortal, isPending } = usePortal();
</script>

<template>
  <div v-if="isLoading">加载中...</div>

  <div v-else-if="status?.subscription" class="space-y-4">
    <div class="rounded-lg border p-6">
      <h3 class="text-lg font-bold">当前订阅</h3>
      <p class="mt-2">
        <strong>{{ status.subscription.planKey }}</strong>
        （{{ status.subscription.status }}）
      </p>
      <p class="text-sm text-gray-600">
        {{ status.subscription.currentPeriodEnd ? 
           `续订时间: ${new Date(status.subscription.currentPeriodEnd).toLocaleDateString()}` :
           '终身访问' 
        }}
      </p>
      <button
        :disabled="isPending"
        @click="openPortal"
        class="mt-4 rounded-lg border px-4 py-2 hover:bg-gray-50"
      >
        管理订阅
      </button>
    </div>
  </div>

  <div v-else>
    <p>暂无活动订阅</p>
    <RouterLink to="/pricing">查看套餐</RouterLink>
  </div>
</template>
```

## 5. 成功回跳页（Success.vue）

```vue
<script setup lang="ts">
import { useBillingStatus } from '@billing-kit/vue';
import { onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();
const { refetch } = useBillingStatus();

onMounted(async () => {
  const sessionId = route.query.session_id as string;
  if (sessionId) {
    // 后端 success URL 已触发同步，前端等 1 秒后刷新状态
    await new Promise(resolve => setTimeout(resolve, 1000));
    await refetch();
  }
  
  // 3 秒后自动跳转
  setTimeout(() => router.push('/account'), 3000);
});
</script>

<template>
  <div class="flex min-h-screen items-center justify-center">
    <div class="rounded-lg border p-8 text-center">
      <div class="text-6xl">✅</div>
      <h2 class="mt-4 text-2xl font-bold">支付成功！</h2>
      <p class="mt-2 text-gray-600">权益已开通，正在跳转...</p>
    </div>
  </div>
</template>
```

## API 参考

### `provideBillingConfig(config?)`
在根组件注入配置（必须）。

### `usePlans()`
返回 `{ plans, isLoading, error, refetch }`。
- `plans`: `Ref<CatalogPlan[]>` - 商品目录，价格来自 Stripe
- `isLoading`: `Ref<boolean>` - 加载状态
- `error`: `Ref<Error | null>` - 错误信息
- `refetch`: `() => Promise<void>` - 手动刷新

### `useCheckout()`
返回 `{ checkout, isPending, error }`。
- `checkout`: `(planKey: string, quantity?: number) => Promise<void>` - 发起支付（自动跳转 Stripe Checkout）
- `isPending`: `Ref<boolean>` - 跳转中状态
- `error`: `Ref<Error | null>` - 错误信息

### `useBillingStatus()`
返回 `{ status, isLoading, error, refetch, hasAccess }`。
- `status`: `Ref<BillingStatus | null>` - 当前用户权益状态
- `hasAccess`: `(feature: string) => boolean` - 检查是否有某权益
- `refetch`: `() => Promise<void>` - 手动刷新

### `usePortal()`
返回 `{ openPortal, isPending, error }`。
- `openPortal`: `() => Promise<void>` - 打开 Stripe Customer Portal（管理订阅/付款方式）
- `isPending`: `Ref<boolean>` - 跳转中状态
- `error`: `Ref<Error | null>` - 错误信息

## 与 React 版本的差异

| 特性 | React | Vue 3 |
|------|-------|-------|
| 配置注入 | `<BillingProvider>` 组件 | `provideBillingConfig()` 函数 |
| 数据获取 | hooks 返回对象 | composables 返回 reactive refs |
| 组件封装 | 提供 `<SubscriptionGate>` 等组件 | 仅提供 composables，组件自行封装 |
| 价格轮询 | 自动 | 自动 |
| TypeScript | 完整支持 | 完整支持 |
