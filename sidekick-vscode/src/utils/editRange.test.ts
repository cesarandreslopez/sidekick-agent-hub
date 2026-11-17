import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ Range: class {} }));

import { relocateInsertLine } from './editRange';

function doc(text: string, version: number) {
  const lines = text.split('\n');
  return { version, lineCount: lines.length, lineAt: (i: number) => ({ text: lines[i] }) };
}

const SOURCE = 'import x\n\nfunction add(a, b) {\n  return a + b;\n}';
const capture = { version: 1, anchorLine: 2, anchorText: 'function add(a, b) {', insertLine: 2 };

describe('relocateInsertLine', () => {
  it('keeps the line when the document is unchanged', () => {
    expect(relocateInsertLine(doc(SOURCE, 1) as never, capture)).toBe(2);
  });

  it('follows the function when lines were added above it', () => {
    const edited = '// header\n// more\n' + SOURCE;
    expect(relocateInsertLine(doc(edited, 2) as never, capture)).toBe(4);
  });

  it('keeps the offset from the anchor (a Python docstring goes below its def)', () => {
    const py = 'x = 1\ndef f():\n    pass';
    const pyCapture = { version: 1, anchorLine: 1, anchorText: 'def f():', insertLine: 2 };
    expect(relocateInsertLine(doc('# new\n' + py, 2) as never, pyCapture)).toBe(3);
  });

  it('picks the closest match when the anchor text repeats', () => {
    const twice = 'function add(a, b) {\n}\n\n\n\n\nfunction add(a, b) {\n}';
    const near = { version: 1, anchorLine: 5, anchorText: 'function add(a, b) {', insertLine: 5 };
    expect(relocateInsertLine(doc(twice, 2) as never, near)).toBe(6);
  });

  it('gives up when the anchor is gone', () => {
    const renamed = SOURCE.replace('add', 'sum');
    expect(relocateInsertLine(doc(renamed, 2) as never, capture)).toBeUndefined();
  });
});
