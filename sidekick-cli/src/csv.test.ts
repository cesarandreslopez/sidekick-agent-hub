import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv', () => {
  it('writes a header and quotes only cells that need it', () => {
    const csv = toCsv(
      [
        { name: 'plain', note: 'has, comma', n: 1.5 },
        { name: 'quote "q"', note: 'line\nbreak', n: null },
      ],
      [
        { header: 'name', value: (row) => row.name },
        { header: 'note', value: (row) => row.note },
        { header: 'n', value: (row) => row.n },
      ],
    );
    expect(csv).toBe('name,note,n\nplain,"has, comma",1.5\n"quote ""q""","line\nbreak",\n');
  });

  it('renders non-finite numbers as empty cells', () => {
    expect(toCsv([{ v: Number.NaN }], [{ header: 'v', value: (row) => row.v }])).toBe('v\n\n');
  });
});
