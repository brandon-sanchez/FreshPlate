"""Tests for the smoke check's offline deprecation-table assertion."""

from __future__ import annotations

import pytest

from scripts.smoke_gemini import _assert_model_has_no_shutdown


def test_deprecation_check_accepts_current_model_without_shutdown() -> None:
    html = """
    <table>
      <tr><td><code>gemini-3.6-flash</code></td><td>No shutdown date announced</td></tr>
    </table>
    """

    _assert_model_has_no_shutdown(html, "gemini-3.6-flash")


@pytest.mark.parametrize(
    "html",
    [
        "<tr><td><code>gemini-3.6-flash</code></td><td>October 1, 2026</td></tr>",
        (
            "<tr><td><code>gemini-2.0-flash</code></td>"
            "<td>No shutdown date announced</td></tr>"
        ),
    ],
)
def test_deprecation_check_rejects_missing_or_scheduled_model(html: str) -> None:
    with pytest.raises(RuntimeError):
        _assert_model_has_no_shutdown(html, "gemini-3.6-flash")
