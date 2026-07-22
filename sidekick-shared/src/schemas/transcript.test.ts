import { describe, expect, it } from 'vitest';
import { projectSessionTranscript } from '../transcript';
import { canonicalSessionTranscriptSchema, transcriptSourceProvenanceSchema } from './transcript';

describe('canonical transcript schemas', () => {
  it('validates provider and session provenance fields', () => {
    const transcript = projectSessionTranscript([
      {
        type: 'user',
        timestamp: '2026-07-22T00:00:00Z',
        entrypoint: 'cli',
        isMeta: false,
        isSidechain: false,
        cwd: '/workspace/app',
        gitBranch: 'main',
        message: { role: 'user', content: 'hello' },
      },
    ]);

    expect(canonicalSessionTranscriptSchema.parse(transcript)).toMatchObject({
      cwd: '/workspace/app',
      gitBranch: 'main',
      messages: [
        {
          source: {
            entrypoint: 'cli',
            isMeta: false,
            isSidechain: false,
            originalRole: 'user',
          },
        },
      ],
    });
    expect(transcriptSourceProvenanceSchema.safeParse(transcript.messages[0].source).success).toBe(
      true,
    );
  });
});
