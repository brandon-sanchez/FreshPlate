// ─── Theme-Aware Components ──────────────────────────────────────────────────
// Wrappers around React Native's Text and View that automatically adapt to
// light/dark mode. Use these instead of the default React Native components
// so colors update when the user switches themes.
//
// Usage:  <Text lightColor="#000" darkColor="#fff">Hello</Text>
//         <View lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />
//
// Learn more: https://docs.expo.io/guides/color-schemes/

import { Text as DefaultText, View as DefaultView } from 'react-native';

import Colors from '@/constants/Colors';
import { useColorScheme } from './useColorScheme';

// Optional overrides — lets you pass custom colors for light/dark per component.
type ThemeProps = {
  lightColor?: string;
  darkColor?: string;
};

// Combine theme props with React Native's built-in Text/View props.
export type TextProps = ThemeProps & DefaultText['props'];
export type ViewProps = ThemeProps & DefaultView['props'];

// Returns the right color for the current theme.
// Priority: per-component override (lightColor/darkColor) → global Colors constant.
export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: keyof typeof Colors.light & keyof typeof Colors.dark
) {
  const theme = useColorScheme() ?? 'light';
  const colorFromProps = props[theme];

  if (colorFromProps) {
    return colorFromProps;
  } else {
    return Colors[theme][colorName];
  }
}

// Theme-aware Text — automatically sets text color based on light/dark mode.
export function Text(props: TextProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');

  return <DefaultText style={[{ color }, style]} {...otherProps} />;
}

// Theme-aware View — automatically sets background color based on light/dark mode.
export function View(props: ViewProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const backgroundColor = useThemeColor({ light: lightColor, dark: darkColor }, 'background');

  return <DefaultView style={[{ backgroundColor }, style]} {...otherProps} />;
}
