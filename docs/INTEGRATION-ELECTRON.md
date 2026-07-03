# Electron 接入指南

> 本文档说明如何在 Electron 桌面应用中接入 Stripe 支付。核心挑战：Stripe Checkout 是网页，需要打开系统浏览器跳转，并通过自定义协议（如 `myapp://success`）回调。

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│ Electron 主进程                                              │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ initElectronBilling()                                   │ │
│ │ - 注册自定义协议（myapp://）                             │ │
│ │ - 拦截回调 URL（success/cancel）                         │ │
│ │ - 触发回调处理器（onCheckoutSuccess/onCheckoutCancel）  │ │
│ └─────────────────────────────────────────────────────────┘ │
│                              ↕                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ IPC 暴露给渲染进程                                        │ │
│ │ - billing:checkout(planKey) → openCheckout()            │ │
│ │ - billing:portal() → openPortal()                       │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────┐
│ 渲染进程（前端）                                             │
│ - 调用 window.electron.billing.checkout('pro_monthly')    │
│ - 系统浏览器打开 Stripe Checkout                           │
│ - 用户完成支付 → 浏览器跳转 myapp://success?session_id=xx │
│ - 主进程拦截 → 回调 → 渲染进程刷新权益                     │
└─────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────┐
│ 后端 API（可选：本地 Express 或云端）                        │
│ - POST /api/billing/checkout → 创建 Stripe session        │
│ - POST /api/billing/webhook → 同步订阅状态到本地 DB        │
│ - GET /api/billing/me → 查询当前用户权益                   │
└─────────────────────────────────────────────────────────────┘
```

## 1. 安装

```bash
pnpm add @billing-kit/electron @billing-kit/core
# 后端适配器根据架构选择（本地 Express 或云端 Next.js）
```

## 2. 主进程初始化（main.ts / main.js）

```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  initElectronBilling,
  openCheckout,
  openPortal,
  type ElectronBillingConfig,
} from '@billing-kit/electron';

const billingConfig: ElectronBillingConfig = {
  protocolScheme: 'myapp',                          // 自定义协议名
  apiBasePath: 'http://localhost:3000/api/billing', // 后端 API 地址（本地或云端）
  onCheckoutSuccess: async (sessionId) => {
    console.log('[billing] 支付成功:', sessionId);
    // 通知渲染进程刷新权益
    mainWindow?.webContents.send('billing:success', sessionId);
  },
  onCheckoutCancel: async () => {
    console.log('[billing] 用户取消支付');
    mainWindow?.webContents.send('billing:cancel');
  },
};

let mainWindow: BrowserWindow | null = null;

app.whenReady().then(() => {
  // ⚠️ 必须在创建任何窗口前调用
  initElectronBilling(billingConfig);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');

  // 暴露 IPC 给渲染进程
  ipcMain.handle('billing:checkout', async (_event, planKey: string, quantity?: number) => {
    await openCheckout(billingConfig, { planKey, quantity, mainWindow: mainWindow! });
  });

  ipcMain.handle('billing:portal', async () => {
    await openPortal(billingConfig);
  });
});

// macOS 保持激活
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = new BrowserWindow({ /* ... */ });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

## 3. Preload 脚本（preload.ts）

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  billing: {
    checkout: (planKey: string, quantity?: number) =>
      ipcRenderer.invoke('billing:checkout', planKey, quantity),
    portal: () => ipcRenderer.invoke('billing:portal'),
    onSuccess: (callback: (sessionId: string) => void) =>
      ipcRenderer.on('billing:success', (_event, sessionId) => callback(sessionId)),
    onCancel: (callback: () => void) =>
      ipcRenderer.on('billing:cancel', callback),
  },
});
```

## 4. 渲染进程（前端）- 定价页

```tsx
// 纯 JS/TS（无框架）
const pricingContainer = document.getElementById('pricing');

async function loadPlans() {
  const res = await fetch('http://localhost:3000/api/billing/catalog');
  const data = await res.json();
  
  pricingContainer.innerHTML = data.plans.map((plan) => `
    <div class="plan-card">
      <h3>${plan.product.name}</h3>
      <p class="price">${formatMoney(plan.price.unitAmount, plan.price.currency)}</p>
      <button onclick="checkout('${plan.key}')">
        ${plan.type === 'subscription' ? '订阅' : '购买'}
      </button>
    </div>
  `).join('');
}

async function checkout(planKey: string) {
  await window.electron.billing.checkout(planKey);
}

// 监听支付成功回调
window.electron.billing.onSuccess((sessionId) => {
  console.log('支付成功:', sessionId);
  // 刷新权益状态
  loadBillingStatus();
});

window.electron.billing.onCancel(() => {
  console.log('支付已取消');
});

