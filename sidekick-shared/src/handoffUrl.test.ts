import { describe, expect, it } from 'vitest';
import { renderHandoffUrlTemplate } from './handoffUrl';

describe('renderHandoffUrlTemplate', () => {
  it('renders only URL-encoded identifiers', () => {
    expect(
      renderHandoffUrlTemplate(
        'sidekick-consumer://handoff?session={sessionId}&provider={provider}&project={projectPath}',
        { sessionId: 'session/1', provider: 'codex', projectPath: '/tmp/my project' },
      ),
    ).toContain('session=session%2F1&provider=codex&project=%2Ftmp%2Fmy%20project');
  });

  it('rejects unknown fields and unsafe protocols', () => {
    expect(() =>
      renderHandoffUrlTemplate('https://example.com/?transcript={transcript}', {
        sessionId: 's',
        provider: 'codex',
        projectPath: '/tmp',
      }),
    ).toThrow('Unsupported');
    expect(() =>
      renderHandoffUrlTemplate('javascript:alert({sessionId})', {
        sessionId: 's',
        provider: 'codex',
        projectPath: '/tmp',
      }),
    ).toThrow('Unsafe');
  });
});
