// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // Tests declare jest.mock() before importing the module under test.
    // babel-jest hoists the mocks, so the import order is only for readers.
    files: ["**/__tests__/**"],
    rules: {
      "import/first": "off",
    },
  },
]);
