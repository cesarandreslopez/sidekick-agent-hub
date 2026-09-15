/**
 * @fileoverview Unit tests for NotificationTriggerService.
 *
 * Tests destructive command pattern matching, description field usage,
 * sensitive path triggers, false positive avoidance, and the notification
 * action buttons (Open Dashboard / Snooze 1h / Mute This Trigger).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionMonitor } from './SessionMonitor';
import type { NotificationPersistenceService } from './NotificationPersistenceService';
import type { ToolCall, CompactionEvent } from '../types/claudeSession';
import type { QuotaState } from 'sidekick-shared';
import {
  NotificationTriggerService,
  NOTIFICATION_BUTTONS,
  TRIGGER_BUTTONS,
} from './NotificationTriggerService';

const mocks = vi.hoisted(() => {
  const configUpdate = vi.fn((): Promise<void> => Promise.resolve());
  const settings = { notificationsEnabled: true, tokenThreshold: undefined as number | undefined };
  return {
    settings,
    configUpdate,
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === 'enabled') return settings.notificationsEnabled;
        if (key === 'tokenThreshold' && settings.tokenThreshold !== undefined) {
          return settings.tokenThreshold;
        }
        return defaultValue;
      }),
      update: configUpdate,
    })),
    showInformationMessage: vi.fn((): Promise<string | undefined> => Promise.resolve(undefined)),
    showWarningMessage: vi.fn((): Promise<string | undefined> => Promise.resolve(undefined)),
    showErrorMessage: vi.fn((): Promise<string | undefined> => Promise.resolve(undefined)),
    executeCommand: vi.fn((): Promise<undefined> => Promise.resolve(undefined)),
  };
});

// Mock vscode module
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: mocks.getConfiguration,
    onDidChangeConfiguration: vi.fn(() => ({ dispose: () => {} })),
    workspaceFolders: undefined,
  },
  window: {
    showInformationMessage: mocks.showInformationMessage,
    showWarningMessage: mocks.showWarningMessage,
    showErrorMessage: mocks.showErrorMessage,
  },
  commands: {
    executeCommand: mocks.executeCommand,
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}));

// Mock Logger
vi.mock('./Logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

// Extract the patterns from BUILT_IN_TRIGGERS for direct regex testing.
// These must stay in sync with the actual values in NotificationTriggerService.ts.
const DESTRUCTIVE_CMD_PATTERN =
  'rm\\s+-[a-zA-Z]*[rf]|git\\s+push\\s+(-f|--force)|git\\s+reset\\s+--hard|git\\s+clean\\s+-[a-zA-Z]*[fd]|drop\\s+(table|database)|chmod\\s+-R|chown\\s+-R|>\\s*/dev/(?!null|std(out|err)|fd/|tty)';
const ENV_ACCESS_PATTERN = '\\.(env|pem|key|secret|credentials)$|id_rsa|id_ed25519';
const SENSITIVE_PATH_PATTERN = '^/(etc|boot|usr/(s?bin|lib))|/\\.ssh/|/\\.gnupg/';

