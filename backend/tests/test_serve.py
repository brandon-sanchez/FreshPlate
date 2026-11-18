import subprocess
import sys
from pathlib import Path

import uvicorn

from app import serve
from app.core.parameter_store import PARAMETER_PATH_VARIABLE

_BACKEND = Path(__file__).parents[1]


def test_importing_the_entry_point_leaves_settings_unread() -> None:
    check = (
        "import sys, app.serve; "
        "sys.exit('app.core.config' in sys.modules or 'app.main' in sys.modules)"
    )

    result = subprocess.run([sys.executable, "-c", check], cwd=_BACKEND)

    assert result.returncode == 0


def test_serves_the_api_on_the_configured_port(monkeypatch) -> None:
    calls: list[tuple[tuple, dict]] = []
    monkeypatch.setattr(
        uvicorn, "run", lambda *args, **kwargs: calls.append((args, kwargs))
    )
    monkeypatch.setenv("PORT", "9123")
    monkeypatch.delenv(PARAMETER_PATH_VARIABLE, raising=False)

    serve.main()

    assert calls == [(("app.main:app",), {"host": "0.0.0.0", "port": 9123})]
