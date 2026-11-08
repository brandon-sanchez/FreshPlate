"""USDA SR Legacy portion parsing and food profile building, on recorded rows."""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from app.inventory.units import (
    Approximate,
    FoodFacts,
    ProfileFacts,
    normalize_unit,
    to_stock,
)
from app.inventory.usda_profiles import (
    CatalogEntry,
    FoodProfile,
    ParsedPortion,
    UsdaPortion,
    build_profile,
    build_profiles,
    parse_modifier,
    read_catalog,
    read_usda,
    render_seed_sql,
)

D = Decimal
FIXTURES = Path(__file__).parent / "fixtures" / "usda_sr_legacy"
CUP_ML = D("236.5882365")


@pytest.fixture(scope="module")
def profiles() -> dict[str, FoodProfile]:
    catalog = read_catalog(FIXTURES / "food_profile_catalog.csv")
    return {
        profile.profile_key: profile
        for profile in build_profiles(catalog, read_usda(FIXTURES))
    }


@pytest.mark.parametrize(
    ("modifier", "parsed"),
    [
        ("cup", ParsedPortion("cup", None, "")),
        ("cup, chopped", ParsedPortion("cup", None, "chopped")),
        ("tbsp chopped", ParsedPortion("tbsp", None, "chopped")),
        ("cup (4.86 large eggs)", ParsedPortion("cup", None, "")),
        ("cup, large curd", ParsedPortion("cup", None, "large curd")),
        ("fl oz", ParsedPortion("fl oz", None, "")),
        ("quart", ParsedPortion("qt", None, "")),
        ("cloves", ParsedPortion("clove", None, "")),
        ('medium (2-1/2" dia)', ParsedPortion("medium", "medium", "")),
        ('large whole (3" dia)', ParsedPortion("large", "large", "")),
        ("extra large", ParsedPortion("extra large", "extra large", "")),
        ('head, medium (6" dia)', ParsedPortion("head", "medium", "")),
        ("slice, thin", ParsedPortion("slice", None, "thin")),
        ('potato large (3" to 4-1/4" dia.)', ParsedPortion("potato", "large", "")),
        ("slice raw", ParsedPortion("slice", None, "raw")),
        ("thigh without skin", ParsedPortion("thigh", None, "without skin")),
        ("roll 1 serving", ParsedPortion("roll", None, "1 serving")),
    ],
)
def test_parse_modifier_reads_unit_size_and_qualifier(modifier, parsed):
    assert parse_modifier(modifier) == parsed


@pytest.mark.parametrize(
    "modifier",
    [
        "NLEA serving",
        "serving 1 roll with icing",
        "oz",
        "lb",
        "package (10 oz)",
        "can",
        "container 32 oz",
        "cubic inch",
        "piece",
        "dash",
        "small box (1.5 oz)",
        'mini bagel (2-1/2" dia)',
    ],
)
def test_parse_modifier_skips_product_specific_and_mass_portions(modifier):
    assert parse_modifier(modifier) is None


@pytest.mark.parametrize(
    "modifier",
    [
        "watermelon balls",
        "Italian tomato",
        "hot dog",
        "large rectangular piece or 2 squares",
        'spear tip (2" long or less)',
    ],
)
def test_parse_modifier_skips_compound_item_names(modifier):
    assert parse_modifier(modifier) is None


@pytest.mark.parametrize(
    ("modifier", "parsed"),
    [
        ("hot dog", ParsedPortion("each", None, "")),
        ("potatoes", ParsedPortion("each", None, "")),
        ('Potato large (3" to 4-1/4" dia)', ParsedPortion("large", "large", "")),
        ('medium potato (2" dia)', ParsedPortion("medium", "medium", "")),
        ("potato, baked", ParsedPortion("each", None, "baked")),
    ],
)
def test_parse_modifier_reads_the_foods_own_name_as_one_whole_item(modifier, parsed):
    assert parse_modifier(modifier, {"hot dog", "potato"}) == parsed


def test_a_portion_named_after_the_food_weighs_the_whole_item():
    entry = CatalogEntry("watermelon", 1, "Watermelon, raw", ("watermelons",), "melon")
    portions = [
        UsdaPortion(1, D(1), 'melon (15" long x 7-1/2" dia)', D(4518)),
        UsdaPortion(2, D(10), "watermelon balls", D(122)),
    ]
    profile = build_profile(entry, portions)
    assert profile.unit_grams == {
        "each": D(4518),
        "melon": D(4518),
        "watermelon": D(4518),
    }
    facts = ProfileFacts(unit_grams=profile.unit_grams)
    counted = FoodFacts("each", each_label="watermelon", profile=facts)
    assert to_stock(D(4518), "g", counted) == Approximate(D(1))
    assert to_stock(D(2), "watermelons", FoodFacts("g", profile=facts)) == (
        Approximate(D(9036))
    )


def test_a_fruit_portion_weighs_one_item_only_when_the_catalogue_says_so():
    juice = build_profile(
        CatalogEntry("orange juice", 1, "Orange juice, raw", (), None),
        [UsdaPortion(1, D(1), "fruit yields", D(86))],
    )
    assert juice.unit_grams == {"fruit": D(86)}
    lime = build_profile(
        CatalogEntry("lime", 2, "Limes, raw", (), "fruit"),
        [UsdaPortion(1, D(1), 'fruit (2" dia)', D(67))],
    )
    assert lime.unit_grams["each"] == D(67)


