import tseslint from 'typescript-eslint'
import unusedImports from 'eslint-plugin-unused-imports'
import prettier from 'eslint-config-prettier'

// Fix-only ESLint config: every enabled rule is auto-fixable (`eslint --fix`),
// so the linter never produces an error a human has to resolve by hand.
// Formatting is owned by Prettier (see .prettierrc.json); `prettier` here
// disables any stylistic rules that would conflict with it.
export default tseslint.config(
    {
        ignores: ['dist', 'node_modules', 'public', '*.tsbuildinfo'],
    },
    {
        files: ['src/**/*.{ts,tsx}'],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
                ecmaFeatures: { jsx: true },
            },
        },
        plugins: {
            'unused-imports': unusedImports,
        },
        // NOTE: we deliberately do NOT extend js.configs.recommended or the
        // typescript-eslint recommended sets — they include many non-fixable
        // rules. Only the hand-picked auto-fixable rules below are enabled.
        rules: {
            // Auto-removes unused imports (the one part of no-unused-vars that
            // is safely fixable; the rest is covered by tsconfig noUnusedLocals).
            'unused-imports/no-unused-imports': 'error',

            // Core auto-fixable rules (no runtime-behavior changes).
            'prefer-const': 'error',
            'no-var': 'error',
            'object-shorthand': ['error', 'always'],
            'prefer-template': 'error',
            'no-useless-rename': 'error',
            'no-useless-computed-key': 'error',
            'no-unneeded-ternary': 'error',
            'no-extra-boolean-cast': 'error',
            'prefer-object-spread': 'error',
            'operator-assignment': ['error', 'always'],
            'dot-notation': 'error',
            yoda: 'error',
        },
    },
    prettier,
)