describe('NotificationTriggerService patterns', () => {
  describe('destructive-cmd pattern', () => {
    const regex = new RegExp(DESTRUCTIVE_CMD_PATTERN, 'i');

    describe('rm variants', () => {
      it('matches rm -rf', () => {
        expect(regex.test('rm -rf /tmp/project')).toBe(true);
      });

      it('matches rm -r (without -f)', () => {
        expect(regex.test('rm -r /tmp/test')).toBe(true);
      });

      it('matches rm -f (without -r)', () => {
        expect(regex.test('rm -f important.txt')).toBe(true);
      });

      it('matches rm -fr (reversed flags)', () => {
        expect(regex.test('rm -fr /home/user/project')).toBe(true);
      });

      it('matches rm -Rf (uppercase R)', () => {
        expect(regex.test('rm -Rf build/')).toBe(true);
      });

      it('matches rm with extra flags like -rfv', () => {
        expect(regex.test('rm -rfv /tmp/cache')).toBe(true);
      });

      it('does not match rm without dangerous flags', () => {
        expect(regex.test('rm file.txt')).toBe(false);
      });

      it('does not match words containing "rm"', () => {
        expect(regex.test('echo "format this"')).toBe(false);
      });
    });

    describe('git push variants', () => {
      it('matches git push --force', () => {
        expect(regex.test('git push --force origin main')).toBe(true);
      });

      it('matches git push -f (short flag)', () => {
        expect(regex.test('git push -f origin main')).toBe(true);
      });

      it('does not match regular git push', () => {
        expect(regex.test('git push origin main')).toBe(false);
      });
    });

    describe('git reset', () => {
      it('matches git reset --hard', () => {
        expect(regex.test('git reset --hard HEAD~1')).toBe(true);
      });

      it('does not match git reset --soft', () => {
        expect(regex.test('git reset --soft HEAD~1')).toBe(false);
      });
    });

    describe('git clean variants', () => {
      it('matches git clean -fd', () => {
        expect(regex.test('git clean -fd')).toBe(true);
      });

      it('matches git clean -f', () => {
        expect(regex.test('git clean -f')).toBe(true);
      });

      it('matches git clean -fdx', () => {
        expect(regex.test('git clean -fdx')).toBe(true);
      });

      it('does not match git clean -n (dry run)', () => {
        expect(regex.test('git clean -n')).toBe(false);
      });
    });

    describe('SQL drops', () => {
      it('matches drop table', () => {
        expect(regex.test('DROP TABLE users')).toBe(true);
      });

      it('matches drop database', () => {
        expect(regex.test('drop database production')).toBe(true);
      });
    });

    describe('permission changes', () => {
      it('matches chmod -R', () => {
        expect(regex.test('chmod -R 777 /var/www')).toBe(true);
      });

      it('matches chown -R', () => {
        expect(regex.test('chown -R root:root /etc/app')).toBe(true);
      });

      it('does not match chmod without -R', () => {
        expect(regex.test('chmod 644 file.txt')).toBe(false);
      });
    });

    describe('device file redirect', () => {
      it('matches redirect to /dev/sda', () => {
        expect(regex.test('dd if=image.iso > /dev/sda')).toBe(true);
      });

      it('does not match redirect to /dev/null', () => {
        expect(regex.test('cat data > /dev/null')).toBe(false);
      });

      it('does not match stderr redirect to /dev/null', () => {
        expect(regex.test('ls -la 2> /dev/null')).toBe(false);
      });

      it('does not match redirect to /dev/stdout', () => {
        expect(regex.test('echo test > /dev/stdout')).toBe(false);
      });

      it('does not match redirect to /dev/stderr', () => {
        expect(regex.test('echo error > /dev/stderr')).toBe(false);
      });
    });

    describe('false positives', () => {
      it('does not match echo command', () => {
        expect(regex.test('echo "hello world"')).toBe(false);
      });

      it('does not match ls command', () => {
        expect(regex.test('ls -la /tmp')).toBe(false);
      });

      it('does not match npm install', () => {
        expect(regex.test('npm install express')).toBe(false);
      });

      it('does not match git status', () => {
        expect(regex.test('git status')).toBe(false);
      });

      it('does not match git commit', () => {
        expect(regex.test('git commit -m "fix: something"')).toBe(false);
      });

      it('does not match mkdir -p', () => {
        expect(regex.test('mkdir -p /tmp/test')).toBe(false);
      });

      it('does not match ls with output suppression', () => {
        expect(regex.test('ls > /dev/null')).toBe(false);
      });

      it('does not match command with stderr suppression', () => {
        expect(regex.test('ls -la 2>/dev/null')).toBe(false);
      });
    });
  });

  describe('env-access pattern', () => {
    const regex = new RegExp(ENV_ACCESS_PATTERN, 'i');

    it('matches .env file', () => {
      expect(regex.test('/project/.env')).toBe(true);
    });

    it('matches .pem file', () => {
      expect(regex.test('/certs/server.pem')).toBe(true);
    });

    it('matches .key file', () => {
      expect(regex.test('/ssl/private.key')).toBe(true);
    });

    it('matches id_rsa', () => {
      expect(regex.test('/home/user/.ssh/id_rsa')).toBe(true);
    });

    it('matches id_ed25519', () => {
      expect(regex.test('/home/user/.ssh/id_ed25519')).toBe(true);
    });

    it('does not match .ts file', () => {
      expect(regex.test('/src/index.ts')).toBe(false);
    });
  });

  describe('sensitive-path-write pattern', () => {
    const regex = new RegExp(SENSITIVE_PATH_PATTERN, 'i');

    it('matches /etc/ paths', () => {
      expect(regex.test('/etc/hosts')).toBe(true);
    });

    it('matches /etc/nginx/ paths', () => {
      expect(regex.test('/etc/nginx/nginx.conf')).toBe(true);
    });

    it('matches /boot/ paths', () => {
      expect(regex.test('/boot/grub/grub.cfg')).toBe(true);
    });

    it('matches /usr/bin/ paths', () => {
      expect(regex.test('/usr/bin/python3')).toBe(true);
    });

    it('matches /usr/sbin/ paths', () => {
      expect(regex.test('/usr/sbin/nginx')).toBe(true);
    });

    it('matches /usr/lib/ paths', () => {
      expect(regex.test('/usr/lib/systemd/system/app.service')).toBe(true);
    });

    it('matches .ssh directory paths', () => {
      expect(regex.test('/home/user/.ssh/config')).toBe(true);
    });

    it('matches .gnupg directory paths', () => {
      expect(regex.test('/home/user/.gnupg/pubring.kbx')).toBe(true);
    });

    it('does not match /home/user/project/', () => {
      expect(regex.test('/home/user/project/src/main.ts')).toBe(false);
    });

    it('does not match /tmp/ paths', () => {
      expect(regex.test('/tmp/build/output.js')).toBe(false);
    });

    it('does not match /var/log/ paths', () => {
      expect(regex.test('/var/log/app.log')).toBe(false);
    });
  });

  describe('description field in notification body', () => {
    it('uses description when present', () => {
      const description = 'Delete all project files recursively';
      const command = 'rm -rf /tmp/project';
      const body = description
        ? `${description} (${command.substring(0, 60)})`
        : `Command: ${command.substring(0, 80)}`;
      expect(body).toBe('Delete all project files recursively (rm -rf /tmp/project)');
    });

    it('falls back to Command: format without description', () => {
      const description = undefined;
      const command = 'rm -rf /tmp/project';
      const body = description
        ? `${description} (${command.substring(0, 60)})`
        : `Command: ${command.substring(0, 80)}`;
      expect(body).toBe('Command: rm -rf /tmp/project');
    });

    it('truncates long commands in description format', () => {
      const description = 'Clean build artifacts';
      const command = 'rm -rf ' + 'a'.repeat(100);
      const body = `${description} (${command.substring(0, 60)})`;
      expect(body.length).toBeLessThan(description.length + 65);
    });
  });
});

