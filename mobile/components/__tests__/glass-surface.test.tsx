import React from "react";
import { AccessibilityInfo, Platform } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import GlassSurface from "@/components/glass-surface";

let mockLiquidGlass = true;
jest.mock("expo-blur", () => {
  const { View } = jest.requireActual("react-native");
  return { BlurView: (props: object) => <View testID="blur" {...props} /> };
});
jest.mock("expo-glass-effect", () => {
  const { View } = jest.requireActual("react-native");
  return {
    GlassView: (props: object) => <View testID="liquid-glass" {...props} />,
    isGlassEffectAPIAvailable: () => mockLiquidGlass,
    isLiquidGlassAvailable: () => mockLiquidGlass,
  };
});

let reduceTransparencyListener: ((enabled: boolean) => void) | undefined;

function mockReduceTransparency(enabled: boolean) {
  jest
    .spyOn(AccessibilityInfo, "isReduceTransparencyEnabled")
    .mockResolvedValue(enabled);
  jest
    .spyOn(AccessibilityInfo, "addEventListener")
    .mockImplementation((_event, listener) => {
      reduceTransparencyListener = listener as unknown as (
        enabled: boolean,
      ) => void;
      return { remove: jest.fn() } as never;
    });
}

async function renderSurface(tint?: string) {
  render(<GlassSurface radius={20} tint={tint} />);
  await act(async () => {});
}

beforeEach(() => {
  mockLiquidGlass = true;
  jest.replaceProperty(Platform, "OS", "ios");
});

afterEach(() => jest.restoreAllMocks());

it("uses Liquid Glass on iOS 26", async () => {
  mockReduceTransparency(false);
  await renderSurface();
  expect(screen.getByTestId("liquid-glass")).toBeTruthy();
});

it("falls back to the system blur where Liquid Glass is missing", async () => {
  mockLiquidGlass = false;
  mockReduceTransparency(false);
  await renderSurface();
  expect(screen.getByTestId("blur")).toBeTruthy();
});

it("keeps a tinted control solid where Liquid Glass is missing", async () => {
  mockLiquidGlass = false;
  mockReduceTransparency(false);
  await renderSurface("#2F5D4A");
  expect(screen.queryByTestId("blur")).toBeNull();
  expect(screen.queryByTestId("liquid-glass")).toBeNull();
});

it("stays solid on Android", async () => {
  jest.replaceProperty(Platform, "OS", "android");
  mockReduceTransparency(false);
  await renderSurface();
  expect(screen.queryByTestId("liquid-glass")).toBeNull();
  expect(screen.queryByTestId("blur")).toBeNull();
});

it("turns solid when the user turns on Reduce Transparency", async () => {
  mockReduceTransparency(false);
  await renderSurface();
  expect(screen.getByTestId("liquid-glass")).toBeTruthy();
  act(() => reduceTransparencyListener?.(true));
  expect(screen.queryByTestId("liquid-glass")).toBeNull();
});
