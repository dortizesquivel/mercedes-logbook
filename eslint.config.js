// Linting for the card, the scripts and the tests: ESLint's recommended rules, warnings fail CI.
import js from '@eslint/js';
import globals from 'globals';

export default [
  // Leaflet is vendored as published; the check-vendor script compares it with npm's instead.
  { ignores: ['custom_components/mercedes_trips/frontend/vendor/', '_site/', 'node_modules/', 'test-results/', 'playwright-report/', '.venv/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    // The card's texts use non-breaking spaces on purpose ("12 %", "4 km"), in template literals too.
    rules: { 'no-irregular-whitespace': ['error', { skipTemplates: true }] },
  },
  {
    files: ['scripts/**', 'test/**', 'playwright.config.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