describe('trigger action buttons', () => {
  const { openDashboard, snooze, mute } = NOTIFICATION_BUTTONS;

  it('covers every built-in and synthetic trigger id', () => {
    expect(Object.keys(TRIGGER_BUTTONS).sort()).toEqual(
      [
        'env-access',
        'destructive-cmd',
        'sensitive-path-write',
        'tool-error',
        'compaction',
        'cycle-detected',
        'high-token-usage',
        'quota-threshold',
      ].sort(),
    );
  });

  it('gives security triggers Open Dashboard + Mute', () => {
    for (const id of ['env-access', 'destructive-cmd', 'sensitive-path-write']) {
      expect(TRIGGER_BUTTONS[id]).toEqual([openDashboard, mute]);
    }
  });

  it('never offers Snooze on a security trigger', () => {
    for (const id of ['env-access', 'destructive-cmd', 'sensitive-path-write']) {
      expect(TRIGGER_BUTTONS[id]).not.toContain(snooze);
    }
  });

  it('gives noisy triggers Snooze + Mute', () => {
    for (const id of ['tool-error', 'compaction', 'cycle-detected']) {
      expect(TRIGGER_BUTTONS[id]).toEqual([snooze, mute]);
    }
  });

  it('gives high-token-usage Open Dashboard + Snooze but never Mute', () => {
    expect(TRIGGER_BUTTONS['high-token-usage']).toEqual([openDashboard, snooze]);
    expect(TRIGGER_BUTTONS['high-token-usage']).not.toContain(mute);
  });

  it('has no entry for unknown trigger ids (callers fall back to no buttons)', () => {
    expect(TRIGGER_BUTTONS['some-future-trigger']).toBeUndefined();
  });
});

