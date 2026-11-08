"""Generate the food profile seed migration from USDA FoodData Central.

Usage:
    cd backend
    venv/bin/python -m scripts.import_food_profiles \
        --output ../supabase/migrations/<timestamp>_seed_food_profiles.sql

The script reads the catalogue in ``scripts/data/food_profile_catalog.csv``,
builds one profile per row from USDA SR Legacy portions, and writes the seed
migration. Without ``--usda-dir`` it downloads the SR Legacy CSV zip (about
6 MB, public domain, no API key) and keeps the two CSVs it reads in
``backend/.local/usda-sr-legacy``, which git ignores, for later runs.

It prints a report of profiles with no density, an implausible density that
was not seeded, or no whole-item weight. Review it when editing the
catalogue's ``each_portion`` column. It exits with an error, writing nothing,
when the catalogue is invalid, a row's ``fdc_id`` is missing from SR Legacy
or its ``usda_description`` does not match, or ``--output`` already exists.

``--output`` is required because a seed migration that has been applied must
never change, so each catalogue change writes a new, later migration file. The
upserts make rerunning the whole catalogue safe. They never touch a manual or
LLM-filled profile or an alias that points at one. The seed only adds and
updates rows, so removing an alias or a profile from the catalogue needs a
hand-written migration that deletes it.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from app.inventory.usda_profiles import (
    FoodProfile,
    build_profiles,
    read_catalog,
    read_usda,
    render_seed_sql,
)

_BACKEND = Path(__file__).resolve().parents[1]
_USDA_ZIP_URL = "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip"
_DEFAULT_CATALOG = _BACKEND / "scripts/data/food_profile_catalog.csv"
_DEFAULT_USDA_DIR = _BACKEND / ".local/usda-sr-legacy"
_USDA_FILES = ("food.csv", "food_portion.csv")


def download_usda(directory: Path) -> Path:
    """Download SR Legacy's ``food.csv`` and ``food_portion.csv`` if absent.

    Downloads the SR Legacy zip to a temporary file and extracts only the two
    CSVs the importer reads. Each CSV is written under a temporary name and
    renamed into place once complete, so an interrupted run never leaves a
    truncated CSV that a later run would reuse. Does nothing when both are
    already present.

    Args:
        directory: Where the CSVs are kept; created if missing.

    Returns:
        ``directory``.

    Raises:
        urllib.error.URLError: When the download fails.
        KeyError: When the zip lacks one of the CSVs.
    """
    if all((directory / name).exists() for name in _USDA_FILES):
        return directory
    directory.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {_USDA_ZIP_URL}")
    with tempfile.TemporaryFile() as archive:
        with urllib.request.urlopen(_USDA_ZIP_URL, timeout=120) as response:
            shutil.copyfileobj(response, archive)
        with zipfile.ZipFile(archive) as bundle:
            members = {Path(member).name: member for member in bundle.namelist()}
            for name in _USDA_FILES:
                partial = directory / f"{name}.partial"
                try:
                    with (
                        bundle.open(members[name]) as source,
                        partial.open("wb") as out,
                    ):
                        shutil.copyfileobj(source, out)
                    partial.replace(directory / name)
                finally:
                    partial.unlink(missing_ok=True)
    return directory


def main(argv: list[str] | None = None) -> int:
    """Build the profiles, print the report and write the seed migration.

    Args:
        argv: Command-line arguments; ``sys.argv[1:]`` when None.

    Returns:
        0 on success, or 1 when ``--output`` already exists or the catalogue is
        invalid or does not match SR Legacy, in which case nothing is written.

    Side effects:
        May download the SR Legacy CSVs (see ``download_usda``), creates the
        ``--output`` file and prints the report to stdout.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--usda-dir", type=Path, help="extracted SR Legacy CSV directory"
    )
    parser.add_argument("--catalog", type=Path, default=_DEFAULT_CATALOG)
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="new seed migration file to write",
    )
    args = parser.parse_args(argv)
    if args.output.exists():
        print(
            f"{args.output} already exists; write each catalogue change to a new "
            "migration file",
            file=sys.stderr,
        )
        return 1

    usda = read_usda(args.usda_dir or download_usda(_DEFAULT_USDA_DIR))
    try:
        profiles = build_profiles(read_catalog(args.catalog), usda)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    with args.output.open("x") as out:
        out.write(render_seed_sql(profiles))
    _print_report(profiles)
    print(f"Wrote {len(profiles)} profiles to {args.output}")
    return 0


def _print_report(profiles: list[FoodProfile]) -> None:
    sections = {
        "No density": [p.profile_key for p in profiles if p.density is None],
        "Implausible density, not seeded": [
            f"{p.profile_key} ({p.density})"
            for p in profiles
            if p.density is not None and p.g_per_ml is None
        ],
        "No whole-item (each) weight": [
            f"{p.profile_key} [{', '.join(p.unit_grams) or 'no portions'}]"
            for p in profiles
            if "each" not in p.unit_grams
        ],
    }
    for title, lines in sections.items():
        print(f"{title} ({len(lines)}):", *lines, sep="\n  ")


if __name__ == "__main__":
    raise SystemExit(main())
