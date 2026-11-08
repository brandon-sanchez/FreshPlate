"""Build generic food profiles from USDA FoodData Central SR Legacy portions.

A food profile holds estimates shared by every household. It has a density
and the weight of common units ("1 cup" of rice, "1 clove" of garlic, one medium
onion). The values come from SR Legacy's ``food_portion.csv``, where each row
names its unit in free text, such as ``cup, chopped`` or ``medium (2-1/2"
dia)``. ``parse_modifier`` reads that text into a unit, a size and a
qualifier, and ``build_profile`` picks one weight per unit.

A hand-curated catalogue maps each profile to one SR Legacy food and lists the
household food names (aliases) that share it. ``build_profiles`` checks the
catalogue against SR Legacy and builds every profile, and ``render_seed_sql``
turns them into the seed migration. Nothing here touches the network or a
database. ``scripts/import_food_profiles.py`` does the downloading and writing.
"""

from __future__ import annotations

import csv
import json
import re
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Literal, NamedTuple

from app.inventory.units import Exact, FoodFacts, normalize_unit, to_stock

CATALOG_COLUMNS = (
    "profile_key",
    "fdc_id",
    "usda_description",
    "aliases",
    "each_portion",
)

# Whole-item size words, in the order a count unit prefers them. A portion
# with no size ranks just after medium (see _size_rank).
_SIZES = ("medium", "large", "small", "extra large", "extra small", "jumbo")
# Product-specific portions (one brand's package, a piece of a cut) and
# seasoning-sized draws the converter handles without a weight. Piece, item
# and pc are matched as written because normalize_unit reads them as "each".
_PRODUCT_PORTIONS = frozenset(
    (
        "serving",
        "nlea",
        "package",
        "pack",
        "packet",
        "can",
        "container",
        "jar",
        "bottle",
        "box",
        "carton",
        "envelope",
        "unit",
        "item",
        "items",
        "piece",
        "pieces",
        "pc",
        "pcs",
        "portion",
        "scoop",
        "cubic",
        "individual",
        "drink",
        "mini",
        "miniature",
        "pinch",
        "dash",
    )
)
_MASS = frozenset(("g", "kg", "mg", "oz", "lb"))


def _millilitres(unit: str) -> Decimal:
    result = to_stock(Decimal(1), unit, FoodFacts(stock_base="ml"))
    assert isinstance(result, Exact)
    return result.amount


_VOLUME_ML = {
    unit: _millilitres(unit)
    for unit in ("ml", "l", "tsp", "tbsp", "fl oz", "cup", "pt", "qt", "gal")
}
_DENSITY_PREFERENCE = ("cup", "tbsp", "tsp")
_DENSITY_RANGE_G_PER_ML = (Decimal("0.02"), Decimal("2.5"))
# Words that start a qualifier right after a count word ("slice raw", "thigh
# without skin"). Any other word there makes a compound item name.
_QUALIFIER_LEADS = frozenset(("with", "without", "raw", "yields", "inner", "outer"))
_PARENTHETICAL = re.compile(r"\([^)]*\)?")
_WORD = re.compile(r",|[^\s,]+")
_GRAMS = Decimal("0.001")
_G_PER_ML = Decimal("0.0001")

_Kind = Literal["size", "product", "mass", "volume", "count", "comma"]


class _Token(NamedTuple):
    word: str
    kind: _Kind


class _Candidate(NamedTuple):
    rank: tuple[int, bool, int]
    grams: Decimal


@dataclass(frozen=True)
class UsdaPortion:
    """One row of SR Legacy ``food_portion.csv``.

    Attributes:
        seq_num: USDA's display order for the food's portions, lowest first.
        amount: How many of the unit the row weighs, e.g. 3 for "3 cloves".
        modifier: The free-text unit, e.g. ``cup, chopped``.
        gram_weight: Weight of ``amount`` units, in grams.
    """

    seq_num: int
    amount: Decimal
    modifier: str
    gram_weight: Decimal


@dataclass(frozen=True)
class UsdaData:
    """The parts of SR Legacy the importer reads.

    Attributes:
        descriptions: USDA description per FDC id, from ``food.csv``.
        portions: Portions per FDC id, ordered by ``seq_num``. A food with no
            portions is absent.
    """

    descriptions: Mapping[int, str]
    portions: Mapping[int, tuple[UsdaPortion, ...]]


