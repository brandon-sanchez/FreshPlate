"""The household's kitchen basics, as the recipe pipeline matches them."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

# Mirrors the defaults seed_kitchen_basics() gives every household in
# supabase/migrations/20261114170000_add_kitchen_basics.sql.
DEFAULT_KITCHEN_BASICS = ("Salt", "Black pepper", "Neutral oil", "Olive oil", "Water")


def basic_key(name: str) -> str:
    """Return the identity of a basic or food name.

    Mirrors ``public.food_name_key``: case-insensitive, with surrounding
    whitespace trimmed and inner runs collapsed, so " salt " is "Salt".
    """
    return " ".join(name.casefold().split())


@dataclass(frozen=True)
class KitchenBasics:
    """Ingredients a household always has, which recipes may use untracked.

    Attributes:
        names: Each basic's display name, trimmed, in the household's order,
            one per ``basic_key``.
    """

    names: tuple[str, ...]
    _keys: frozenset[str] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "_keys", frozenset(map(basic_key, self.names)))

    @classmethod
    def parse(cls, raw: object) -> KitchenBasics:
        """Return the basics in ``raw``, a list of names, without duplicates.

        ``None`` means the household has no basics. Blank names are dropped.

        Raises:
            ValueError: When ``raw`` is not a list of strings.
        """
        if raw is None:
            raw = []
        if not isinstance(raw, (list, tuple)) or not all(
            isinstance(name, str) for name in raw
        ):
            raise ValueError("Kitchen basics must be a list of names")
        names: list[str] = []
        seen: set[str] = set()
        for name in raw:
            key = basic_key(name)
            if key and key not in seen:
                seen.add(key)
                names.append(name.strip())
        return cls(tuple(names))

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and basic_key(name) in self._keys

    def __bool__(self) -> bool:
        return bool(self.names)

    def without(self, tracked: Iterable[str]) -> KitchenBasics:
        """Return these basics minus any named in ``tracked``, the kitchen's foods.

        A food the household tracks is mapped and deducted like any other, so
        it can't also be a free basic.
        """
        tracked_keys = {basic_key(name) for name in tracked}
        return KitchenBasics(
            tuple(name for name in self.names if basic_key(name) not in tracked_keys)
        )
