import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RecipeSuggestion } from "@/types/recipes";

jest.mock("@/lib/supabase", () => ({ supabase: {} }));
jest.mock("@/lib/image-api", () => ({
  fetchRecipeImage: () => new Promise(() => {}),
  fetchFoodImage: () => new Promise(() => {}),
}));
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@expo/vector-icons/Ionicons", () => () => null);
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@react-navigation/bottom-tabs", () => ({
  useBottomTabBarHeight: () => 80,
}));
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: { householdId: string }) => unknown) =>
    selector({ householdId: "household-1" }),
}));
jest.mock("@/stores/activeCook", () => ({
  useActiveCookStore: (selector: (s: unknown) => unknown) =>
    selector({ activeCook: { recipe: { title: "Weeknight dish" } } }),
}));
jest.mock("@/hooks/useActiveCook", () => ({
  useActiveCook: () => ({
    start: jest.fn(),
    finish: jest.fn(),
    pending: false,
  }),
  useIsActiveCook: () => false,
}));

type Inventory = ReturnType<typeof useInventoryItems>;
type Feed = ReturnType<typeof useRecipeFeed>;
type Saved = ReturnType<typeof useSavedRecipes>;

const mockInventory = { current: {} as Partial<Inventory> };
jest.mock("@/hooks/useInventoryItems", () => ({
  useInventoryItems: () => mockInventory.current,
}));
const mockFeed = { current: {} as Partial<Feed> };
jest.mock("@/hooks/useRecipeFeed", () => ({
  useRecipeFeed: () => mockFeed.current,
}));
const mockSaved = { current: {} as Partial<Saved> };
jest.mock("@/hooks/useSavedRecipes", () => ({
  useSavedRecipes: () => mockSaved.current,
}));

import RecipesScreen from "@/app/(tabs)/recipes";
import type {
  InventoryItem,
  useInventoryItems,
} from "@/hooks/useInventoryItems";
import type { useRecipeFeed } from "@/hooks/useRecipeFeed";
import type { useSavedRecipes } from "@/hooks/useSavedRecipes";

const INSET_TOP = 44;
// RecipeScreenHeader's gap between the safe area and the title.
const HEADER_TOP = INSET_TOP + 16;

const recipe: RecipeSuggestion = {
  recipe_id: "recipe-1",
  title: "Spinach Pasta",
  cook_time_minutes: 24,
  servings: 2,
  ingredients: [
    {
      name: "Spinach",
      inventory_item_id: "spinach",
      use_amount: 100,
      unit: "g",
    },
  ],
  steps: ["Cook it"],
  match_percent: 92,
  saves_expiring: [],
};

const idleFeed: Partial<Feed> = {
  recipes: [],
  status: "idle",
  isRestoring: false,
  prefetchError: null,
  isBootstrapping: false,
  isPrefetching: false,
  isExhausted: false,
  ending: { kind: "empty", dish: "meal" },
  start: jest.fn(),
  retry: jest.fn(),
  retryPrefetch: jest.fn(),
  dismiss: jest.fn(),
  restore: jest.fn(),
  steer: jest.fn(),
  maybePrefetch: jest.fn(),
};
const stockedInventory: Partial<Inventory> = {
  data: [{ id: "item-1" } as InventoryItem],
  isPending: false,
  isError: false,
  refetch: jest.fn(),
};

type ScreenState = {
  inventory?: Partial<Inventory>;
  feed?: Partial<Feed>;
  pressText?: string;
};

const states: Record<string, ScreenState> = {
  "loading the fridge": { inventory: { isPending: true } },
  "restoring a feed": { feed: { isRestoring: true } },
  "fridge error": { inventory: { data: undefined, isError: true } },
  "empty fridge": { inventory: { data: [] } },
  "idle prompt": {},
  "preference questions": { pressText: "Ask me questions first" },
  generating: { feed: { status: "loading" } },
  bootstrapping: { feed: { status: "ready", isBootstrapping: true } },
  "generation error": { feed: { status: "error" } },
  "ready feed": { feed: { status: "ready", recipes: [recipe] } },
  "saved recipes": { pressText: "Saved" },
};

type JsonNode = {
  type: string;
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
};

function renderState({ inventory, feed, pressText }: ScreenState) {
  mockInventory.current = { ...stockedInventory, ...inventory } as Inventory;
  mockFeed.current = { ...idleFeed, ...feed };
  mockSaved.current = {
    data: [],
    isPending: false,
    isError: false,
    savedIds: new Set<string>(),
    isToggling: false,
    toggle: jest.fn(),
    refetch: jest.fn(),
  } as Partial<Saved>;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: INSET_TOP, right: 0, bottom: 34, left: 0 },
        }}
      >
        <RecipesScreen />
      </SafeAreaProvider>
    </QueryClientProvider>,
  );
  if (pressText) fireEvent.press(screen.getByText(pressText));
  return screen.toJSON() as JsonNode | JsonNode[] | null;
}

function childrenOf(node: JsonNode): JsonNode[] {
  return (node.children ?? []).filter(
    (child): child is JsonNode => typeof child !== "string",
  );
}

function pathTo(
  root: JsonNode | JsonNode[] | null,
  match: (node: JsonNode) => boolean,
): JsonNode[] {
  const roots = root === null ? [] : Array.isArray(root) ? root : [root];
  for (const node of roots) {
    if (match(node)) return [node];
    const rest = pathTo(childrenOf(node), match);
    if (rest.length) return [node, ...rest];
  }
  return [];
}

function textOf(node: JsonNode): string {
  return (node.children ?? [])
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

const TOP_SPACING_KEYS = [
  "top",
  "padding",
  "paddingTop",
  "paddingVertical",
  "margin",
  "marginTop",
  "marginVertical",
  "borderWidth",
  "borderTopWidth",
] as const;

function topSpacing(node: JsonNode): number {
  const styles = [node.props.style, node.props.contentContainerStyle].map(
    (style) => StyleSheet.flatten(style as StyleProp<ViewStyle>) ?? {},
  );
  return styles
    .flatMap((style) => TOP_SPACING_KEYS.map((key) => style[key] ?? 0))
    .reduce<number>((sum, value) => sum + Number(value), 0);
}

describe("RecipesScreen header", () => {
  it.each(Object.entries(states))(
    "pins the same header to the top while %s",
    (_name, state) => {
      const path = pathTo(
        renderState(state),
        (node) => node.props.testID === "recipes-header",
      );
      const header = path.at(-1);
      if (!header) throw new Error("recipes-header is not rendered");
      const ancestors = path.slice(0, -1);

      expect(textOf(header)).toBe("RecipesCooking: Weeknight dish");
      expect(StyleSheet.flatten(header.props.style as ViewStyle)).toEqual(
        expect.objectContaining({ paddingTop: HEADER_TOP }),
      );
      ancestors.forEach((parent, index) => {
        expect(childrenOf(parent)[0]).toBe(path[index + 1]);
        expect(topSpacing(parent)).toBe(0);
      });

      const siblings = childrenOf(path[path.length - 2]);
      const tabs = siblings[siblings.indexOf(header) + 1];
      expect(
        pathTo(tabs, (node) => node.props.accessibilityRole === "tab"),
      ).not.toEqual([]);
    },
  );
});