@dataclass(frozen=True)
class CatalogEntry:
    """One row of the hand-curated profile catalogue.

    Attributes:
        profile_key: The profile's key, in ``food_name_key`` form (lowercase,
            single spaces), e.g. ``rice``.
        fdc_id: The SR Legacy food the facts come from. Two profiles may share
            one food (tomato and cherry tomato).
        usda_description: USDA's description of ``fdc_id``, checked against
            ``food.csv`` so a mistyped id fails the import.
        aliases: Other food names that use this profile, in ``food_name_key``
            form, sorted.
        each_portion: The unit whose weight is one whole item, e.g. ``large``
            for eggs, ``head`` for lettuce or ``fruit`` for a lime. None uses
            the medium size, else a whole item listed without a size.
    """

    profile_key: str
    fdc_id: int
    usda_description: str
    aliases: tuple[str, ...]
    each_portion: str | None


@dataclass(frozen=True)
class ParsedPortion:
    """A portion modifier read into its parts.

    Attributes:
        unit: The ``unit_grams`` key the portion weighs, in ``normalize_unit``
            form: a unit such as ``cup`` or ``clove``, or for one whole item
            its size (``medium``), else ``each``.
        size: One of the size words in ``_SIZES``, or None. It ranks portions
            of the same unit, and is always None for volume units.
        qualifier: The remaining words, e.g. ``chopped``, or empty when none.
    """

    unit: str
    size: str | None
    qualifier: str


@dataclass(frozen=True)
class FoodProfile:
    """A USDA-sourced food profile ready to seed.

    Attributes:
        profile_key: The profile's key, e.g. ``rice``.
        density: Grams per millilitre computed from the preferred volume
            portion, or None when USDA lists none. It may be implausible, so
            seed ``g_per_ml`` instead.
        unit_grams: Grams per unit, keyed by ``normalize_unit`` form. The key
            ``each`` is one whole item, and the profile key's own
            ``normalize_unit`` form weighs the same.
        source_ref: ``fdc:<id>`` of the SR Legacy food.
        aliases: Other food names that use this profile, sorted.
    """

    profile_key: str
    density: Decimal | None
    unit_grams: Mapping[str, Decimal]
    source_ref: str
    aliases: tuple[str, ...]

    @property
    def g_per_ml(self) -> Decimal | None:
        """The density to seed: ``density`` when plausible for a food, else None.

        No food is lighter than 0.02 g/ml (loose dill) or denser than 2.5
        g/ml, so a value outside that range points at a misread portion. The
        import reports it instead of seeding it.
        """
        low, high = _DENSITY_RANGE_G_PER_ML
        if self.density is None or not low <= self.density <= high:
            return None
        return self.density


def read_usda(directory: Path) -> UsdaData:
    """Read descriptions and portions from an extracted SR Legacy CSV download.

    Args:
        directory: Directory holding ``food.csv`` and ``food_portion.csv``.

    Returns:
        Every food's description and its portions ordered by ``seq_num``.

    Raises:
        FileNotFoundError: When either CSV is missing.
    """
    with (directory / "food.csv").open(newline="", encoding="utf-8") as file:
        descriptions = {
            int(row["fdc_id"]): row["description"] for row in csv.DictReader(file)
        }
    portions: dict[int, list[UsdaPortion]] = {}
    with (directory / "food_portion.csv").open(newline="", encoding="utf-8") as file:
        for row in csv.DictReader(file):
            portions.setdefault(int(row["fdc_id"]), []).append(
                UsdaPortion(
                    seq_num=int(row["seq_num"] or 0),
                    amount=Decimal(row["amount"]),
                    modifier=row["modifier"],
                    gram_weight=Decimal(row["gram_weight"]),
                )
            )
    return UsdaData(
        descriptions=descriptions,
        portions={
            fdc_id: tuple(sorted(rows, key=lambda portion: portion.seq_num))
            for fdc_id, rows in portions.items()
        },
    )


