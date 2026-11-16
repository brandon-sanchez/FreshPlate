import React from "react";
import { Alert, type AlertButton } from "react-native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Toast from "react-native-toast-message";

const mockDelete = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            order: () => Promise.resolve({ data: [milkLot], error: null }),
          }),
        }),
      }),
      delete: () => ({ eq: () => ({ select: () => mockDelete() }) }),
    }),
  },
}));
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: { householdId: string }) => unknown) =>
    selector({ householdId: "household-1" }),
}));
const mockBack = jest.fn();
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: mockBack }),
  useLocalSearchParams: () => ({ id: "lot-1" }),
}));
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@react-native-community/slider", () => () => null);
jest.mock("react-native-toast-message", () => ({ __esModule: true, default: { show: jest.fn() } }));

import ItemDetailScreen from "@/app/item/[id]";

const milkLot = {
  id: "lot-1",
  quantity: 1000,
  expiration_date: null,
  storage_location: "fridge",
  notes: null,
  added_by: null,
  opened_at: null,
  created_at: "2026-11-01T12:00:00+00:00",
  food: {
    id: "food-milk",
    name: "Milk",
    stock_base: "ml",
    each_label: null,
    category: null,
  },
};

async function confirmDelete() {
  const alert = jest.spyOn(Alert, "alert");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <ItemDetailScreen />
    </QueryClientProvider>,
  );
  fireEvent.press(await screen.findByText("Delete"));
  const buttons = alert.mock.calls[0][2] as AlertButton[];
  buttons.find((b) => b.text === "Delete")?.onPress?.();
}

beforeEach(() => {
  mockBack.mockReset();
  mockDelete.mockReset();
  (Toast.show as jest.Mock).mockReset();
});

it("goes back when another phone already changed the batch", async () => {
  mockDelete.mockResolvedValue({ data: [], error: null });

  await confirmDelete();

  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
});

it("stays on the batch when the delete fails for another reason", async () => {
  mockDelete.mockResolvedValue({ data: null, error: { message: "network down" } });

  await confirmDelete();

  await waitFor(() => expect(Toast.show).toHaveBeenCalled());
  expect(mockBack).not.toHaveBeenCalled();
  expect(screen.getByText("Milk")).toBeTruthy();
});
