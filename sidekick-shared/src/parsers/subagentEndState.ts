/**
 * Whether a Claude Code subagent transcript ended cleanly, read line by line.
 *
 * Clean means: the last user or assistant line is an assistant line that
 * stopped with `end_turn` or `stop_sequence`, and every `tool_use` in the
 * transcript has its `tool_result`. A user line after that (a resumed agent's
 * new prompt) makes it unfinished again.
 *
 * Pure. Internal to the subagent parsers.
 *
 * @module parsers/subagentEndState
 */

const ENDED_STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence']);

/** Bounds the unanswered-call set for pathological transcripts. */
const MAX_PENDING_TOOL_USES = 4096;

export class SubagentEndTracker {
  private readonly unanswered = new Set<string>();
  private lastWasCleanAssistant = false;

  /** Feeds one parsed JSONL line, in file order. */
  observe(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const line = raw as { type?: unknown; message?: unknown };
    if (line.type !== 'assistant' && line.type !== 'user') return;
    const message =
      line.message && typeof line.message === 'object'
        ? (line.message as { content?: unknown; stop_reason?: unknown })
        : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];

    if (line.type === 'user') {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const typed = block as { type?: unknown; tool_use_id?: unknown };
        if (typed.type === 'tool_result' && typeof typed.tool_use_id === 'string') {
          this.unanswered.delete(typed.tool_use_id);
        }
      }
      this.lastWasCleanAssistant = false;
      return;
    }

    let callsTool = false;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as { type?: unknown; id?: unknown };
      if (typed.type !== 'tool_use') continue;
      callsTool = true;
      if (typeof typed.id === 'string' && this.unanswered.size < MAX_PENDING_TOOL_USES) {
        this.unanswered.add(typed.id);
      }
    }
    const stop = typeof message?.stop_reason === 'string' ? message.stop_reason : '';
    this.lastWasCleanAssistant = !callsTool && ENDED_STOP_REASONS.has(stop);
  }

  /** Whether the lines so far end cleanly. */
  endedCleanly(): boolean {
    return this.lastWasCleanAssistant && this.unanswered.size === 0;
  }
}