def read_catalog(path: Path) -> list[CatalogEntry]:
    """Read and validate the profile catalogue CSV.

    The CSV has the columns in ``CATALOG_COLUMNS``. ``aliases`` is a
    ``|``-separated list, and ``each_portion`` may be blank.

    Args:
        path: The catalogue file.

    Returns:
        The entries in file order.

    Raises:
        ValueError: When the columns differ from ``CATALOG_COLUMNS``, a key or
            alias is not in ``food_name_key`` form, or a profile key or alias
            names two profiles.
    """
    with path.open(newline="", encoding="utf-8") as file:
        reader = csv.DictReader(file)
        if tuple(reader.fieldnames or ()) != CATALOG_COLUMNS:
            raise ValueError(f"catalogue columns must be {', '.join(CATALOG_COLUMNS)}")
        entries = [_catalog_entry(row) for row in reader]
    owners: dict[str, list[str]] = {}
    for entry in entries:
        for name in (entry.profile_key, *entry.aliases):
            owners.setdefault(name, []).append(entry.profile_key)
    clashes = [
        f"{name!r} ({', '.join(keys)})"
        for name, keys in owners.items()
        if len(keys) > 1
    ]
    if clashes:
        raise ValueError(f"names used by more than one profile: {'; '.join(clashes)}")
    return entries


def build_profiles(
    catalog: Iterable[CatalogEntry], usda: UsdaData
) -> list[FoodProfile]:
    """Build one profile per catalogue entry from SR Legacy.

    A food SR Legacy lists without portions gets a profile with no units and
    no density, which the import report lists.

    Args:
        catalog: The catalogue entries, as ``read_catalog`` returns them.
        usda: SR Legacy descriptions and portions.

    Returns:
        The profiles, in catalogue order.

    Raises:
        ValueError: When any entry's ``fdc_id`` is missing from SR Legacy or
            its ``usda_description`` differs (the message lists every such
            entry), or an entry's ``each_portion`` is not a weighed unit.
    """
    entries = list(catalog)
    mismatches = [
        f"{entry.profile_key}: fdc {entry.fdc_id} is "
        f"{usda.descriptions.get(entry.fdc_id, 'missing')!r}, "
        f"catalogue says {entry.usda_description!r}"
        for entry in entries
        if usda.descriptions.get(entry.fdc_id) != entry.usda_description
    ]
    if mismatches:
        raise ValueError(
            "Catalogue does not match SR Legacy:\n  " + "\n  ".join(mismatches)
        )
    return [
        build_profile(entry, usda.portions.get(entry.fdc_id, ())) for entry in entries
    ]


def parse_modifier(
    text: str, item_names: Collection[str] = frozenset()
) -> ParsedPortion | None:
    """Read an SR Legacy portion modifier into unit, size and qualifier.

    Parenthesized notes are dropped. A leading volume unit keeps every other
    word as its qualifier (``cup, chopped``). A leading size word, optionally
    followed by ``whole``, is one whole item (``medium (2-1/2" dia)``), or
    sizes the count unit after it (``small bagel``). Otherwise the first word
    is a count unit, and a size word after it is its size (``head, medium``).

    A count word that names the food itself (``potato`` for potatoes) is one
    whole item, not a unit. A count word followed directly by another word,
    with no comma between them, is the start of a compound item name
    (``watermelon balls``, ``plum tomato``). It is one whole item when the
    compound names the food (``hot dog``) and skipped otherwise. Words such
    as ``with``, ``raw`` or a number start a qualifier instead (``slice
    raw``).

    Args:
        text: The ``modifier`` column, e.g. ``slice, large (1/4" thick)``.
        item_names: The food's own names (profile key and aliases) in
            ``normalize_unit`` form.

    Returns:
        The parsed portion, or None for a mass unit (its weight is already
        known), a product-specific unit such as ``package`` or ``serving``, a
        compound name of another item, or an empty modifier.
    """
    tokens = _tokenize(text)
    if not tokens or tokens[0].kind in ("product", "mass", "comma"):
        return None
    head, rest = tokens[0], tokens[1:]
    if head.kind == "volume":
        return ParsedPortion(normalize_unit(head.word), None, _qualifier(rest))
    size = None
    if head.kind == "size":
        size = head.word
        if rest[:1] and rest[0].word == "whole":
            rest = rest[1:]
        if not rest:
            return ParsedPortion(size, size, "")
        head, rest = rest[0], rest[1:]
        if head.kind != "count":
            return None
    whole_item = normalize_unit(head.word) in item_names
    if rest and _continues_name(rest[0]):
        if normalize_unit(f"{head.word} {rest[0].word}") not in item_names:
            return None
        whole_item, rest = True, rest[1:]
    qualifier = []
    for token in rest:
        if size is None and token.kind == "size":
            size = token.word
        else:
            qualifier.append(token)
    unit = (size or "each") if whole_item else normalize_unit(head.word)
    return ParsedPortion(unit, size, _qualifier(qualifier))


