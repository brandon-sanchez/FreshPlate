"""The app's own INFO records reach the server log."""

import logging

from app.main import create_app


def test_app_info_records_reach_the_server_log() -> None:
    create_app()
    create_app()

    root = logging.getLogger("freshplate")
    assert logging.getLogger("freshplate.llm.provider").isEnabledFor(logging.INFO)
    assert len(root.handlers) == 1
