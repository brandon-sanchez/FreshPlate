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

// React Native loads most of its modules on first use: each component and
// API behind a lazy getter on the package, and its renderer on the first
// findNodeHandle call, which every Expo native view such as expo-image's
// Image makes when it mounts. Left lazy, that loading, and on a cold
// transform cache the compiling, happens inside whichever test renders the
// module first. With every worker busy it can push that test past Jest's
// 5-second timeout. Loading the modules here charges them to file setup,
// which no test timeout covers. The list holds what the app imports from
// react-native; a missing name only makes its first test slower.
const PRELOADED_REACT_NATIVE_EXPORTS = [
  "AccessibilityInfo",
  "ActivityIndicator",
  "Alert",
  "Animated",
  "Easing",
  "FlatList",
  "InputAccessoryView",
  "Keyboard",
  "KeyboardAvoidingView",
  "Linking",
  "Modal",
  "PanResponder",
  "PixelRatio",
  "Platform",
  "Pressable",
  "RefreshControl",
  "ScrollView",
  "StyleSheet",
  "Switch",
  "Text",
  "TextInput",
  "View",
  "useColorScheme",
  "useWindowDimensions",
];
const ReactNative = require("react-native");
for (const name of PRELOADED_REACT_NATIVE_EXPORTS) {
  void ReactNative[name];
}
require("react-native/Libraries/Renderer/shims/ReactNative");
require("react-native/Libraries/ReactNative/ReactFabricPublicInstance/ReactFabricPublicInstance");
