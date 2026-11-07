process.env.EXPO_PUBLIC_SUPABASE_URL = "http://test.local";
process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test-key";
require("react-native-gesture-handler/jestSetup");
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
