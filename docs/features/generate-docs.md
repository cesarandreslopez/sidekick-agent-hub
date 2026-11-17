# Generate Documentation

Good documentation is valuable but tedious to write. This generates JSDoc/docstrings that actually describe what your code does — parameters, return values, edge cases — based on the implementation, not just the signature.

Automatically generate JSDoc/docstrings for functions, classes, and methods.

## Usage

1. Place your cursor in a function or select code
2. Press `Ctrl+K Ctrl+G` (`Cmd+K Cmd+G` on Mac)
3. Documentation is inserted where the language expects it: a doc comment above the function, or for Python a docstring as the first line of the body

If you keep editing while the documentation is generated, it is still inserted at the function you asked about. If that function changed so much that it can't be found again, you're offered a copy instead.

## Supported Languages

- TypeScript / JavaScript
- Python
- And more — works with any language that uses doc comments

## What It Generates

- Function/method description
- Parameter descriptions with types
- Return type documentation
- Usage examples where applicable

## Configuration

| Setting             | Default | Description                                          |
| ------------------- | ------- | ---------------------------------------------------- |
| `sidekick.docModel` | `auto`  | Model tier — resolves to `fast` for quick generation |
