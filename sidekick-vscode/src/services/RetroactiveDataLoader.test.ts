import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let temporaryHome: string;

vi.mock('vscode', () => ({}));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => temporaryHome };
});
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { RetroactiveDataLoader } from './RetroactiveDataLoader';

describe('RetroactiveDataLoader', () => {
  beforeEach(() => {
    temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-retro-test-'));
  });

  afterEach(() => fs.rmSync(temporaryHome, { recursive: true, force: true }));

  it('skips live-saved session IDs and recently modified session files', async () => {
    const projectDir = path.join(temporaryHome, '.claude', 'projects', 'workspace');
    fs.mkdirSync(projectDir, { recursive: true });
    const savedPath = path.join(projectDir, 'saved-session.jsonl');
    const activePath = path.join(projectDir, 'active-session.jsonl');
    fs.writeFileSync(savedPath, '{}\n');
    fs.writeFileSync(activePath, '{}\n');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(savedPath, old, old);

    const historical = {
      getImportedFiles: vi.fn(() => []),
      getSessionRecords: vi.fn(() => [{ sessionId: 'saved-session' }]),
      saveSessionSummary: vi.fn(),
      markFileImported: vi.fn(),
      forceSave: vi.fn(async () => undefined),
    };
    const loader = new RetroactiveDataLoader(historical as never);

    const result = await loader.loadHistoricalData();

    expect(result).toMatchObject({ filesProcessed: 0, filesSkipped: 2, sessionsCreated: 0 });
    expect(historical.saveSessionSummary).not.toHaveBeenCalled();
    expect(historical.markFileImported).not.toHaveBeenCalled();
  });
});
