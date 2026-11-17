import { describe, expect, it } from 'vitest';
import { findPythonDocTarget } from './pythonDocstring';

const lines = (code: string) => code.split('\n');

describe('findPythonDocTarget', () => {
  it('inserts after the signature, indented like the body', () => {
    const code = lines('x = 1\n\n\ndef add(a, b):\n    return a + b\n');
    expect(findPythonDocTarget(code, 3)).toEqual({
      kind: 'insert',
      insertLine: 4,
      indent: '    ',
      defLine: 3,
    });
  });

  it('uses the decorated definition when started on a decorator', () => {
    const code = lines('@cache\n@other(1)\ndef f():\n  return 1');
    expect(findPythonDocTarget(code, 0)).toMatchObject({ insertLine: 3, indent: '  ', defLine: 2 });
  });

  it('is not fooled by colons in hints, defaults, lambdas or dict literals', () => {
    const code = lines(
      [
        'def f(a: int, b: dict = {"k": 1},',
        '      key=lambda x: x,',
        "      s: str = 'a:b') -> dict[str, int]:  # comment: ignored",
        '        pass',
      ].join('\n'),
    );
    expect(findPythonDocTarget(code, 0)).toMatchObject({ kind: 'insert', insertLine: 3 });
  });

  it('reports an existing body docstring, with or without a prefix', () => {
    expect(findPythonDocTarget(lines('def f():\n    """Doc."""\n    pass'), 0)).toEqual({
      kind: 'documented',
    });
    expect(findPythonDocTarget(lines("class A:\n\n    r'''Doc.'''"), 0)).toEqual({
      kind: 'documented',
    });
  });

  it('refuses a one-line definition', () => {
    expect(findPythonDocTarget(lines('def f(): return 1'), 0)).toEqual({ kind: 'oneLiner' });
  });

  it('handles a signature on the last line with no body', () => {
    expect(findPythonDocTarget(lines('class Empty:'), 0)).toEqual({
      kind: 'insert',
      insertLine: 1,
      indent: '    ',
      defLine: 0,
    });
  });

  it('nests methods with their own indentation', () => {
    const code = lines('class A:\n    def m(self):\n        return 1');
    expect(findPythonDocTarget(code, 1)).toMatchObject({ insertLine: 2, indent: '        ' });
  });

  it('says when the line is not a definition', () => {
    expect(findPythonDocTarget(lines('x = 1'), 0)).toEqual({ kind: 'notDefinition' });
  });
});
