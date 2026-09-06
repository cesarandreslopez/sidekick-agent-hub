/** Keyboard navigation, session selection, and actionable session states. */
import type {
  DashboardMessage,
  DashboardTab,
  DashboardWebviewMessage,
  SessionAvailability,
} from '../../types/dashboard';

type SessionList = Extract<DashboardMessage, { type: 'updateSessionList' }>;
interface NavigationOptions {
  post(message: DashboardWebviewMessage): void;
  onTabChange(tab: DashboardTab): void;
}

function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function createNavigation(doc: Document) {
  let availability: SessionAvailability | undefined;
  const text = (id: string, value: string) => {
    const element = doc.getElementById(id);
    if (element) element.textContent = value;
  };
  const syncAvailability = () => {
    if (!availability) return;
    const { status, providerName, workspacePath, sessionDirectory, message } = availability;
    const active = status === 'active';
    const content = doc.getElementById('content');
    const dashboard = doc.getElementById('dashboard');
    if (content) content.style.display = active ? 'none' : 'block';
    if (dashboard) dashboard.style.display = active ? 'block' : 'none';
    text(
      'status',
      { active: 'Active', paused: 'Paused', empty: 'No Session', unavailable: 'Unavailable' }[
        status
      ],
    );
    doc.getElementById('status')?.setAttribute('class', `status ${active ? 'active' : 'inactive'}`);
    text(
      'empty-state-title',
      status === 'paused'
        ? 'Session monitoring is paused.'
        : status === 'unavailable'
          ? `${providerName} sessions are unavailable.`
          : `No ${providerName} sessions found.`,
    );
    text(
      'empty-state-hint',
      message ||
        (status === 'paused'
          ? 'Resume monitoring to follow session activity.'
          : !workspacePath && !sessionDirectory
            ? 'Open a workspace folder, or browse for an existing session.'
            : `Start ${providerName} in this workspace, or browse for an existing session.`),
    );
    text(
      'empty-state-location',
      [
        `Provider: ${providerName}`,
        workspacePath ? `Workspace: ${workspacePath}` : '',
        sessionDirectory ? `Session location: ${sessionDirectory}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    const resume = doc.getElementById('resume-monitoring');
    if (resume) resume.hidden = status !== 'paused';
  };
  const expand = (sectionId: string, expanded = true) => {
    const section = doc.getElementById(sectionId);
    if (!section) return;
    section.classList.toggle('expanded', expanded);
    for (const button of Array.from(
      doc.querySelectorAll<HTMLElement>('[data-toggle-section], [data-group-toggle]'),
    )) {
      if ((button.dataset.toggleSection ?? button.dataset.groupToggle) !== sectionId) continue;
      button.setAttribute('aria-expanded', String(expanded));
      const body = doc.getElementById(button.getAttribute('aria-controls') ?? '');
      if (body) body.hidden = !expanded;
    }
  };
  return {
    expand,
    syncAvailability,
    renderAvailability(value: SessionAvailability) {
      availability = value;
      syncAvailability();
    },
    mount(options: NavigationOptions) {
      const tabs = Array.from(doc.querySelectorAll<HTMLButtonElement>('.tab-btn'));
      const selectTab = (button: HTMLButtonElement) => {
        for (const tab of tabs) {
          const selected = tab === button;
          tab.classList.toggle('active', selected);
          tab.setAttribute('aria-selected', String(selected));
          tab.tabIndex = selected ? 0 : -1;
          const panel = doc.getElementById(tab.getAttribute('aria-controls') ?? '');
          if (panel) {
            panel.classList.toggle('active', selected);
            panel.hidden = !selected;
          }
        }
        options.onTabChange(button.dataset.tab as DashboardTab);
      };
      for (const [index, button] of tabs.entries()) {
        button.tabIndex = button.classList.contains('active') ? 0 : -1;
        button.addEventListener('click', () => selectTab(button));
        button.addEventListener('keydown', (event) => {
          let next: number;
          if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
          else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = tabs.length - 1;
          else return;
          event.preventDefault();
          tabs[next].focus();
          selectTab(tabs[next]);
        });
      }
      for (const button of Array.from(
        doc.querySelectorAll<HTMLButtonElement>('[data-toggle-section], [data-group-toggle]'),
      )) {
        const id = button.dataset.toggleSection ?? button.dataset.groupToggle!;
        expand(id, doc.getElementById(id)?.classList.contains('expanded') ?? false);
        button.addEventListener('click', () =>
          expand(id, !doc.getElementById(id)?.classList.contains('expanded')),
        );
      }
      doc.getElementById('session-list')?.addEventListener('click', (event) => {
        const card = (event.target as Element).closest<HTMLButtonElement>('button.session-card');
        if (card?.dataset.path)
          options.post({ type: 'selectSession', sessionPath: card.dataset.path });
      });
      const actions: Record<string, DashboardWebviewMessage> = {
        'empty-refresh': { type: 'refreshSessions' },
        'empty-browse': { type: 'browseSessionFolders' },
        'empty-doctor': { type: 'runDoctor' },
        'resume-monitoring': { type: 'resumeMonitoring' },
      };
      for (const [id, message] of Object.entries(actions)) {
        doc.getElementById(id)?.addEventListener('click', () => options.post(message));
      }
    },
    renderSessions(value: SessionList) {
      const list = doc.getElementById('session-list');
      if (!list) return;
      const focused = doc.activeElement as HTMLElement | null;
      const focusedPath = list.contains(focused)
        ? focused?.closest<HTMLElement>('[data-path]')?.dataset.path
        : undefined;
      const scrollTop = list.scrollTop;
      const fragment = doc.createDocumentFragment();
      for (const group of value.groups) {
        if (group.proximity !== 'current') {
          const heading = doc.createElement('div');
          heading.className = 'session-group-header';
          heading.textContent = group.displayPath || group.projectPath;
          fragment.append(heading);
        }
        for (const [index, session] of group.sessions.entries()) {
          const card = doc.createElement('button');
          card.type = 'button';
          card.className = `session-card${session.isCurrent ? ' current' : ''}`;
          card.dataset.path = session.path;
          card.setAttribute('aria-pressed', String(session.isCurrent));
          const status = doc.createElement('span');
          status.className = 'session-card-status';
          status.setAttribute('aria-hidden', 'true');
          const dot = doc.createElement('span');
          dot.className = `status-dot${session.isActive ? ' active' : ''}`;
          status.append(dot);
          const content = doc.createElement('span');
          content.className = 'session-card-content';
          const label = doc.createElement('span');
          label.className = 'session-card-label';
          label.textContent = session.label || `${session.filename.slice(0, 8)}…`;
          const meta = doc.createElement('span');
          meta.className = 'session-card-meta';
          meta.textContent =
            index === 0 && group.proximity === 'current'
              ? 'Latest'
              : relativeTime(session.modifiedTime);
          content.append(label, meta);
          card.append(status, content);
          fragment.append(card);
        }
      }
      if (!fragment.querySelector('.session-card')) {
        const empty = doc.createElement('div');
        empty.className = 'session-list-empty';
        empty.textContent = 'No sessions available. Use Browse or Run Doctor below.';
        fragment.append(empty);
      }
      list.replaceChildren(fragment);
      if (focusedPath) {
        const replacement = Array.from(
          list.querySelectorAll<HTMLButtonElement>('.session-card'),
        ).find((card) => card.dataset.path === focusedPath);
        (replacement ?? doc.getElementById('refresh-sessions'))?.focus({ preventScroll: true });
      }
      list.scrollTop = scrollTop;
      const pin = doc.getElementById('pin-session');
      if (pin) {
        pin.textContent = value.isPinned ? 'Unpin' : 'Pin';
        pin.classList.toggle('pinned', value.isPinned);
        pin.setAttribute('aria-pressed', String(value.isPinned));
        pin.title = value.isPinned
          ? 'Unpin session to allow auto-switching'
          : 'Pin session to prevent auto-switching';
      }
      doc
        .getElementById('custom-path-indicator')
        ?.classList.toggle('visible', Boolean(value.isUsingCustomPath && value.customPathDisplay));
      text('custom-path-text', value.customPathDisplay ? `Custom: ${value.customPathDisplay}` : '');
    },
  };
}
export type DashboardNavigation = ReturnType<typeof createNavigation>;
