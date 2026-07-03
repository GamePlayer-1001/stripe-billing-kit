import { app, protocol, shell, type BrowserWindow } from 'electron';

export interface ElectronBillingConfig {
  /** 自定义协议名，如 'myapp'，对应 myapp://success */
  protocolScheme: string;
  /** API 基础路径，默认 http://localhost:3000/api/billing */
  apiBasePath: string;
  /** 成功回调处理器，参数为 session_id */
  onCheckoutSuccess?: (sessionId: string) => void | Promise<void>;
  /** 取消回调处理器 */
  onCheckoutCancel?: () => void | Promise<void>;
}

/**
 * Electron 主进程初始化 - 注册自定义协议拦截支付回调
 * 必须在 app.whenReady() 后、创建任何窗口前调用
 */
export function initElectronBilling(config: ElectronBillingConfig): void {
  const { protocolScheme, onCheckoutSuccess, onCheckoutCancel } = config;

  // 注册自定义协议（如 myapp://）
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(protocolScheme, process.execPath, [process.argv[1]!]);
    }
  } else {
    app.setAsDefaultProtocolClient(protocolScheme);
  }

  // Windows/Linux: 单实例锁 + 协议处理
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on('second-instance', (_event, commandLine) => {
    const url = commandLine.pop();
    if (url && typeof url === 'string') handleDeepLink(url, config);
  });

  // macOS: open-url 事件
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url, config);
  });

  // 拦截自定义协议（防止打开浏览器）
  protocol.registerSchemesAsPrivileged([
    { scheme: protocolScheme, privileges: { standard: true, secure: true } },
  ]);
}

function handleDeepLink(url: string, config: ElectronBillingConfig): void {
  const { protocolScheme, onCheckoutSuccess, onCheckoutCancel } = config;

  if (!url.startsWith(`${protocolScheme}://`)) return;

  try {
    const parsed = new URL(url);
    const path = parsed.hostname + parsed.pathname;

    if (path === 'success') {
      const sessionId = parsed.searchParams.get('session_id');
      if (sessionId && onCheckoutSuccess) {
        onCheckoutSuccess(sessionId);
      }
    } else if (path === 'cancel' && onCheckoutCancel) {
      onCheckoutCancel();
    }
  } catch (error) {
    console.error('[billing] 解析回调 URL 失败:', error);
  }
}

export interface ElectronCheckoutOptions {
  /** 套餐 key */
  planKey: string;
  /** 购买数量，默认 1 */
  quantity?: number;
  /** 当前主窗口（用于恢复焦点） */
  mainWindow?: BrowserWindow;
}

/**
 * 渲染进程调用：打开系统浏览器完成支付
 * 需通过 IPC 暴露给渲染进程
 */
export async function openCheckout(
  config: ElectronBillingConfig,
  options: ElectronCheckoutOptions,
): Promise<void> {
  const { apiBasePath } = config;
  const { planKey, quantity = 1 } = options;

  try {
    const res = await fetch(`${apiBasePath}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planKey, quantity }),
    });

    if (!res.ok) throw new Error(`创建支付会话失败: ${res.status}`);

    const data = await res.json() as { url: string };
    await shell.openExternal(data.url);
  } catch (error) {
    console.error('[billing] 打开支付页面失败:', error);
    throw error;
  }
}

/**
 * 打开客户门户（管理订阅）
 */
export async function openPortal(config: ElectronBillingConfig): Promise<void> {
  const { apiBasePath } = config;

  try {
    const res = await fetch(`${apiBasePath}/portal`, { method: 'POST' });
    if (!res.ok) throw new Error(`打开客户门户失败: ${res.status}`);

    const data = await res.json() as { url: string };
    await shell.openExternal(data.url);
  } catch (error) {
    console.error('[billing] 打开客户门户失败:', error);
    throw error;
  }
}
