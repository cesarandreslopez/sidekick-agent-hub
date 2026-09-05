import { beforeEach, describe, expect, it, vi } from 'vitest';

type ResolveForwarder = {
  resolveWebviewView: (view: unknown, context: unknown, token: unknown) => void;
};
const registrations = vi.hoisted(
  () => [] as Array<{ viewType: string; provider: ResolveForwarder; options: unknown }>,
);
const registrationDisposable = vi.hoisted(() => ({ dispose: vi.fn() }));

vi.mock('vscode', () => ({
  window: {
    registerWebviewViewProvider: (viewType: string, provider: unknown, options: unknown) => {
      registrations.push({ viewType, provider, options });
      return registrationDisposable;
    },
  },
}));

import { registerLazyWebviewView } from './lazyWebviewViewProvider';

describe('registerLazyWebviewView', () => {
  beforeEach(() => {
    registrations.length = 0;
    registrationDisposable.dispose.mockClear();
  });

  it('constructs the provider on the first resolve and forwards every resolve', () => {
    const resolveWebviewView = vi.fn();
    const dispose = vi.fn();
    const factory = vi.fn(() => ({ resolveWebviewView, dispose }));

    const lazy = registerLazyWebviewView('sidekick.test', factory, {
      webviewOptions: { retainContextWhenHidden: true },
    });

    expect(factory).not.toHaveBeenCalled();
    expect(lazy.created).toBe(false);
    expect(lazy.peek()).toBeUndefined();
    expect(registrations[0]).toMatchObject({
      viewType: 'sidekick.test',
      options: { webviewOptions: { retainContextWhenHidden: true } },
    });

    const view = { visible: true };
    registrations[0].provider.resolveWebviewView(view, 'ctx', 'token');
    registrations[0].provider.resolveWebviewView(view, 'ctx', 'token');

    expect(factory).toHaveBeenCalledTimes(1);
    expect(resolveWebviewView).toHaveBeenCalledTimes(2);
    expect(resolveWebviewView).toHaveBeenCalledWith(view, 'ctx', 'token');
    expect(lazy.created).toBe(true);
    expect(lazy.peek()).toBe(lazy.get());
  });

  it('constructs on demand through get() and disposes what it created', () => {
    const dispose = vi.fn();
    const factory = vi.fn(() => ({ resolveWebviewView: vi.fn(), dispose }));
    const lazy = registerLazyWebviewView('sidekick.test', factory);

    expect(lazy.get()).toBe(lazy.get());
    expect(factory).toHaveBeenCalledTimes(1);

    lazy.dispose();
    lazy.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registrationDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(lazy.peek()).toBeUndefined();
    expect(() => lazy.get()).toThrow(/disposed/);
  });

  it('disposing a never-shown view constructs nothing', () => {
    const factory = vi.fn(() => ({ resolveWebviewView: vi.fn(), dispose: vi.fn() }));
    const lazy = registerLazyWebviewView('sidekick.test', factory);
    lazy.dispose();
    expect(factory).not.toHaveBeenCalled();
    expect(registrationDisposable.dispose).toHaveBeenCalledTimes(1);
  });
});
