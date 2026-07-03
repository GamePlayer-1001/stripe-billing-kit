# GUI 应用集成指南

本指南覆盖桌面应用（Electron/Tauri/Qt）和移动应用（React Native/Flutter）如何集成 Billing Kit。

---

## 核心原理

GUI 应用通过 **localhost HTTP 服务 + 自定义 URL Scheme 回调** 完成支付流程：

1. **后端启动 HTTP 服务**（Express/Next.js）提供 5 个标准端点
2. **前端打开 WebView/浏览器** 访问 Stripe Checkout URL
3. **支付完成后重定向** 到自定义协议（如 `myapp://billing/success?session_id=xxx`）
4. **应用拦截协议** 解析参数，通知用户并刷新订阅状态

---

## 1️⃣ Electron（已有适配器）

### 安装

```bash
pnpm add @billing-kit/electron @billing-kit/core stripe
```

### 主进程初始化

```typescript
// main.ts
import { app, ipcMain } from 'electron';
import { initBillingIpc, registerProtocolHandler } from '@billing-kit/electron';
import Stripe from 'stripe';
import Database from 'better-sqlite3';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-11-20.acacia' });
const db = new Database('app.db');

// 注册自定义协议拦截（必须在 app.ready 之前）
app.setAsDefaultProtocolClient('myapp');

app.whenReady().then(() => {
  // 1. 注册协议处理器（拦截 myapp://billing/* 回调）
  registerProtocolHandler('myapp');

  // 2. 初始化 IPC（暴露 openCheckout/openPortal 给渲染进程）
  initBillingIpc({
    stripe,
    db,
    successUrl: 'myapp://billing/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'myapp://billing/cancel',
    plans: [
      { key: 'pro_monthly', ref: { lookupKey: 'pro_monthly' }, name: 'Pro 月付', features: ['无限项目', '优先支持'] }
    ]
  });
});
```

### 渲染进程调用

```typescript
// renderer.tsx
import { useEffect, useState } from 'react';

function BillingPage() {
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    // 监听支付完成事件
    window.electron.onBillingSuccess((sessionId: string) => {
      setStatus('支付成功！正在同步订阅...');
    });
  }, []);

  const handleSubscribe = async () => {
    // 调用主进程打开 Stripe Checkout
    await window.electron.openCheckout('pro_monthly');
  };

  return (
    <div>
      <button onClick={handleSubscribe}>订阅 Pro</button>
      <p>{status}</p>
    </div>
  );
}
```

### preload.ts 类型声明

```typescript
// preload.d.ts
interface Window {
  electron: {
    openCheckout: (planKey: string) => Promise<void>;
    openPortal: () => Promise<void>;
    onBillingSuccess: (callback: (sessionId: string) => void) => void;
  };
}
```

---

## 2️⃣ Tauri（原生桌面应用）

### 后端（Rust + localhost HTTP）

```toml
# Cargo.toml
[dependencies]
tauri = "2.0"
axum = "0.7"
```

```rust
// src-tauri/src/main.rs
use tauri::Manager;

#[tauri::command]
async fn open_checkout(plan_key: String) -> Result<(), String> {
    let url = format!("http://localhost:3000/api/billing/checkout?plan={}", plan_key);
    open::that(url).map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    // 注册自定义协议
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let handle = app.handle();
            tauri_plugin_deep_link::register("myapp", move |request| {
                if request.starts_with("myapp://billing/success") {
                    // 解析 session_id 参数
                    handle.emit_all("billing:success", request).ok();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_checkout])
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}
```

### 前端（任意框架）

```typescript
// React/Vue/Svelte 示例
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// 订阅支付成功事件
listen<string>('billing:success', (event) => {
  const url = new URL(event.payload);
  const sessionId = url.searchParams.get('session_id');
  console.log('支付成功:', sessionId);
});

// 打开支付页面
async function subscribe() {
  await invoke('open_checkout', { planKey: 'pro_monthly' });
}
```

---

## 3️⃣ Qt/C++（原生桌面）

### 启动 localhost 服务（Node.js Express）

```cpp
// billing_manager.cpp
#include <QProcess>
#include <QDesktopServices>
#include <QUrl>

class BillingManager : public QObject {
  Q_OBJECT
private:
  QProcess* serverProcess;

public:
  BillingManager() {
    // 启动 Node.js 后端
    serverProcess = new QProcess(this);
    serverProcess->start("node", QStringList() << "billing-server.js");
  }

  void openCheckout(const QString& planKey) {
    QString url = QString("http://localhost:3000/api/billing/checkout?plan=%1").arg(planKey);
    QDesktopServices::openUrl(QUrl(url));
  }

  ~BillingManager() {
    serverProcess->terminate();
  }
};
```

### 注册自定义协议

```cpp
// main.cpp
#include <QApplication>
#include <QUrl>

int main(int argc, char *argv[]) {
  QApplication app(argc, argv);
  
  // 注册协议处理器
  QDesktopServices::setUrlHandler("myapp", &app, "handleCustomUrl");
  
  // 检查启动参数（支持从协议唤起）
  if (argc > 1) {
    QString arg = argv[1];
    if (arg.startsWith("myapp://billing/success")) {
      QUrl url(arg);
      QString sessionId = QUrlQuery(url).queryItemValue("session_id");
      // 触发支付成功信号
      emit app.billingSuccess(sessionId);
    }
  }
  
  return app.exec();
}
```

---

## 4️⃣ React Native（移动应用）

### 安装

```bash
npm install react-native-webview react-native-url-polyfill
```