interface CapturedHandlers {
  toolCall?: (call: ToolCall) => void;
  compaction?: (event: CompactionEvent) => void;
  tokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  cycleDetected?: (cycle: { description: string; affectedFiles: string[] }) => void;
  quotaUpdate?: (quota: QuotaState) => void;
  sessionStart?: (sessionPath: string) => void;
}

function createFakeSessionMonitor(totalTokens = 0): {
  monitor: SessionMonitor;
  handlers: CapturedHandlers;
  setTotalTokens: (total: number) => void;
} {
  const handlers: CapturedHandlers = {};
  const disposable = { dispose: () => {} };
  let total = totalTokens;
  const monitor = {
    isReplaying: false,
    onSessionStart: (h: (sessionPath: string) => void) => {
      handlers.sessionStart = h;
      return disposable;
    },
    onToolCall: (h: (call: ToolCall) => void) => {
      handlers.toolCall = h;
      return disposable;
    },
    onCompaction: (h: (event: CompactionEvent) => void) => {
      handlers.compaction = h;
      return disposable;
    },
    onTokenUsage: (h: (usage: { inputTokens: number; outputTokens: number }) => void) => {
      handlers.tokenUsage = h;
      return disposable;
    },
    onCycleDetected: (h: (cycle: { description: string; affectedFiles: string[] }) => void) => {
      handlers.cycleDetected = h;
      return disposable;
    },
    onQuotaUpdate: (h: (quota: QuotaState) => void) => {
      handlers.quotaUpdate = h;
      return disposable;
    },
    getStats: () => ({ totalInputTokens: total, totalOutputTokens: 0 }),
    getStatsView: () => ({ totalInputTokens: total, totalOutputTokens: 0 }),
  };
  return {
    monitor: monitor as unknown as SessionMonitor,
    handlers,
    setTotalTokens: (next: number) => {
      total = next;
    },
  };
}

describe('high-token-usage alert', () => {
  const usage = { inputTokens: 1, outputTokens: 1 };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.notificationsEnabled = true;
    mocks.settings.tokenThreshold = undefined;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('warns once when the cache-inclusive total first crosses the threshold', () => {
    const { monitor, handlers, setTotalTokens } = createFakeSessionMonitor();
    const service = new NotificationTriggerService(monitor);

    setTotalTokens(4_900_000);
    handlers.tokenUsage!(usage);
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();

    setTotalTokens(5_100_000);
    handlers.tokenUsage!(usage);
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'High Token Usage: Session has consumed 5100K tokens',
      NOTIFICATION_BUTTONS.openDashboard,
      NOTIFICATION_BUTTONS.snooze,
    );

    // Every later step keeps growing the total; none of them warn again.
    for (const total of [5_400_000, 6_000_000, 9_900_000]) {
      setTotalTokens(total);
      handlers.tokenUsage!(usage);
    }
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it('warns for later multiples at most every thirty minutes', () => {
    const { monitor, handlers, setTotalTokens } = createFakeSessionMonitor();
    const service = new NotificationTriggerService(monitor);

    setTotalTokens(5_100_000);
    handlers.tokenUsage!(usage);
    setTotalTokens(10_200_000);
    handlers.tokenUsage!(usage);
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(29 * 60 * 1000);
    handlers.tokenUsage!(usage);
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * 60 * 1000);
    handlers.tokenUsage!(usage);
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(mocks.showWarningMessage).toHaveBeenLastCalledWith(
      'High Token Usage: Session has consumed 10200K tokens',
      NOTIFICATION_BUTTONS.openDashboard,
      NOTIFICATION_BUTTONS.snooze,
    );

    service.dispose();
  });

  it('starts a new session from a clean slate, ignoring the previous high-water mark', () => {
    const { monitor, handlers, setTotalTokens } = createFakeSessionMonitor();
    const service = new NotificationTriggerService(monitor);

    setTotalTokens(5_100_000);
    handlers.tokenUsage!(usage);
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);

    handlers.sessionStart!('/sessions/next.jsonl');
    setTotalTokens(200_000);
    handlers.tokenUsage!(usage);
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);

    // Within the old throttle window, but this is the new session's first crossing.
    setTotalTokens(5_050_000);
    handlers.tokenUsage!(usage);
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(2);

    // Re-announcing the same session does not reset anything.
    handlers.sessionStart!('/sessions/next.jsonl');
    setTotalTokens(5_900_000);
    handlers.tokenUsage!(usage);
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  it('stays silent during replay, when disabled, and when the threshold is zero', () => {
    const { monitor, handlers, setTotalTokens } = createFakeSessionMonitor();
    const service = new NotificationTriggerService(monitor);
    setTotalTokens(5_100_000);

    (monitor as unknown as { isReplaying: boolean }).isReplaying = true;
    handlers.tokenUsage!(usage);
    (monitor as unknown as { isReplaying: boolean }).isReplaying = false;
    mocks.settings.notificationsEnabled = false;
    handlers.tokenUsage!(usage);
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    service.dispose();

    mocks.settings.notificationsEnabled = true;
    mocks.settings.tokenThreshold = 0;
    const disabledFake = createFakeSessionMonitor(5_100_000);
    const disabled = new NotificationTriggerService(disabledFake.monitor);
    // The service subscribed to this monitor, so its handler is the one under test.
    expect(disabledFake.handlers.tokenUsage).toBeDefined();
    disabledFake.handlers.tokenUsage!(usage);
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    disabled.dispose();
  });
});