def test_every_profile_with_a_whole_item_weight_is_keyed_by_its_name(profiles):
    for profile in profiles.values():
        name = normalize_unit(profile.profile_key)
        assert profile.unit_grams.get(name) == profile.unit_grams.get("each")


def test_garlic_gets_clove_weight_and_density_from_its_cup(profiles):
    garlic = profiles["garlic"]
    assert garlic.unit_grams["clove"] == D(3)
    assert garlic.unit_grams["cup"] == D(136)
    assert garlic.g_per_ml == (D(136) / CUP_ML).quantize(D("0.0001"))
    assert "each" not in garlic.unit_grams
    assert garlic.source_ref == "fdc:169230"


def test_onion_prefers_medium_sizes_and_unqualified_volumes(profiles):
    onion = profiles["onion"]
    assert onion.unit_grams["each"] == D(110)
    assert onion.unit_grams["large"] == D(150)
    assert onion.unit_grams["small"] == D(70)
    assert onion.unit_grams["slice"] == D(14)
    assert onion.unit_grams["ring"] == D(6)
    # Every onion volume is qualified, so the first cup listed sets density.
    assert onion.unit_grams["cup"] == D(160)
    assert onion.g_per_ml == (D(160) / CUP_ML).quantize(D("0.0001"))


def test_each_portion_override_picks_the_whole_item(profiles):
    assert profiles["egg"].unit_grams["each"] == D(50)
    assert profiles["egg"].unit_grams["medium"] == D(44)
    assert profiles["lettuce"].unit_grams["each"] == D(539)
    assert profiles["lettuce"].unit_grams["leaf"] == D(8)
    assert profiles["tomato"].unit_grams["each"] == D(123)
    assert profiles["cherry tomato"].unit_grams["each"] == D(17)


def test_liquids_and_flour_get_density(profiles):
    assert profiles["milk"].g_per_ml == (D(244) / CUP_ML).quantize(D("0.0001"))
    assert profiles["milk"].unit_grams["fl oz"] == D("30.5")
    assert profiles["all-purpose flour"].unit_grams["cup"] == D(125)
    assert profiles["rice"].aliases == ("basmati rice", "white rice")


def test_every_built_profile_is_valid_converter_input(profiles):
    for profile in profiles.values():
        ProfileFacts(g_per_ml=profile.g_per_ml, unit_grams=profile.unit_grams)


def test_unknown_each_portion_fails_loudly():
    entry = CatalogEntry("garlic", 169230, "Garlic, raw", (), "head")
    with pytest.raises(ValueError, match="each_portion 'head'"):
        build_profile(entry, read_usda(FIXTURES).portions[169230])


@pytest.mark.parametrize("cup_grams", [D(2), D(700)])
def test_out_of_range_density_is_reported_not_seeded(cup_grams):
    profile = build_profile(
        CatalogEntry("odd powder", 1, "Odd powder", (), None),
        [UsdaPortion(1, D(1), "cup", cup_grams)],
    )
    assert profile.density == (cup_grams / CUP_ML).quantize(D("0.0001"))
    assert profile.g_per_ml is None


def test_light_leafy_herbs_keep_their_density():
    dill = build_profile(
        CatalogEntry("dill", 1, "Dill weed, fresh", (), None),
        [UsdaPortion(1, D(1), "cup sprigs", D("8.9"))],
    )
    assert dill.g_per_ml == (D("8.9") / CUP_ML).quantize(D("0.0001"))


def test_build_profiles_lists_every_entry_that_does_not_match_sr_legacy():
    catalog = [
        CatalogEntry("garlic", 169230, "Garlic, raw", (), None),
        CatalogEntry("rice", 169230, "Rice, white", (), None),
        CatalogEntry("ghost", 1, "Nothing", (), None),
    ]
    with pytest.raises(ValueError) as error:
        build_profiles(catalog, read_usda(FIXTURES))
    message = str(error.value)
    assert "rice: fdc 169230 is 'Garlic, raw'" in message
    assert "ghost: fdc 1 is 'missing'" in message
    assert "garlic:" not in message


@pytest.mark.parametrize(
    ("row", "message"),
    [
        ("Rice,1,x,,", "profile_key"),
        ("rice,1,x,White Rice,", "alias"),
        ("rice,1,x,garlic,\ngarlic,2,y,,", "garlic"),
        ("rice,1,x,brown rice,\ngarlic,2,y,brown rice,", "brown rice"),
        ("rice,1,x,,\nrice,2,y,,", "rice"),
    ],
)
def test_read_catalog_rejects_ambiguous_or_unnormalized_keys(tmp_path, row, message):
    path = tmp_path / "catalog.csv"
    path.write_text(
        "profile_key,fdc_id,usda_description,aliases,each_portion\n" + row + "\n"
    )
    with pytest.raises(ValueError, match=message):
        read_catalog(path)


def test_seed_sql_is_sorted_and_guards_non_usda_rows(profiles):
    forward = render_seed_sql(list(profiles.values()))
    assert forward == render_seed_sql(list(reversed(profiles.values())))
    assert forward.startswith("-- Generated by scripts/import_food_profiles.py")
    assert "WHERE public.food_profiles.source = 'usda'" in forward
    assert forward.index("'all-purpose flour'") < forward.index("'tomato'")
    assert "('basmati rice', 'rice')" in forward
    assert "('rice', 'rice')" in forward
