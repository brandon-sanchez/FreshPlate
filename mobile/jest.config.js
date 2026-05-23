module.exports = {
  preset: "jest-expo",
  setupFiles: ["<rootDir>/jest.setup.js"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  testPathIgnorePatterns: ["/node_modules/", "/.expo/"],
  collectCoverageFrom: [
    "hooks/**/*.{ts,tsx}",
    "!hooks/useTheme.ts",
    "!hooks/useClientOnlyValue*",
  ],
  // jest-expo / RN leaves async handles open in test workers; safe to force exit since
  // every test is hermetic and the runner is not used in CI yet.
  forceExit: true,
};
