/**
 * The 0.32 event-model additions: hook and memory activity signals, kept
 * permission decisions, agent ids and compaction counts, and the helpers
 * the activity map relies on.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventAggregator } from './aggregation/EventAggregator';
import {
  describeHookActivity,
  hookActivityFromAttachment,
  hookActivityFromEvent,
  hookProgramName,
  isHookActivitySystemEvent,
} from './hookActivity';
import { isInjectedPromptText } from './humanPrompt';
import {
  describeMemoryAttachment,
  isMemoryAttachmentSystemEvent,
  memoryAttachmentFromAttachment,
  memoryAttachmentFromEvent,
} from './memoryAttachment';
import { openCodeRefusalSource } from './parsers/openCodeParser';
import { ClaudeCodeProvider } from './providers/claudeCode';
import { readSessionReportInputs } from './report/sessionReportInputs';
import { extractSessionEvents } from './schemas/sessionEvent';
import { parseSpawnResultAgentId } from './subagentSpawn';
import { classifyTool } from './toolCategory';
import { projectSessionTranscript } from './transcript';
import { toFollowEvents } from './watchers/eventBridge';

const at = '2026-11-01T10:00:00.000Z';

function attachment(body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: 'attachment', timestamp: at, entrypoint: 'cli', attachment: body, ...extra };
}

describe('hook activity', () => {
  it('reads a successful tool hook without keeping its command or output', () => {
    const activity = hookActivityFromAttachment(
      attachment({
        type: 'hook_success',
        hookName: 'PreToolUse:Bash',
        hookEvent: 'PreToolUse',
        toolUseID: 'toolu_1',
        exitCode: 0,
        durationMs: 120,
        command: 'bash "$ROOT/hooks/guard.sh" --secret',
        stdout: 'SKCANARY',
        stderr: 'SKCANARY',
        content: '',
      }),
    );
    expect(activity).toEqual({
      attachment: 'hook_success',
      hookEvent: 'PreToolUse',
      outcome: 'ok',
      matcher: 'Bash',
      toolUseId: 'toolu_1',
      exitCode: 0,
      durationMs: 120,
      program: 'guard',
    });
  });

  it('reads a JSON deny as blocked and added context as context', () => {
    expect(
      hookActivityFromAttachment(
        attachment({
          type: 'hook_success',
          hookName: 'PreToolUse:Bash',
          hookEvent: 'PreToolUse',
          toolUseID: 't',
          stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } }),
        }),
      )?.outcome,
    ).toBe('blocked');
    expect(
      hookActivityFromAttachment(
        attachment({
          type: 'hook_additional_context',
          hookName: 'SessionStart',
          hookEvent: 'SessionStart',
          toolUseID: 'SessionStart',
          content: ['abc', 'de'],
        }),
      ),
    ).toEqual({
      attachment: 'hook_additional_context',
      hookEvent: 'SessionStart',
      outcome: 'context',
      contentChars: 5,
    });
  });

  it('reads errors and blocking errors', () => {
    expect(
      hookActivityFromAttachment(
        attachment({
          type: 'hook_non_blocking_error',
          hookName: 'PostToolUse:Bash',
          hookEvent: 'PostToolUse',
          exitCode: 1,
        }),
      )?.outcome,
    ).toBe('error');
    expect(
      hookActivityFromAttachment(
        attachment({ type: 'hook_blocking_error', hookName: 'Stop', hookEvent: 'Stop' }),
      )?.outcome,
    ).toBe('blocked');
  });

  it('keeps the tool call only for tool hooks', () => {
    expect(
      hookActivityFromAttachment(
        attachment({
          type: 'hook_success',
          hookName: 'SessionStart:startup',
          hookEvent: 'SessionStart',
          toolUseID: 'abc',
        }),
      ),
    ).not.toHaveProperty('toolUseId');
  });

  it('names a hook program by its script', () => {
    expect(hookProgramName('node --no-warnings /opt/hooks/policy.js')).toBe('policy');
    expect(hookProgramName('uv run hooks/check_style.py')).toBe('check_style');
    expect(hookProgramName('my-hook')).toBe('my-hook');
    expect(hookProgramName('')).toBeUndefined();
  });

  it('becomes a content-free system event only with includeActivitySignals', () => {
    const raw = attachment(
      {
        type: 'hook_success',
        hookName: 'PreToolUse:Edit',
        hookEvent: 'PreToolUse',
        toolUseID: 'toolu_9',
        durationMs: 650,
        stdout: 'SKCANARY',
        command: 'SKCANARY',
      },
      { agentId: 'agent1', isSidechain: true },
    );
    expect(extractSessionEvents(raw)).toEqual([]);
    const [event] = extractSessionEvents(raw, { includeActivitySignals: true });
    expect(isHookActivitySystemEvent(event)).toBe(true);
    expect(event.agentId).toBe('agent1');
    expect(JSON.stringify(event)).not.toContain('SKCANARY');
    expect(hookActivityFromEvent(event)).toMatchObject({
      hookEvent: 'PreToolUse',
      toolUseId: 'toolu_9',
      durationMs: 650,
    });
    expect(describeHookActivity(hookActivityFromEvent(event)!)).toBe('PreToolUse hook (Edit) ran');
  });
});

describe('memory attachments', () => {
  const raw = attachment({
    type: 'nested_memory',
    path: '/work/demo/src/CLAUDE.md',
    displayPath: 'src/CLAUDE.md',
    content: { path: '/work/demo/src/CLAUDE.md', type: 'Project', content: 'SKCANARY text' },
  });

  it('keeps the path and size, never the text', () => {
    expect(memoryAttachmentFromAttachment(raw)).toEqual({
      attachment: 'nested_memory',
      path: '/work/demo/src/CLAUDE.md',
      displayPath: 'src/CLAUDE.md',
      chars: 13,
    });
    const [event] = extractSessionEvents(raw, { includeActivitySignals: true });
    expect(isMemoryAttachmentSystemEvent(event)).toBe(true);
    expect(JSON.stringify(event)).not.toContain('SKCANARY');
    expect(memoryAttachmentFromEvent(event)).toMatchObject({
      path: '/work/demo/src/CLAUDE.md',
      chars: 13,
    });
    expect(describeMemoryAttachment(memoryAttachmentFromEvent(event)!)).toBe(
      'Memory loaded: src/CLAUDE.md',
    );
  });
});

describe('kept event fields', () => {
  it('keeps permissionDecision (three fields only) and agentId on Claude lines', () => {
    const [event] = extractSessionEvents({
      type: 'user',
      timestamp: at,
      agentId: 'a1',
      permissionDecision: {
        decision: 'reject',
        source: 'user_reject',
        reasonCode: 'x',
        grantScope: 'once',
      },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'no' }],
      },
    });
    expect(event.agentId).toBe('a1');
    expect(event.permissionDecision).toEqual({ decision: 'reject', source: 'user_reject' });
  });

  it('drops a malformed permissionDecision instead of the line', () => {
    const events = extractSessionEvents({
      type: 'user',
      timestamp: at,
      permissionDecision: 'yes',
      message: { role: 'user', content: 'hi' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].permissionDecision).toBeUndefined();
  });

  it('copies compact_boundary counts into compaction, only when both are present', () => {
    const [full] = extractSessionEvents({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: at,
      compactMetadata: { trigger: 'auto', preTokens: 300000, postTokens: 25000, durationMs: 1 },
    });
    expect(full.compaction).toEqual({ tokensBefore: 300000, tokensAfter: 25000, trigger: 'auto' });
    const [partial] = extractSessionEvents({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: at,
      compactMetadata: { trigger: 'auto', preTokens: 300000 },
    });
    expect(partial.compaction).toBeUndefined();
  });

  it('keeps the aggregator, transcripts and follow events off the new system events', () => {
    const events = extractSessionEvents(
      attachment({ type: 'hook_success', hookName: 'Stop', hookEvent: 'Stop', durationMs: 3 }),
      { includeActivitySignals: true },
    );
    const aggregator = new EventAggregator({ providerId: 'claude-code' });
    for (const event of events) aggregator.processEvent(event);
    expect(aggregator.getMetrics().eventCount).toBe(0);
    expect(projectSessionTranscript(events).messages).toEqual([]);
    expect(toFollowEvents(events[0], 'claude-code')).toEqual([
      expect.objectContaining({ type: 'system', summary: 'Stop hook ran' }),
    ]);
  });
});

describe('helpers', () => {
  it('parseSpawnResultAgentId reads the agent id of any spawn result', () => {
    expect(parseSpawnResultAgentId('report\nagentId: a1b2c3 (internal)')).toBe('a1b2c3');
    expect(parseSpawnResultAgentId([{ type: 'text', text: 'agentId: bg-1' }])).toBe('bg-1');
    expect(parseSpawnResultAgentId('nothing here')).toBeNull();
  });

  it('isInjectedPromptText tells harness text from typed text', () => {
    expect(isInjectedPromptText('<system-reminder>x', 'claude-code')).toBe(true);
    expect(isInjectedPromptText('fix the bug', 'claude-code')).toBe(false);
    expect(isInjectedPromptText('# AGENTS.md instructions for /w', 'codex')).toBe(true);
    expect(isInjectedPromptText('<environment_context>', 'codex')).toBe(true);
  });

  it('openCodeRefusalSource uses OpenCode’s own denial wording', () => {
    expect(openCodeRefusalSource('The user rejected permission to use this tool')).toBe(
      'user_reject',
    );
    expect(openCodeRefusalSource('QuestionRejectedError: dismissed')).toBe('user_reject');
    expect(openCodeRefusalSource('The user has specified a rule which prevents this')).toBe(
      'config',
    );
    expect(openCodeRefusalSource('ENOENT: no such file')).toBeUndefined();
  });

  it('classifyTool knows the 0.32 names', () => {
    expect(classifyTool('ApplyPatch')).toBe('file_edit');
    expect(classifyTool('Subtask')).toBe('subagent');
    expect(classifyTool('Lsp')).toBe('search');
    expect(classifyTool('TaskGet')).toBe('planning');
  });
});

describe('readSessionReportInputs', () => {
  it('includes the activity map at the last event', () => {
    const sessionPath = path.join(
      __dirname,
      'fixtures',
      'activity',
      'claude-code',
      'sess-activity.jsonl',
    );
    const inputs = readSessionReportInputs(new ClaudeCodeProvider(), sessionPath);
    expect(inputs.activity.snapshot.totals.calls).toBeGreaterThan(10);
    expect(inputs.activity.insights.totals.hookRuns).toBe(3);
    expect(inputs.activity.snapshot.sessionId).toBe('sess-activity');
    // Hook and memory events stay out of the transcript.
    expect(JSON.stringify(inputs.transcript)).not.toContain('hook_activity');
  });
});