loadPlans();
```

### 或使用 React（渲染进程）

```tsx
import { useEffect, useState } from 'react';

export function Pricing() {
  const [plans, setPlans] = useState([]);

  useEffect(() => {
    fetch('http://localhost:3000/api/billing/catalog')
      .then(res => res.json())
      .then(data => setPlans(data.plans));

    // 监听支付成功
    window.electron.billing.onSuccess((sessionId) => {
      console.log('支付成功:', sessionId);
      // 刷新权益或跳转到账户页
    });
  }, []);

  const handleCheckout = async (planKey: string) => {
    await window.electron.billing.checkout(planKey);
  };

  return (
    <div className="grid grid-cols-3 gap-6">
      {plans.map((plan) => (
        <div key={plan.key} className="plan-card">
          <h3>{plan.product.name}</h3>
          <button onClick={() => handleCheckout(plan.key)}>
            {plan.type === 'subscription' ? '订阅' : '购买'}
          </button>
        </div>
      ))}
    </div>
  );
}
```

## 5. 配置自定义协议（重要）

### macOS (Info.plist)
```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>MyApp Protocol</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>myapp</string>
    </array>
  </dict>
</array>
```

### Windows (package.json)
```json
{
  "build": {
    "protocols": [
      {
        "name": "myapp-protocol",
        "schemes": ["myapp"]
      }
    ]
  }
}
```

### Linux (electron-builder)
```json
{
  "build": {
    "linux": {
      "desktop": {
        "MimeType": "x-scheme-handler/myapp"
      }
    }
  }
}
```

## 6. 后端选择（两种架构）

### 方案 A：本地 Express 服务（应用内嵌）
```ts
// main.ts 中启动 Express
import express from 'express';
import { createExpressBillingRouter } from '@billing-kit/express';
import { billingConfig } from './billing.config';

const app = express();
app.use('/api/billing', createExpressBillingRouter(billingConfig, {
  resolveUser: async () => 'local-user', // 桌面应用单用户
}));

app.listen(3000, () => {
  console.log('[billing] API 已启动: http://localhost:3000');
});
```

### 方案 B：云端 API（推荐生产环境）
- 后端部署在云端（Vercel / Railway / Fly.io）
- `apiBasePath` 指向云端地址：`https://api.yourapp.com/billing`
- 优势：Webhook 稳定、不依赖用户本地网络、支持多设备同步

## 7. 常见问题

### Q1: 点击支付按钮后没反应？
- 检查主进程日志，确认 `openCheckout()` 被调用
- 确认 `apiBasePath` 可访问（ping 一下）
- 确认 Stripe API key 正确（后端日志）

### Q2: 浏览器打开支付页后，完成支付没回调？
- 检查自定义协议是否注册成功（macOS: `defaults read ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`）
- 检查 `billing.config.ts` 中 `checkoutSuccess` URL 是否为 `myapp://success?session_id={CHECKOUT_SESSION_ID}`
- Windows/Linux: 重启应用生效

### Q3: 如何本地测试 Webhook？
```bash
# 在开发机启动 Stripe CLI 转发
stripe listen --forward-to http://localhost:3000/api/billing/webhook

# 触发测试事件
stripe trigger checkout.session.completed
```

### Q4: 如何区分开发环境和生产环境？
```ts
const billingConfig: ElectronBillingConfig = {
  protocolScheme: 'myapp',
  apiBasePath: process.env.NODE_ENV === 'production'
    ? 'https://api.yourapp.com/billing'
    : 'http://localhost:3000/api/billing',
  // ...
};
```

## 8. 安全注意事项

1. **Secret Key 不能打包进渲染进程**：只放在主进程或云端后端
2. **本地 Express 端口**：监听 `127.0.0.1`，不要 `0.0.0.0`（防外部访问）
3. **Webhook 验签**：云端后端必须验签（套件已内置）

## API 参考

### `initElectronBilling(config)`
主进程初始化，必须在 `app.whenReady()` 后、创建窗口前调用。

参数:
```ts
interface ElectronBillingConfig {
  protocolScheme: string;          // 自定义协议名（如 'myapp'）
  apiBasePath: string;              // 后端 API 地址
  onCheckoutSuccess?: (sessionId: string) => void | Promise<void>;
  onCheckoutCancel?: () => void | Promise<void>;
}
```

### `openCheckout(config, options)`
打开系统浏览器完成支付。

```ts
interface ElectronCheckoutOptions {
  planKey: string;
  quantity?: number;
  mainWindow?: BrowserWindow;  // 用于恢复焦点
}
```

### `openPortal(config)`
打开 Stripe Customer Portal（管理订阅/付款方式）。
