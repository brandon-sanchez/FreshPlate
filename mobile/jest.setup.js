process.env.EXPO_PUBLIC_SUPABASE_URL = "http://test.local";
process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test-key";
require("react-native-gesture-handler/jestSetup");
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

// The library's mock RectButton renders an empty View in place of its
// children, which hides button contents from queries. Pressable keeps them.
jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  const { Pressable } = require("react-native");
  const actual = jest.requireActual("react-native-gesture-handler");
  function RectButton({ enabled, underlayColor, activeOpacity, ...props }) {
    return React.createElement(Pressable, { disabled: enabled === false, ...props });
  }
  return { ...actual, RectButton };
});

// React Native's View mock stubs measureInWindow without calling back, so a
// menu anchored to a measured trigger would never open.
require("react-native/jest/MockNativeMethods").default.measureInWindow.mockImplementation(
  (callback) => callback(0, 0, 0, 0),
);

// Expo's native views, such as expo-image's Image, call findNodeHandle when
// they mount, and React Native loads its whole renderer and its public
// instance module on that first call. On a cold transform cache with every
// worker busy, those loads can push the first test that renders a photo past
// Jest's 5-second timeout. Loading them here charges them to file setup,
// which no test timeout covers.
require("react-native/Libraries/Renderer/shims/ReactNative");
require("react-native/Libraries/ReactNative/ReactFabricPublicInstance/ReactFabricPublicInstance");