function createFakePersistence(): NotificationPersistenceService {
  return { addNotification: vi.fn() } as unknown as NotificationPersistenceService;
}

function envAccessCall(): ToolCall {
  return {
    name: 'Read',
    input: { file_path: '/project/.env' },
    timestamp: new Date(),
    isError: false,
  };
}

/** Flush pending microtasks so notification .then handlers run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('notification action handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.notificationsEnabled = true;
  });

  it('shows the per-trigger buttons on the notification', () => {
    const { monitor, handlers } = createFakeSessionMonitor();
    const service = new NotificationTriggerService(monitor);

    handlers.toolCall!(envAccessCall());

    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('.env'),
      NOTIFICATION_BUTTONS.openDashboard,
      NOTIFICATION_BUTTONS.mute,
    );

    service.dispose();
  });

  it('shows no buttons for a trigger id without a TRIGGER_BUTTONS entry', () => {
    const { monitor } = createFakeSessionMonitor();
    const service = new NotificationTriggerService(monitor);

    (
      service as unknown as {
        fireNotification: (
          title: string,
          body: string,
          severity: 'info' | 'warning' | 'error',
          persistParams?: { triggerId: string; triggerName: string },
        ) => void;
      }
    ).fireNotification('Sidekick', 'something new', 'info', {
      triggerId: 'some-future-trigger',
      triggerName: 'Some Future Trigger',
    });

    expect(mocks.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(mocks.showInformationMessage).toHaveBeenCalledWith('Sidekick: something new');

    service.dispose();
  });

  it('Open Dashboard runs the sidekick.openDashboard command', async () => {
    mocks.showWarningMessage.mockResolvedValueOnce(NOTIFICATION_BUTTONS.openDashboard);
    const { monitor, handlers } = createFakeSessionMonitor();
    const service = new NotificationTriggerService(monitor);

    handlers.toolCall!(envAccessCall());
    await flush();

    expect(mocks.executeCommand).toHaveBeenCalledWith('sidekick.openDashboard');

    service.dispose();
  });

  it('Snooze 1h suppresses subsequent fires of the trigger but keeps history', async () => {
    mocks.showWarningMessage.mockResolvedValueOnce(NOTIFICATION_BUTTONS.snooze);
    const { monitor, handlers } = createFakeSessionMonitor();
    const persistence = createFakePersistence();
    const service = new NotificationTriggerService(monitor, persistence);

    handlers.cycleDetected!({ description: 'repeating edits', affectedFiles: ['/a/b.ts'] });
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('repeating edits'),
      NOTIFICATION_BUTTONS.snooze,
      NOTIFICATION_BUTTONS.mute,
    );
    await flush();

    handlers.cycleDetected!({ description: 'repeating edits', affectedFiles: ['/a/b.ts'] });
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);

    // Both fires are persisted; the snoozed one is recorded as throttled
    expect(persistence.addNotification).toHaveBeenCalledTimes(2);
    expect(persistence.addNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ triggerId: 'cycle-detected', wasThrottled: true }),
    );

    service.dispose();
  });

  it('Mute This Trigger disables the trigger in configuration', async () => {
    mocks.showWarningMessage.mockResolvedValueOnce(NOTIFICATION_BUTTONS.mute);
    const { monitor, handlers } = createFakeSessionMonitor();
    const service = new NotificationTriggerService(monitor);

    handlers.cycleDetected!({ description: 'repeating edits', affectedFiles: [] });
    await flush();

    expect(mocks.getConfiguration).toHaveBeenCalledWith('sidekick.notifications');
    // No workspaceFolders in the mock, so the write targets Global (1)
    expect(mocks.configUpdate).toHaveBeenCalledWith('triggers.cycle-detected', false, 1);

    service.dispose();
  });

  it('ignores button clicks that resolve after dispose()', async () => {
    let resolveSelection: (value: string | undefined) => void = () => {};
    mocks.showWarningMessage.mockReturnValueOnce(
      new Promise<string | undefined>((resolve) => {
        resolveSelection = resolve;
      }),
    );
    const { monitor, handlers } = createFakeSessionMonitor();
    const service = new NotificationTriggerService(monitor);

    handlers.toolCall!(envAccessCall());
    service.dispose();
    resolveSelection(NOTIFICATION_BUTTONS.openDashboard);
    await flush();

    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('announces quota threshold crossings once per threshold per reset window', () => {
    const { monitor, handlers } = createFakeSessionMonitor();
    const service = new NotificationTriggerService(monitor);
    const sample = (fiveHour: number): QuotaState => ({
      fiveHour: { utilization: fiveHour, resetsAt: '2026-07-18T16:00:00.000Z' },
      sevenDay: { utilization: 10, resetsAt: '2026-07-21T00:00:00.000Z' },
      available: true,
      providerId: 'claude-code',
    });

    handlers.quotaUpdate!(sample(50));
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();

    handlers.quotaUpdate!(sample(82));
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);
    expect((mocks.showWarningMessage.mock.calls[0] as unknown as [string])[0]).toContain(
      'Claude five-hour window at 82%',
    );

    // Still above 80 in the same window: no repeat.
    handlers.quotaUpdate!(sample(88));
    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);

    // The highest threshold escalates to an error.
    handlers.quotaUpdate!(sample(96));
    expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    expect((mocks.showErrorMessage.mock.calls[0] as unknown as [string])[0]).toContain('at 96%');
    service.dispose();
  });

  it('also listens to an injected quota source', () => {
    const { monitor } = createFakeSessionMonitor();
    let emit: ((quota: QuotaState) => void) | undefined;
    const source = {
      onQuotaUpdate: (h: (quota: QuotaState) => void) => {
        emit = h;
        return { dispose: () => {} };
      },
    };
    const service = new NotificationTriggerService(monitor, undefined, source);
    emit!({
      fiveHour: { utilization: 5, resetsAt: '' },
      sevenDay: { utilization: 91, resetsAt: '' },
      available: true,
    });
    expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    expect((mocks.showErrorMessage.mock.calls[0] as unknown as [string])[0]).toContain(
      'seven-day window at 91%',
    );
    service.dispose();
  });

  it('honors the master notification toggle for cycle and token events', () => {
    mocks.settings.notificationsEnabled = false;
    const { monitor, handlers } = createFakeSessionMonitor(600_000);
    const service = new NotificationTriggerService(monitor);

    handlers.cycleDetected!({ description: 'repeating edits', affectedFiles: ['/a/b.ts'] });
    handlers.tokenUsage!({ inputTokens: 600_000, outputTokens: 0 });

    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    service.dispose();
  });
});
