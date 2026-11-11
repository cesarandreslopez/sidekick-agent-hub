import { describe, expect, it, vi } from 'vitest';
import type { ActivityRecord, ActivityInsights, ActivitySnapshot } from 'sidekick-shared';
import {
  ActivityMapConnection,
  type ActivitySource,
  type WebviewLike,
} from './ActivityMapConnection';
import type { ActivityMapHostMessage, ActivityMapWebviewMessage } from '../types/activityMap';

function record(seq: number): ActivityRecord {
  return { seq, at: 1_000 + seq, kind: 'prompt' };
}

class FakeSource implements ActivitySource {
  readonly kind = 'live' as const;
  list: ActivityRecord[] = [];
  currentEpoch = 1;
  live = true;
  hasSession = true;
  private listeners = new Set<() => void>();

  info() {
    return this.hasSession
      ? {
          kind: 'live' as const,
          providerId: 'claude-code' as const,
          sessionId: 's1',
          label: 'Claude Code · s1',
        }
      : null;
  }
  epoch() {
    return this.currentEpoch;
  }
  nextSeq() {
    return this.list.length > 0 ? this.list[this.list.length - 1].seq + 1 : 0;
  }
  baseSeq() {
    return this.list[0]?.seq ?? 0;
  }
  records() {
    return this.list;
  }
  recordsFrom(seq: number) {
    const base = this.baseSeq();
    if (seq < base || seq > this.nextSeq()) return null;
    return this.list.slice(seq - base);
  }
  isLive() {
    return this.live;
  }
  snapshot() {
    return {} as ActivitySnapshot;
  }
  insights() {
    return {} as ActivityInsights;
  }
  onDidChange(listener: () => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  add(count: number) {
    const start = this.nextSeq();
    for (let i = 0; i < count; i++) this.list.push(record(start + i));
    this.fire();
  }
  reset() {
    this.list = [];
    this.currentEpoch++;
    this.fire();
  }
  fire() {
    for (const listener of this.listeners) listener();
  }
}

class FakeWebview implements WebviewLike {
  sent: ActivityMapHostMessage[] = [];
  private listener: ((message: ActivityMapWebviewMessage) => void) | undefined;
  postMessage(message: ActivityMapHostMessage) {
    this.sent.push(message);
    return true;
  }
  onDidReceiveMessage(listener: (message: ActivityMapWebviewMessage) => void) {
    this.listener = listener;
    return { dispose: () => (this.listener = undefined) };
  }
  receive(message: ActivityMapWebviewMessage) {
    this.listener?.(message);
  }
  types() {
    return this.sent.map((m) => m.type);
  }
}

function setup(options: { visible?: boolean } = {}) {
  const source = new FakeSource();
  const webview = new FakeWebview();
  let visible = options.visible ?? true;
  const visibilityListeners = new Set<() => void>();
  const hooks = {
    isVisible: () => visible,
    onDidChangeVisibility: (listener: () => void) => {
      visibilityListeners.add(listener);
      return { dispose: () => visibilityListeners.delete(listener) };
    },
    now: () => 42,
    onPopOut: vi.fn(),
    onExport: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  const connection = new ActivityMapConnection(webview, source, hooks);
  const setVisible = (value: boolean) => {
    visible = value;
    for (const listener of visibilityListeners) listener();
  };
  return { source, webview, connection, hooks, setVisible };
}

describe('ActivityMapConnection', () => {
  it('sends nothing before ready, then a full init', () => {
    const { source, webview } = setup();
    source.add(3);
    expect(webview.sent).toEqual([]);
    webview.receive({ type: 'activity/ready', protocol: 1 });
    expect(webview.sent).toHaveLength(1);
    const init = webview.sent[0];
    expect(init).toMatchObject({
      type: 'activity/init',
      epoch: 1,
      baseSeq: 0,
      nextSeq: 3,
      live: true,
      hostNow: 42,
    });
    expect(init.type === 'activity/init' && init.records.map((r) => r.seq)).toEqual([0, 1, 2]);
  });

  it('appends only the new records after init', () => {
    const { source, webview } = setup();
    source.add(2);
    webview.receive({ type: 'activity/ready', protocol: 1 });
    source.add(3);
    const append = webview.sent[1];
    expect(append).toMatchObject({ type: 'activity/append', epoch: 1, fromSeq: 2 });
    expect(append.type === 'activity/append' && append.records.map((r) => r.seq)).toEqual([
      2, 3, 4,
    ]);
    source.fire(); // nothing new: no message
    expect(webview.sent).toHaveLength(2);
  });

  it('re-inits when the epoch changes or the webview asks to resync', () => {
    const { source, webview } = setup();
    source.add(2);
    webview.receive({ type: 'activity/ready', protocol: 1 });
    source.reset();
    expect(webview.sent.at(-1)).toMatchObject({ type: 'activity/init', epoch: 2, nextSeq: 0 });
    source.add(1);
    expect(webview.sent.at(-1)).toMatchObject({ type: 'activity/append', epoch: 2, fromSeq: 0 });
    webview.receive({ type: 'activity/resync', reason: 'gap' });
    expect(webview.sent.at(-1)).toMatchObject({ type: 'activity/init', epoch: 2 });
  });

  it('re-inits when the records it would append were dropped', () => {
    const { source, webview } = setup();
    source.add(5);
    webview.receive({ type: 'activity/ready', protocol: 1 });
    source.list = source.list.slice(4); // records 0..3 dropped; seq 5 not yet held
    source.add(2);
    expect(webview.sent.at(-1)).toMatchObject({ type: 'activity/append', fromSeq: 5 });
    source.list = [record(10)];
    source.fire();
    expect(webview.sent.at(-1)).toMatchObject({ type: 'activity/init', baseSeq: 10 });
  });

  it('holds back while hidden and catches up when shown', () => {
    const { source, webview, setVisible } = setup();
    source.add(1);
    webview.receive({ type: 'activity/ready', protocol: 1 });
    setVisible(false);
    source.add(2);
    source.add(2);
    expect(webview.sent).toHaveLength(1);
    setVisible(true);
    expect(webview.sent).toHaveLength(2);
    expect(webview.sent[1]).toMatchObject({ type: 'activity/append', fromSeq: 1 });
    expect(webview.sent[1].type === 'activity/append' && webview.sent[1].records).toHaveLength(4);
  });

  it('reports liveness changes and an empty source', () => {
    const { source, webview } = setup();
    source.add(1);
    webview.receive({ type: 'activity/ready', protocol: 1 });
    source.live = false;
    source.fire();
    expect(webview.sent.at(-1)).toMatchObject({ type: 'activity/state', live: false });
    source.hasSession = false;
    source.fire();
    expect(webview.sent.at(-1)).toEqual({ type: 'activity/empty', reason: 'noSession' });
  });

  it('sends only the missing records to a webview that still holds this epoch', () => {
    const { source, webview } = setup();
    source.add(4);
    webview.receive({ type: 'activity/ready', protocol: 1, have: { epoch: 1, nextSeq: 2 } });
    expect(webview.sent[0]).toMatchObject({ type: 'activity/append', fromSeq: 2 });
    webview.receive({ type: 'activity/ready', protocol: 1, have: { epoch: 0, nextSeq: 2 } });
    expect(webview.sent.at(-1)).toMatchObject({ type: 'activity/init' });
  });

  it('carries a focus on the first init only', () => {
    const source = new FakeSource();
    const webview = new FakeWebview();
    source.add(2);
    new ActivityMapConnection(webview, source, {
      isVisible: () => true,
      focus: { at: 1_001, station: 'shell' },
    });
    webview.receive({ type: 'activity/ready', protocol: 1 });
    expect(webview.sent[0]).toMatchObject({
      type: 'activity/init',
      focus: { at: 1_001, station: 'shell' },
    });
    webview.receive({ type: 'activity/resync', reason: 'epoch' });
    expect(webview.sent[1]).not.toHaveProperty('focus');
  });

  it('routes pop-out, export and settings requests to the host', () => {
    const { webview, hooks } = setup();
    webview.receive({ type: 'activity/popOut', at: 5, station: 'files' });
    webview.receive({ type: 'activity/export', format: 'svg', at: 7 });
    webview.receive({ type: 'activity/export' });
    webview.receive({ type: 'activity/openSettings' });
    expect(hooks.onPopOut).toHaveBeenCalledWith({ at: 5, station: 'files' });
    expect(hooks.onExport).toHaveBeenNthCalledWith(1, { format: 'svg', at: 7 });
    expect(hooks.onExport).toHaveBeenNthCalledWith(2, { format: undefined, at: undefined });
    expect(hooks.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('stops listening once disposed', () => {
    const { source, webview, connection } = setup();
    webview.receive({ type: 'activity/ready', protocol: 1 });
    connection.dispose();
    source.add(2);
    expect(webview.sent).toHaveLength(1);
  });
});
