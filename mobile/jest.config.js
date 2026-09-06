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
};
