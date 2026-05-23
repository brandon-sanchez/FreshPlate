import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth";

export type InventoryItem = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  expiration_date: string | null;
  storage_location: "fridge" | "freezer" | "pantry";
  is_leftover: boolean;
  notes: string | null;
  added_by: string | null;
  category: {
    id: string;
    name: string;
    icon: string | null;
  } | null;
};

const SELECT = `
  id, name, quantity, unit, expiration_date, storage_location,
  is_leftover, notes, added_by,
  category:food_categories(id, name, icon)
` as const;

export function useInventoryItems() {
  const householdId = useAuthStore((s) => s.householdId);

  return useQuery({
    queryKey: ["inventory", householdId],
    enabled: !!householdId,
    queryFn: async (): Promise<InventoryItem[]> => {
      const { data, error } = await supabase
        .from("inventory_items")
        .select(SELECT)
        .eq("household_id", householdId!)
        .order("expiration_date", { ascending: true, nullsFirst: false });

      if (error) throw error;
      return (data ?? []) as unknown as InventoryItem[];
    },
  });
}

export function daysUntilExpiration(expirationDate: string | null): number | null {
  if (!expirationDate) return null;
  const parts = expirationDate.split("-");
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map((p) => Number(p));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const exp = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffMs = exp.getTime() - today.getTime();
  return Math.round(diffMs / 86400000);
}
