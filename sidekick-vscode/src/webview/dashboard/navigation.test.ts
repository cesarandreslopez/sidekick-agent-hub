// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDashboardHtml } from '../../providers/dashboardTemplate';
import { createNavigation } from './navigation';
import type { SessionGroup } from '../../types/dashboard';

function mount() {
  const navigation = createNavigation(document);
  const post = vi.fn();
  const onTabChange = vi.fn();
  navigation.mount({ post, onTabChange });
  return { navigation, post, onTabChange };
}
function button(selector: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(selector)!;
}
const group: SessionGroup = {
  projectPath: '/workspace',
  displayPath: '/workspace',
  proximity: 'current',
  sessions: [
    {
      path: '/virtual/session',
      filename: 'session',
      modifiedTime: '2026-09-06T00:00:00Z',
      isCurrent: true,
      isActive: true,
      label: 'A <script>literal</script> prompt',
    },
  ],
};
beforeEach(() => {
  const html = renderDashboardHtml({
    nonce: 'test',
    cspSource: 'test:',
    chartjsUri: '',
    scriptUri: '',
    iconUri: '',
    extVersion: 'test',
    extDate: '',
    initJson: '{}',
  });
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
});

describe('dashboard navigation', () => {
  it('moves tab focus and selection with arrows, Home, and End', () => {
    const { onTabChange } = mount();
    const session = button('[data-tab="session"]');
    session.focus();
    session.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    const summary = button('[data-tab="summary"]');
    expect(document.activeElement).toBe(summary);
    expect(summary.getAttribute('aria-selected')).toBe('true');
    expect(session.tabIndex).toBe(-1);
    expect(document.getElementById('session-tab')!.hidden).toBe(true);
    summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    expect(document.activeElement).toBe(button('[data-tab="health"]'));
    button('[data-tab="health"]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight' }),
    );
    expect(document.activeElement).toBe(session);
    session.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    button('[data-tab="health"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    expect(document.activeElement).toBe(session);
    expect(onTabChange.mock.calls.map(([tab]) => tab)).toEqual([
      'summary',
      'health',
      'session',
      'health',
      'session',
    ]);
  });

  it('selects sessions with native buttons and preserves focus through refreshes', () => {
    const { navigation, post } = mount();
    navigation.renderSessions({ type: 'updateSessionList', groups: [group], isPinned: false });
    const card = button('.session-card');
    expect(card.tagName).toBe('BUTTON');
    expect(card.textContent).toContain('A <script>literal</script> prompt');
    expect(card.querySelector('script')).toBeNull();
    card.focus();
    card.click();
    expect(post).toHaveBeenCalledWith({ type: 'selectSession', sessionPath: '/virtual/session' });
    navigation.renderSessions({ type: 'updateSessionList', groups: [group], isPinned: true });
    expect(document.activeElement).toBe(button('.session-card'));
    expect(button('#pin-session').getAttribute('aria-pressed')).toBe('true');
    navigation.renderSessions({ type: 'updateSessionList', groups: [], isPinned: false });
    expect(document.activeElement).toBe(button('#refresh-sessions'));
  });

  it('expands sections with independent controls and hides collapsed content from focus', () => {
    const { navigation } = mount();
    const toggle = button('[data-group-toggle="session-activity-section"]');
    const content = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(toggle.tagName).toBe('BUTTON');
    expect(content.hidden).toBe(true);
    toggle.click();
    expect(content.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    button('#event-log-toggle').click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    expect(content.hidden).toBe(true);
    navigation.expand('suggestions-panel');
    expect(document.getElementById('suggestions-body')!.hidden).toBe(false);
    expect(button('[data-toggle-section="suggestions-panel"]').getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it.each(['paused', 'empty', 'unavailable'] as const)(
    'explains %s sessions and provides working recovery actions',
    (status) => {
      const { navigation, post } = mount();
      navigation.renderAvailability({
        status,
        providerName: 'Codex CLI',
        workspacePath: '/workspace',
        sessionDirectory: '/sessions',
        message: status === 'unavailable' ? 'Cannot read session files.' : undefined,
      });
      expect(document.getElementById('content')!.style.display).toBe('block');
      expect(document.getElementById('dashboard')!.style.display).toBe('none');
      expect(document.getElementById('empty-state-location')!.textContent).toContain(
        'Provider: Codex CLI',
      );
      expect(document.getElementById('empty-state-location')!.textContent).toContain('/workspace');
      expect(button('#resume-monitoring').hidden).toBe(status !== 'paused');
      button('#empty-refresh').click();
      button('#empty-browse').click();
      button('#empty-doctor').click();
      expect(post.mock.calls.map(([message]) => message.type)).toEqual([
        'refreshSessions',
        'browseSessionFolders',
        'runDoctor',
      ]);
      if (status === 'paused') {
        button('#resume-monitoring').click();
        expect(post).toHaveBeenLastCalledWith({ type: 'resumeMonitoring' });
      }
      navigation.renderAvailability({
        status: 'active',
        providerName: 'Codex CLI',
        workspacePath: '/workspace',
        sessionDirectory: '/sessions',
      });
      expect(document.getElementById('content')!.style.display).toBe('none');
      expect(document.getElementById('dashboard')!.style.display).toBe('block');
    },
  );
});
