/* global jest */
process.env.EXPO_PUBLIC_SUPABASE_URL = "http://test.local";
process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test-key";
require("react-native-gesture-handler/jestSetup");

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

// The real swipeable attaches worklet gestures that Jest cannot run. The mock
// renders the actions beside the content so tests can tap them, and keeps
// `close` callable through the ref.
jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () => {
  const React = require("react");
  const { View } = require("react-native");
  const MockSwipeable = React.forwardRef(function MockSwipeable(
    { children, renderRightActions },
    ref,
  ) {
    React.useImperativeHandle(ref, () => ({ close: jest.fn() }));
    return React.createElement(
      View,
      { testID: "swipe-row" },
      children,
      renderRightActions ? renderRightActions({ value: 0 }) : null,
    );
  });
  return { __esModule: true, default: MockSwipeable };
});
