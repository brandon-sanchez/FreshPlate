export const brand = {
  green: "#2D6A4F",
  greenLight: "#E8F5E9",
};

const tintColorLight = brand.green;
const tintColorDark = "#fff";

export default {
  light: {
    text: "#1a1a1a",
    background: "#FAF9F7",
    tint: tintColorLight,
    tabIconDefault: "#ccc",
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: "#fff",
    background: "#000",
    tint: tintColorDark,
    tabIconDefault: "#ccc",
    tabIconSelected: tintColorDark,
  },
};