### 配置自定义协议

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<activity android:name=".MainActivity">
  <intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="myapp" android:host="billing" />
  </intent-filter>
</activity>
```

```xml
<!-- ios/YourApp/Info.plist -->
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>myapp</string>
    </array>
  </dict>
</array>
```

### 实现支付页面

```typescript
// BillingScreen.tsx
import React, { useRef } from 'react';
import { WebView } from 'react-native-webview';
import { Linking } from 'react-native';

export function BillingScreen({ planKey }: { planKey: string }) {
  const webviewRef = useRef<WebView>(null);
  const checkoutUrl = `https://your-server.com/api/billing/checkout?plan=${planKey}`;

  const handleNavigationStateChange = (navState: any) => {
    const { url } = navState;
    
    // 拦截自定义协议
    if (url.startsWith('myapp://billing/success')) {
      const urlObj = new URL(url);
      const sessionId = urlObj.searchParams.get('session_id');
      
      // 通知后端验证支付
      fetch(`https://your-server.com/api/billing/verify?session_id=${sessionId}`)
        .then(() => {
          Alert.alert('成功', '订阅已激活！');
          navigation.goBack();
        });
      
      return false; // 阻止 WebView 导航
    }
    
    return true;
  };

  return (
    <WebView
      ref={webviewRef}
      source={{ uri: checkoutUrl }}
      onNavigationStateChange={handleNavigationStateChange}
      onShouldStartLoadWithRequest={(request) => {
        // iOS 拦截自定义协议
        if (request.url.startsWith('myapp://')) {
          Linking.openURL(request.url);
          return false;
        }
        return true;
      }}
    />
  );
}
```

---

## 5️⃣ Flutter（跨平台）

### 安装依赖

```yaml
# pubspec.yaml
dependencies:
  webview_flutter: ^4.0.0
  uni_links: ^0.5.1
  url_launcher: ^6.1.0
```

### 配置自定义协议（同 React Native）

### 实现支付页面

```dart
// billing_page.dart
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:uni_links/uni_links.dart';

class BillingPage extends StatefulWidget {
  final String planKey;
  const BillingPage({required this.planKey});

  @override
  State<BillingPage> createState() => _BillingPageState();
}

class _BillingPageState extends State<BillingPage> {
  late final WebViewController _controller;

  @override
  void initState() {
    super.initState();
    
    // 监听自定义协议
    uriLinkStream.listen((Uri? uri) {
      if (uri?.scheme == 'myapp' && uri?.host == 'billing') {
        if (uri?.pathSegments.first == 'success') {
          final sessionId = uri?.queryParameters['session_id'];
          _handlePaymentSuccess(sessionId);
        }
      }
    });

    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(NavigationDelegate(
        onNavigationRequest: (NavigationRequest request) {
          if (request.url.startsWith('myapp://')) {
            // 拦截自定义协议
            return NavigationDecision.prevent;
          }
          return NavigationDecision.navigate;
        },
      ))
      ..loadRequest(Uri.parse('https://your-server.com/api/billing/checkout?plan=${widget.planKey}'));
  }

  void _handlePaymentSuccess(String? sessionId) {
    Navigator.pop(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('订阅成功！')),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('订阅')),
      body: WebViewWidget(controller: _controller),
    );
  }
}
```

---

## 📋 通用 URL Scheme 设计规范

所有平台统一使用以下 URL 格式：

| 场景 | URL 格式 | 说明 |
|------|----------|------|
| 支付成功 | `myapp://billing/success?session_id={CHECKOUT_SESSION_ID}` | Stripe 自动替换 `{CHECKOUT_SESSION_ID}` |
| 支付取消 | `myapp://billing/cancel` | 用户点击返回 |
| 管理订阅完成 | `myapp://billing/portal` | 从 Customer Portal 返回 |

### 后端配置示例

```typescript
// billing.config.ts
export const billingConfig = {
  successUrl: 'myapp://billing/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'myapp://billing/cancel',
  // ...
};
```

---

## 🔐 安全建议

1. **验证回调真实性**：收到 `success` 回调后，必须调用后端 API 验证 `session_id`，不能仅凭前端回调判断支付成功
2. **HTTPS 强制**：生产环境的 HTTP 服务必须启用 HTTPS（localhost 开发除外）
3. **协议域名限制**：自定义协议仅接受特定域名回调（防止钓鱼）

```typescript
// 验证回调来源
function isValidCallback(url: string): boolean {
  return url.startsWith('myapp://billing/') || 
         url.startsWith('https://checkout.stripe.com/');
}
```

---

## 调试技巧

### 测试自定义协议

```bash
# macOS/Linux
open "myapp://billing/success?session_id=cs_test_123"

# Windows
start myapp://billing/success?session_id=cs_test_123

# Android (adb)
adb shell am start -a android.intent.action.VIEW -d "myapp://billing/success?session_id=cs_test_123"

# iOS (xcrun)
xcrun simctl openurl booted "myapp://billing/success?session_id=cs_test_123"
```

### 查看 Stripe Webhook 日志

```bash
stripe listen --forward-to localhost:3000/api/billing/webhook
```

---

## 常见问题

**Q: 支付完成后回调没触发？**  
A: 检查自定义协议是否正确注册（需要在应用启动前注册），查看系统日志确认协议是否被拦截。

**Q: WebView 打不开 Stripe 页面？**  
A: 确保启用 JavaScript 模式，检查网络权限配置（Android 需要 `INTERNET` 权限）。

**Q: 如何在开发环境测试？**  
A: 使用 `stripe listen` 转发 webhook 到 localhost，并用上述命令手动触发协议回调。
