"""Assemble the FreshPlate stacks and the cdk-nag checks that guard them."""

import os

import aws_cdk as cdk
from cdk_nag import AwsSolutionsChecks

from freshplate_infra.api_stack import ApiStack
from freshplate_infra.registry_stack import RegistryStack

_GITHUB_REPOSITORY = "brandon-sanchez/FreshPlate"
_FUNCTION_NAME = "freshplate-api"
_REPOSITORY_NAME = "freshplate-api"
_PARAMETER_PATH = "/freshplate/prod"


def build_app(app: cdk.App) -> cdk.App:
    """Add the registry and API stacks to ``app`` and check them with cdk-nag.

    The stacks deploy to the account and region of the caller's AWS
    credentials. Set the ``github_oidc_provider_arn`` context value when the
    account already has a GitHub OIDC provider, since an account holds only
    one per URL.

    Args:
        app: The CDK app to add the stacks to.

    Returns:
        ``app``, for chaining into ``synth``.
    """
    env = cdk.Environment(
        account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
        region=os.environ.get("CDK_DEFAULT_REGION"),
    )
    RegistryStack(
        app,
        "FreshPlateRegistry",
        repository_name=_REPOSITORY_NAME,
        function_name=_FUNCTION_NAME,
        github_repository=_GITHUB_REPOSITORY,
        github_oidc_provider_arn=app.node.try_get_context("github_oidc_provider_arn"),
        env=env,
    )
    ApiStack(
        app,
        "FreshPlateApi",
        repository_name=_REPOSITORY_NAME,
        function_name=_FUNCTION_NAME,
        parameter_path=_PARAMETER_PATH,
        env=env,
    )
    cdk.Validations.of(app).add_plugins(AwsSolutionsChecks(app, verbose=True))
    return app
