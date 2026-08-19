/**
 * Tests for the --help examples blocks.
 */

import { describe, it, expect } from 'vitest';
import {
  DUMP_EXAMPLES,
  EXTRACT_EXAMPLES,
  HISTORY_EXAMPLES,
  QUOTA_EXAMPLES,
  ROOT_EXAMPLES,
} from './help';

const BLOCKS = { ROOT_EXAMPLES, QUOTA_EXAMPLES, EXTRACT_EXAMPLES, DUMP_EXAMPLES, HISTORY_EXAMPLES };

describe('help examples', () => {
  it('every example line is an indented real invocation', () => {
    for (const [name, block] of Object.entries(BLOCKS)) {
      const lines = block.split('\n').filter((l) => l.trim() && l.trim() !== 'Examples:');
      expect(lines.length, `${name} has no examples`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, `${name}: ${line}`).toMatch(/^ {2}\$ sidekick /);
      }
    }
  });

  it('the root block showcases the headline surface area', () => {
    for (const needle of [
      'dashboard',
      'quota --all',
      'quota history',
      'search',
      'extract -i',
      'handoff',
      // Distinguish the prompt-history command from `quota history` above.
      '$ sidekick history',
      'dump --list',
      '--json',
    ]) {
      expect(ROOT_EXAMPLES).toContain(needle);
    }
  });
});
