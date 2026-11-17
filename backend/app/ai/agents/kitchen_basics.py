"""The household's kitchen basics, as the recipe pipeline matches them."""

from __future__ import annotations

from collections.abc import Iterable

from app.ai.agents.models import RecipeIngredient
from app.inventory.food_names import food_name_key

_BASIC_UNITS = ("pinch", "tsp", "tbsp", "cup", "ml")


class KitchenBasics:
    """Ingredients a household always has, which recipes may use untracked.

    Construction trims each name, drops blank ones, and keeps the first of
    names that share a ``food_name_key``, so every instance holds distinct
    basics.

    Attributes:
        names: Each basic's display name, trimmed, in the household's order.
    """

    __slots__ = ("_keys", "names")

    names: tuple[str, ...]
    _keys: frozenset[str]

    def __init__(self, names: Iterable[str]) -> None:
        """Hold ``names``, one basic per ``food_name_key``, in their order."""
        by_key: dict[str, str] = {}
        for name in names:
            key = food_name_key(name)
            if key:
                by_key.setdefault(key, name.strip())
        self.names = tuple(by_key.values())
        self._keys = frozenset(by_key)

    def __bool__(self) -> bool:
        return bool(self.names)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, KitchenBasics):
            return NotImplemented
        return self.names == other.names

    def __hash__(self) -> int:
        return hash(self.names)

    def __repr__(self) -> str:
        return f"KitchenBasics({list(self.names)!r})"

    @property
    def units(self) -> tuple[str, ...]:
        """Return the units a recipe may measure these basics in, or ``()``."""
        return _BASIC_UNITS if self else ()

    def supplies(self, ingredient: RecipeIngredient) -> bool:
        """Return whether ``ingredient`` is a free basic, never deducted.

        An ingredient has no inventory id only when the model labeled it with
        a basic's ``k`` label: the generation schema requires a string id,
        and ``FoodLabels.resolve`` clears it only for those labels. A
        household with no basics supplies nothing.
        """
        return bool(self) and ingredient.inventory_item_id is None

    def has_name(self, name: str) -> bool:
        """Return whether ``name`` is one of these basics, by ``food_name_key``."""
        return food_name_key(name) in self._keys

    def without(self, tracked: Iterable[str]) -> KitchenBasics:
        """Return these basics minus any named in ``tracked``, the kitchen's foods.

        A food the household tracks is mapped and deducted like any other, so
        it can't also be a free basic.
        """
        tracked_keys = {food_name_key(name) for name in tracked}
        return KitchenBasics(
            name for name in self.names if food_name_key(name) not in tracked_keys
        )
