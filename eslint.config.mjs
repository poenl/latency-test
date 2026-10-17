import tseslint from 'typescript-eslint'
import { defineConfig } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import eslintConfigPrettier from 'eslint-config-prettier'

export default defineConfig(
  { ignores: ['dist'] },
  reactHooks.configs.flat['recommended-latest'],
  ...tseslint.configs.recommended,
  reactRefresh.configs.vite,
  eslintConfigPrettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'error'
    }
  }
)
