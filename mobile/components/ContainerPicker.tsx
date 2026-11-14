import Field from "@/components/Field";
import ChoiceChips from "@/components/ChoiceChips";
import type { InventoryItem } from "@/hooks/useInventoryItems";
import { formatAmount } from "@/lib/amount";

type ContainerPickerProps = {
  /** The opened batches of the food being added. Renders nothing when empty. */
  containers: readonly InventoryItem[];
  /** The picked batch, or `null` for a new batch. */
  selected: InventoryItem | null;
  /** Called with the tapped batch, or `null` for "New batch". */
  onSelect: (lot: InventoryItem | null) => void;
};

/**
 * Renders the "Add to an open container" choice on the add form: a new batch,
 * or one of the food's opened batches the food was put into, such as a jug or
 * an egg tray.
 */
function ContainerPicker({ containers, selected, onSelect }: ContainerPickerProps) {
  if (containers.length === 0) return null;
  return (
    <Field
      label="Add to an open container"
      hint={
        selected === null
          ? undefined
          : "Goes into this container, which stays where it is and keeps the earlier date."
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
  const location = lot.storage_location.charAt(0).toUpperCase() + lot.storage_location.slice(1);
  return `${formatAmount(lot.quantity, lot.unit, lot.is_estimate)} · ${location}`;
}

export default ContainerPicker;
