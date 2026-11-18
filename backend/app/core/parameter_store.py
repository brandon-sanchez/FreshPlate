"""Load the deployed API's settings from AWS Systems Manager Parameter Store.

On AWS Lambda the API keeps its keys as SecureString parameters under one
path, such as ``/freshplate/prod``. The server entry point copies them into
the process environment before ``app.core.config`` reads it, so the image
and the function configuration never hold a secret.
"""

from __future__ import annotations

import re
from collections.abc import MutableMapping
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

PARAMETER_PATH_VARIABLE = "FRESHPLATE_PARAMETER_PATH"
"""Environment variable naming the Parameter Store path to load, if any."""

_SETTING_NAME = re.compile(r"[A-Z][A-Z0-9_]*")
_RESERVED_PREFIXES = ("AWS_", "LAMBDA_")


class ParameterStoreError(RuntimeError):
    """The settings under the configured path could not be loaded.

    The message names the path or parameter and never includes a value.
    """


def load_parameters_into(
    environ: MutableMapping[str, str], *, client: Any | None = None
) -> list[str]:
    """Copy the parameters under the configured path into ``environ``.

    Reads every parameter directly under the path in
    ``FRESHPLATE_PARAMETER_PATH`` with decryption, and stores each under the
    last segment of its name: ``/freshplate/prod/GEMINI_API_KEY`` becomes
    ``GEMINI_API_KEY``. A variable that ``environ`` already sets keeps its
    value, so the function configuration can override one parameter. Does
    nothing when the path variable is unset or empty.

    Nothing changes in ``environ`` unless every parameter loads.

    Args:
        environ: The environment to update, usually ``os.environ``.
        client: An SSM client. Defaults to one for the region in
            ``AWS_DEFAULT_REGION``, which Lambda sets.

    Returns:
        The names that were set, in the order Parameter Store listed them.

    Raises:
        ParameterStoreError: Parameter Store could not be read, or a
            parameter's name is not an upper-case setting name or starts with
            ``AWS_`` or ``LAMBDA_``.
    """
    path = environ.get(PARAMETER_PATH_VARIABLE, "").rstrip("/")
    if not path:
        return []
    parameters = _read_path(client, path)
    missing = {name: value for name, value in parameters.items() if name not in environ}
    environ.update(missing)
    return list(missing)


def _read_path(client: Any | None, path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        client = client or boto3.client("ssm")
        pages = client.get_paginator("get_parameters_by_path").paginate(
            Path=path, Recursive=False, WithDecryption=True
        )
        for page in pages:
            for parameter in page["Parameters"]:
                values[_setting_name(parameter["Name"])] = parameter["Value"]
    except (BotoCoreError, ClientError) as exc:
        raise ParameterStoreError(
            f"Could not read parameters under {path}: {exc}"
        ) from exc
    return values


def _setting_name(parameter_name: str) -> str:
    name = parameter_name.rsplit("/", 1)[-1]
    if not _SETTING_NAME.fullmatch(name) or name.startswith(_RESERVED_PREFIXES):
        raise ParameterStoreError(
            f"Parameter {parameter_name} must be named after an app setting, "
            "in upper case and not starting with AWS_ or LAMBDA_"
        )
    return name
