"""The food profile import command, run on the recorded SR Legacy fixture."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

from scripts import import_food_profiles
from scripts.import_food_profiles import download_usda, main

FIXTURES = Path(__file__).parent / "fixtures" / "usda_sr_legacy"


def test_writes_the_seed_and_reports_gaps(tmp_path, capsys):
    output = tmp_path / "seed.sql"
    args = [
        "--usda-dir",
        str(FIXTURES),
        "--catalog",
        str(FIXTURES / "food_profile_catalog.csv"),
    ]
    assert main([*args, "--output", str(output)]) == 0
    assert "('basmati rice', 'rice')" in output.read_text()
    report = capsys.readouterr().out
    assert "No whole-item (each) weight (4):" in report
    assert "garlic [clove, cup, tsp]" in report


def test_description_mismatch_fails_without_writing(tmp_path, capsys):
    catalog = tmp_path / "catalog.csv"
    catalog.write_text(
        "profile_key,fdc_id,usda_description,aliases,each_portion\n"
        'rice,169230,"Rice, white",,\n'
    )
    output = tmp_path / "seed.sql"
    code = main(
        [
            "--usda-dir",
            str(FIXTURES),
            "--catalog",
            str(catalog),
            "--output",
            str(output),
        ]
    )
    assert code == 1
    assert not output.exists()
    assert "fdc 169230 is 'Garlic, raw'" in capsys.readouterr().err


def test_refuses_to_overwrite_an_existing_migration(tmp_path, capsys):
    output = tmp_path / "seed.sql"
    output.write_text("-- applied\n")
    code = main(
        [
            "--usda-dir",
            str(FIXTURES),
            "--catalog",
            str(FIXTURES / "food_profile_catalog.csv"),
            "--output",
            str(output),
        ]
    )
    assert code == 1
    assert output.read_text() == "-- applied\n"
    assert "already exists" in capsys.readouterr().err


def sr_legacy_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        for name in ("food.csv", "food_portion.csv"):
            bundle.write(FIXTURES / name, f"FoodData_Central_sr_legacy/{name}")
    return buffer.getvalue()


class BrokenStream(io.BytesIO):
    def read(self, size=-1):
        if self.tell() > 1000:
            raise ConnectionResetError("connection dropped")
        return super().read(min(size, 500) if size and size > 0 else 500)


def test_an_interrupted_download_leaves_no_csv_behind(tmp_path, monkeypatch):
    target = tmp_path / "usda"
    monkeypatch.setattr(
        import_food_profiles.urllib.request,
        "urlopen",
        lambda url, timeout: BrokenStream(sr_legacy_zip()),
    )
    with pytest.raises(ConnectionResetError):
        download_usda(target)
    assert not target.exists() or list(target.iterdir()) == []

    monkeypatch.setattr(
        import_food_profiles.urllib.request,
        "urlopen",
        lambda url, timeout: io.BytesIO(sr_legacy_zip()),
    )
    assert download_usda(target) == target
    assert sorted(path.name for path in target.iterdir()) == [
        "food.csv",
        "food_portion.csv",
    ]
    assert (target / "food.csv").read_bytes() == (FIXTURES / "food.csv").read_bytes()
