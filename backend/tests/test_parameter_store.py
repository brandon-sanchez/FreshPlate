from collections.abc import Iterator

import boto3
import pytest
from botocore.stub import Stubber

from app.core.parameter_store import (
    PARAMETER_PATH_VARIABLE,
    ParameterStoreError,
    load_parameters_into,
)

_PATH = "/freshplate/prod"


@pytest.fixture
def ssm() -> Iterator[tuple[object, Stubber]]:
    client = boto3.client(
        "ssm",
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )
    with Stubber(client) as stubber:
        yield client, stubber
        stubber.assert_no_pending_responses()


def _page(names_and_values: dict[str, str], next_token: str | None = None) -> dict:
    page: dict = {
        "Parameters": [
            {"Name": f"{_PATH}/{name}", "Value": value, "Type": "SecureString"}
            for name, value in names_and_values.items()
        ]
    }
    if next_token:
        page["NextToken"] = next_token
    return page


def _expect(stubber: Stubber, page: dict, next_token: str | None = None) -> None:
    params = {"Path": _PATH, "Recursive": False, "WithDecryption": True}
    if next_token:
        params["NextToken"] = next_token
    stubber.add_response("get_parameters_by_path", page, params)


def test_copies_every_parameter_under_the_path_by_its_last_segment(ssm) -> None:
    client, stubber = ssm
    _expect(stubber, _page({"GEMINI_API_KEY": "gemini"}, next_token="more"))
    _expect(stubber, _page({"SUPABASE_URL": "https://x.supabase.co"}), "more")
    environ = {PARAMETER_PATH_VARIABLE: f"{_PATH}/"}

    loaded = load_parameters_into(environ, client=client)

    assert loaded == ["GEMINI_API_KEY", "SUPABASE_URL"]
    assert environ["GEMINI_API_KEY"] == "gemini"
    assert environ["SUPABASE_URL"] == "https://x.supabase.co"


def test_keeps_a_variable_the_environment_already_sets(ssm) -> None:
    client, stubber = ssm
    _expect(stubber, _page({"DEBUG": "true", "GEMINI_API_KEY": "gemini"}))
    environ = {PARAMETER_PATH_VARIABLE: _PATH, "DEBUG": "false"}

    loaded = load_parameters_into(environ, client=client)

    assert loaded == ["GEMINI_API_KEY"]
    assert environ["DEBUG"] == "false"


def test_does_nothing_without_a_configured_path(ssm) -> None:
    client, _ = ssm
    environ: dict[str, str] = {}

    assert load_parameters_into(environ, client=client) == []
    assert environ == {}


@pytest.mark.parametrize("name", ["gemini_key", "AWS_REGION", "LAMBDA_TASK_ROOT"])
def test_refuses_a_name_that_is_not_an_app_setting(ssm, name: str) -> None:
    client, stubber = ssm
    _expect(stubber, _page({name: "value"}))
    environ = {PARAMETER_PATH_VARIABLE: _PATH}

    with pytest.raises(ParameterStoreError, match=name):
        load_parameters_into(environ, client=client)
    assert set(environ) == {PARAMETER_PATH_VARIABLE}


def test_reports_a_failed_read_without_any_value(ssm) -> None:
    client, stubber = ssm
    stubber.add_client_error(
        "get_parameters_by_path", service_error_code="AccessDeniedException"
    )
    environ = {PARAMETER_PATH_VARIABLE: _PATH}

    with pytest.raises(ParameterStoreError, match="AccessDeniedException"):
        load_parameters_into(environ, client=client)
