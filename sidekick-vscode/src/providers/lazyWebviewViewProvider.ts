/**
 * Lazy webview view registration.
 *
 * Registers a `WebviewViewProvider` whose real provider is constructed on the
 * first `resolveWebviewView` call (or on demand through `get()`), so views the
 * user keeps collapsed cost nothing at activation: no session-monitor
 * subscriptions, no data-service construction, no timers.
 *
 * Only providers whose behaviour is entirely view-driven belong here. A
 * provider with view-independent side effects (the dashboard persists
 * decisions and session summaries; the task board carries tasks across
 * sessions) must stay eager.
 *
 * @module providers/lazyWebviewViewProvider
 */

import * as vscode from 'vscode';

export interface LazyWebviewView<T extends vscode.WebviewViewProvider & vscode.Disposable>
  extends vscode.Disposable {
  /** The provider when it has been constructed; undefined while the view has never been shown. */
  peek(): T | undefined;
  /** The provider, constructing it now when needed. */
  get(): T;
  /** Whether the provider has been constructed. */
  readonly created: boolean;
}

export interface RegisterLazyWebviewViewOptions {
  webviewOptions?: { retainContextWhenHidden?: boolean };
}

export function registerLazyWebviewView<T extends vscode.WebviewViewProvider & vscode.Disposable>(
  viewType: string,
  factory: () => T,
  options: RegisterLazyWebviewViewOptions = {},
): LazyWebviewView<T> {
  let instance: T | undefined;
  let disposed = false;

  const get = (): T => {
    if (disposed) throw new Error(`Webview view ${viewType} has been disposed`);
    instance ??= factory();
    return instance;
  };

  const registration = vscode.window.registerWebviewViewProvider(
    viewType,
    {
      resolveWebviewView: (webviewView, context, token) =>
        get().resolveWebviewView(webviewView, context, token),
    },
    options,
  );

  return {
    peek: () => instance,
    get,
    get created() {
      return instance !== undefined;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      registration.dispose();
      instance?.dispose();
      instance = undefined;
    },
  };
}
