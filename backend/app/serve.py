"""Start the API server, loading deployed settings from Parameter Store first.

The container image runs ``python -m app.serve``. Settings are loaded before
uvicorn imports ``app.main``, because ``app.core.config`` reads the
environment once at import.
"""

import os

import uvicorn

from app.core.parameter_store import load_parameters_into

_DEFAULT_PORT = 8080


def main() -> None:
    """Load Parameter Store settings, then serve the API on ``PORT``.

    Loads nothing when ``FRESHPLATE_PARAMETER_PATH`` is unset, as in local
    runs. Serves on all interfaces, on ``PORT`` or 8080.

    Raises:
        ParameterStoreError: The settings could not be loaded. The process
            exits before serving, so a deploy's health check fails.
    """
    load_parameters_into(os.environ)
    port = int(os.environ.get("PORT", _DEFAULT_PORT))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
