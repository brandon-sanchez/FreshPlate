import Field from "@/components/Field";
import ChoiceChips from "@/components/ChoiceChips";
import type { InventoryItem } from "@/hooks/useInventoryItems";
import { formatAmount } from "@/lib/amount";

type ContainerPickerProps = {
  /** The live batches of the food being added. Renders nothing when empty. */
  containers: readonly InventoryItem[];
  /** The picked batch, or `null` for a new batch. */
  selected: InventoryItem | null;
  /** Called with the tapped batch, or `null` for "New batch". */
  onSelect: (lot: InventoryItem | null) => void;
};

/**
 * Renders the "Add to" choice on the add form: a new batch, or one of the
 * food's live batches the food was put into, such as a jug or an egg tray.
 */
function ContainerPicker({ containers, selected, onSelect }: ContainerPickerProps) {
  if (containers.length === 0) return null;
  return (
    <Field
      label="Add to"
      hint={
        selected === null
          ? undefined
          : "Goes into this batch, which stays where it is, counts as opened and keeps the earlier date."
      }
    >
      <ChoiceChips
        choices={[
          { key: "new", label: "New batch", value: null },
          ...containers.map((lot) => ({ key: lot.id, label: containerLabel(lot), value: lot })),
        ]}
        selected={selected}
        onSelect={onSelect}
      />
    </Field>
  );
}

function containerLabel(lot: InventoryItem): string {
  const parts = [
    formatAmount(lot.quantity, lot.unit, lot.is_estimate),
    lot.storage_location.charAt(0).toUpperCase() + lot.storage_location.slice(1),
  ];
  if (lot.opened_at !== null) parts.push("Opened");
  return parts.join(" · ");
}

export default ContainerPicker;
