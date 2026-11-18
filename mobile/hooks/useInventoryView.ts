import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { GroupBy } from "@/lib/foodRows";
import { DEFAULT_SORT, isSortBy, type SortBy } from "@/lib/foodSort";

type View = { groupBy: GroupBy; sortBy: SortBy };

const STORAGE_KEY = "freshplate.inventory-view";
const GROUPINGS: readonly GroupBy[] = ["Location", "Category", "Urgency"];
const DEFAULT_VIEW: View = { groupBy: "Location", sortBy: DEFAULT_SORT };

/**
 * Returns how the Inventory screen groups and sorts its rows, and setters for
 * both. The choice is a per-device preference kept in AsyncStorage under
 * `freshplate.inventory-view`, so it outlives the app being closed. Until the
 * stored choice is read, `hydrated` is false and the values are the defaults:
 * grouped by Location, soonest expiry first. A stored value that is missing,
 * unreadable or unrecognized falls back to its default. A failed write keeps
 * the choice for the current visit only, since losing a preference must
 * never block browsing.
 */
export function useInventoryView() {
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [hydrated, setHydrated] = useState(false);
  const changed = useRef(false);

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (mounted && !changed.current) setView(parseView(raw));
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setHydrated(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!changed.current) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(view)).catch(() => {});
  }, [view]);

  const setGroupBy = useCallback((groupBy: GroupBy) => {
    changed.current = true;
    setView((current) => ({ ...current, groupBy }));
  }, []);

  const setSortBy = useCallback((sortBy: SortBy) => {
    changed.current = true;
    setView((current) => ({ ...current, sortBy }));
  }, []);

  return { ...view, hydrated, setGroupBy, setSortBy };
}

function parseView(raw: string | null): View {
  let stored: unknown = null;
  try {
    stored = raw === null ? null : JSON.parse(raw);
  } catch {}
  const fields =
    typeof stored === "object" && stored !== null
      ? (stored as Record<string, unknown>)
      : {};
  return {
    groupBy:
      GROUPINGS.find((g) => g === fields.groupBy) ?? DEFAULT_VIEW.groupBy,
    sortBy: isSortBy(fields.sortBy) ? fields.sortBy : DEFAULT_VIEW.sortBy,
  };
}