def build_profile(entry: CatalogEntry, portions: Iterable[UsdaPortion]) -> FoodProfile:
    """Pick a density and one weight per unit from a food's USDA portions.

    Count units prefer the medium size, then no size, then large, then
    small. After size, an unqualified portion beats a qualified one (``cup``
    over ``cup, chopped``), and then the lowest ``seq_num`` wins. A whole item
    is keyed by its size, or ``each`` when it has none. The ``each`` weight is
    the ``each_portion`` unit when set, else ``medium``, else an unsized whole
    item. The profile key's ``normalize_unit`` form gets the same weight.
    Density comes from the preferred cup, then tbsp, then tsp portion.

    Args:
        entry: The catalogue entry.
        portions: The SR Legacy portions of ``entry.fdc_id``.

    Returns:
        The profile, valid as ``units.ProfileFacts`` input.

    Raises:
        ValueError: When ``entry.each_portion`` names a unit the portions do
            not weigh.
    """
    item_names = {normalize_unit(name) for name in (entry.profile_key, *entry.aliases)}
    weights: dict[str, list[_Candidate]] = {}
    densities: list[_Candidate] = []
    for portion in portions:
        parsed = parse_modifier(portion.modifier, item_names)
        if parsed is None or portion.amount <= 0 or portion.gram_weight <= 0:
            continue
        grams = portion.gram_weight / portion.amount
        qualified = parsed.qualifier != ""
        weights.setdefault(parsed.unit, []).append(
            _Candidate((_size_rank(parsed.size), qualified, portion.seq_num), grams)
        )
        ml = _VOLUME_ML.get(parsed.unit)
        if ml is not None:
            preference = _rank(_DENSITY_PREFERENCE, parsed.unit)
            densities.append(
                _Candidate((preference, qualified, portion.seq_num), grams / ml)
            )
    unit_grams = {
        unit: _best(options).quantize(_GRAMS) for unit, options in weights.items()
    }
    each = _each_grams(entry, unit_grams)
    if each is not None:
        unit_grams.update({"each": each, normalize_unit(entry.profile_key): each})
    return FoodProfile(
        profile_key=entry.profile_key,
        density=_best(densities).quantize(_G_PER_ML) if densities else None,
        unit_grams=dict(sorted(unit_grams.items())),
        source_ref=f"fdc:{entry.fdc_id}",
        aliases=entry.aliases,
    )


def render_seed_sql(profiles: Sequence[FoodProfile]) -> str:
    """Render the seed migration for ``profiles``.

    The output is deterministic, with profiles and aliases sorted by key. Each
    profile is upserted, but an existing row whose source is not ``usda``
    (a manual or LLM-filled profile) is left unchanged. An existing alias moves
    to the seeded profile only while it points at a ``usda`` profile. Every
    profile key is also seeded as an alias of itself, so one alias join
    resolves both.

    Args:
        profiles: The profiles to seed; at least one.

    Returns:
        The SQL text of the migration.

    Raises:
        ValueError: When ``profiles`` is empty.
    """
    if not profiles:
        raise ValueError("render_seed_sql needs at least one profile")
    ordered = sorted(profiles, key=lambda profile: profile.profile_key)
    profile_rows = ",\n".join(
        f"    ({_sql_text(p.profile_key)}, {_sql_number(p.g_per_ml)}, "
        f"{_sql_text(_json_object(p.unit_grams))}::jsonb, "
        f"'usda', {_sql_text(p.source_ref)})"
        for p in ordered
    )
    aliases = sorted(
        (alias, p.profile_key) for p in ordered for alias in (p.profile_key, *p.aliases)
    )
    alias_rows = ",\n".join(
        f"    ({_sql_text(alias)}, {_sql_text(key)})" for alias, key in aliases
    )
    return f"""\
-- Generated by scripts/import_food_profiles.py; do not edit.
--
-- Source: USDA FoodData Central SR Legacy (April 2018), public domain (CC0).
-- To change a profile or alias, edit backend/scripts/data/food_profile_catalog.csv
-- and run the script into a new migration. Profiles whose source is not 'usda'
-- (manual or LLM-filled), and aliases that point at them, are never overwritten.
-- Removing an alias needs a hand-written migration.

INSERT INTO public.food_profiles (profile_key, g_per_ml, unit_grams, source, source_ref)
VALUES
{profile_rows}
ON CONFLICT (profile_key) DO UPDATE
    SET g_per_ml = EXCLUDED.g_per_ml,
        unit_grams = EXCLUDED.unit_grams,
        source_ref = EXCLUDED.source_ref
    WHERE public.food_profiles.source = 'usda';

INSERT INTO public.food_profile_aliases (alias_key, profile_key)
VALUES
{alias_rows}
ON CONFLICT (alias_key) DO UPDATE
    SET profile_key = EXCLUDED.profile_key
    WHERE EXISTS (
        SELECT FROM public.food_profiles p
        WHERE p.profile_key = public.food_profile_aliases.profile_key
          AND p.source = 'usda'
    );
"""


