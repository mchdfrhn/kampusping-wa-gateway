import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const eslintConfig = tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'auth_state/**', 'data/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['warn', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // PM2 ecosystem files are CommonJS (deploy/package.json sets "type": "commonjs").
    files: ['deploy/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', __dirname: 'readonly' },
    },
  },
);

export default eslintConfig;
