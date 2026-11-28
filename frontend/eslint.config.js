const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    { ignores: ['node_modules/**'] },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...globals.browser, $: 'readonly', jQuery: 'readonly', Sortable: 'readonly' },
        },
        rules: {
            eqeqeq: ['error', 'smart'],
            'no-var': 'error',
            'prefer-const': 'error',
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
        },
    },
    { files: ['sw.js'], languageOptions: { globals: { ...globals.serviceworker } } },
    { files: ['eslint.config.js'], languageOptions: { globals: { ...globals.node } } },
];