def _catalog_entry(row: Mapping[str, str]) -> CatalogEntry:
    profile_key = row["profile_key"]
    aliases = tuple(sorted({alias for alias in row["aliases"].split("|") if alias}))
    for name, label in ((profile_key, "profile_key"), *((a, "alias") for a in aliases)):
        if name == "" or name != _food_name_key(name):
            raise ValueError(f"{label} {name!r} must be lowercase with single spaces")
    return CatalogEntry(
        profile_key=profile_key,
        fdc_id=int(row["fdc_id"]),
        usda_description=row["usda_description"],
        aliases=tuple(alias for alias in aliases if alias != profile_key),
        each_portion=row["each_portion"] or None,
    )


def _food_name_key(text: str) -> str:
    # Mirrors public.food_name_key in the foods migration, so catalogue keys
    # match the name_key the database computes for household foods.
    return " ".join(text.lower().split())


def _tokenize(text: str) -> list[_Token]:
    words = _WORD.findall(_PARENTHETICAL.sub(" ", text.casefold()))
    tokens: list[_Token] = []
    while words:
        # Two-word sizes and units ("extra large", "fl oz") are one token.
        pair = _Token(" ".join(words[:2]), _kind(" ".join(words[:2])))
        if len(words) > 1 and pair.kind in ("size", "mass", "volume"):
            tokens.append(pair)
            words = words[2:]
        else:
            word = words.pop(0)
            tokens.append(_Token(word, _kind(word)))
    return tokens


def _kind(word: str) -> _Kind:
    if word == ",":
        return "comma"
    key = normalize_unit(word)
    if key in _SIZES:
        return "size"
    if word in _PRODUCT_PORTIONS or key in _PRODUCT_PORTIONS:
        return "product"
    if key in _MASS:
        return "mass"
    if key in _VOLUME_ML:
        return "volume"
    return "count"


def _continues_name(token: _Token) -> bool:
    return (
        token.kind not in ("size", "comma")
        and token.word not in _QUALIFIER_LEADS
        and not token.word[0].isdigit()
    )


def _qualifier(tokens: Iterable[_Token]) -> str:
    return " ".join(token.word for token in tokens if token.kind != "comma")


def _size_rank(size: str | None) -> int:
    return 1 if size is None else 2 * _SIZES.index(size)


def _rank(preference: Sequence[str], value: str) -> int:
    return preference.index(value) if value in preference else len(preference)


def _best(candidates: Sequence[_Candidate]) -> Decimal:
    return min(candidates, key=lambda candidate: candidate.rank).grams


def _each_grams(
    entry: CatalogEntry, unit_grams: Mapping[str, Decimal]
) -> Decimal | None:
    if entry.each_portion is None:
        return unit_grams.get("medium", unit_grams.get("each"))
    key = normalize_unit(entry.each_portion)
    if key not in unit_grams:
        raise ValueError(
            f"{entry.profile_key}: each_portion {entry.each_portion!r} is not a "
            f"USDA portion; choose one of {', '.join(sorted(unit_grams))}"
        )
    return unit_grams[key]


def _json_object(values: Mapping[str, Decimal]) -> str:
    return (
        "{"
        + ", ".join(f"{json.dumps(k)}: {_number(v)}" for k, v in sorted(values.items()))
        + "}"
    )


def _number(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _sql_number(value: Decimal | None) -> str:
    return "NULL" if value is None else _number(value)


def _sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"
