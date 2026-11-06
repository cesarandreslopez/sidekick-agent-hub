const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      // Zod's `z` (and default) export is a namespace object that bundlers
      // cannot tree-shake, so a named `z` import ships every Zod locale into
      // consumer bundles. `import * as z from 'zod'` keeps member accesses
      // shakeable. `no-restricted-imports` cannot express this: its
      // `importNames` option also rejects the namespace form we want.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value=/^zod(\\u002F.*)?$/][importKind!='type'] > ImportSpecifier[imported.name='z'][importKind!='type']",
          message:
            "Use `import * as z from 'zod'`: a named `z` import defeats tree-shaking and bundles every Zod locale.",
        },
        {
          selector:
            "ImportDeclaration[source.value=/^zod(\\u002F.*)?$/][importKind!='type'] > ImportDefaultSpecifier",
          message:
            "Use `import * as z from 'zod'`: the default export defeats tree-shaking and bundles every Zod locale.",
        },
      ],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.config.js', '**/*.test.ts', 'src/testing/*.setup.ts'],
  },
);
