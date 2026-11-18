import json
from pathlib import Path

import aws_cdk as cdk
import pytest
from aws_cdk.assertions import Match, Template

from freshplate_infra.app import build_app

_OIDC = "token.actions.githubusercontent.com"
_SUB = "repo:brandon-sanchez/FreshPlate:ref:refs/heads/main"


_ROOT = Path(__file__).parents[2]
_FLAGS = json.loads((_ROOT / "infra" / "cdk.json").read_text())["context"]


def _app(**context) -> cdk.App:
    return build_app(cdk.App(context={**_FLAGS, **context}))


def _templates(**context) -> tuple[Template, Template]:
    app = _app(**context)
    registry, api = (
        app.node.find_child(name) for name in ("FreshPlateRegistry", "FreshPlateApi")
    )
    return Template.from_stack(registry), Template.from_stack(api)


@pytest.fixture(scope="module")
def templates() -> tuple[Template, Template]:
    return _templates()


def _policy_statements(template: Template, role_logical_id_prefix: str) -> list[dict]:
    statements: list[dict] = []
    for policy in template.find_resources("AWS::IAM::Policy").values():
        roles = json.dumps(policy["Properties"]["Roles"])
        if role_logical_id_prefix in roles:
            statements += policy["Properties"]["PolicyDocument"]["Statement"]
    return statements


def test_repository_keeps_commit_tags_immutable_and_the_live_image(templates) -> None:
    registry, _ = templates
    registry.has_resource_properties(
        "AWS::ECR::Repository",
        {
            "RepositoryName": "freshplate-api",
            "ImageScanningConfiguration": {"ScanOnPush": True},
            "ImageTagMutability": "IMMUTABLE_WITH_EXCLUSION",
            "ImageTagMutabilityExclusionFilters": [
                {
                    "ImageTagMutabilityExclusionFilterType": "WILDCARD",
                    "ImageTagMutabilityExclusionFilterValue": "live",
                }
            ],
        },
    )
    repository = next(iter(registry.find_resources("AWS::ECR::Repository").values()))
    rules = json.loads(
        repository["Properties"]["LifecyclePolicy"]["LifecyclePolicyText"]
    )["rules"]
    assert rules[0]["selection"]["tagPrefixList"] == ["live"]
    assert rules[-1]["selection"]["tagStatus"] == "any"


def test_only_the_api_function_may_pull_images(templates) -> None:
    registry, _ = templates
    repository = next(iter(registry.find_resources("AWS::ECR::Repository").values()))
    [statement] = repository["Properties"]["RepositoryPolicyText"]["Statement"]
    assert statement["Principal"] == {"Service": "lambda.amazonaws.com"}
    assert ":function:freshplate-api" in json.dumps(statement["Condition"])


def test_deploy_role_trusts_only_this_repository_on_main(templates) -> None:
    registry, _ = templates
    registry.resource_count_is("AWS::IAM::OIDCProvider", 1)
    registry.has_resource_properties(
        "AWS::IAM::Role",
        {
            "AssumeRolePolicyDocument": {
                "Statement": [
                    Match.object_like(
                        {
                            "Action": "sts:AssumeRoleWithWebIdentity",
                            "Condition": {
                                "StringEquals": {
                                    f"{_OIDC}:aud": "sts.amazonaws.com",
                                    f"{_OIDC}:sub": _SUB,
                                }
                            },
                        }
                    )
                ]
            }
        },
    )


def test_deploy_role_can_only_push_the_image_and_update_the_function(templates) -> None:
    registry, _ = templates
    statements = _policy_statements(registry, "DeployRole")
    lambda_statements = [
        s for s in statements if "lambda:UpdateFunctionCode" in s["Action"]
    ]
    assert len(lambda_statements) == 1
    assert set(lambda_statements[0]["Action"]) == {
        "lambda:GetFunction",
        "lambda:GetFunctionUrlConfig",
        "lambda:UpdateFunctionCode",
    }
    assert ":function:freshplate-api" in json.dumps(lambda_statements[0]["Resource"])
    wildcard = [s for s in statements if s["Resource"] == "*"]
    assert [s["Action"] for s in wildcard] == ["ecr:GetAuthorizationToken"]


def test_an_existing_github_provider_is_reused() -> None:
    arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    registry, _ = _templates(github_oidc_provider_arn=arn)
    registry.resource_count_is("AWS::IAM::OIDCProvider", 0)
    assert arn in json.dumps(registry.find_resources("AWS::IAM::Role"))


def test_function_runs_the_live_image_with_its_parameter_path(templates) -> None:
    _, api = templates
    api.has_resource_properties(
        "AWS::Lambda::Function",
        {
            "FunctionName": "freshplate-api",
            "PackageType": "Image",
            "Architectures": ["arm64"],
            "Timeout": 150,
            "Environment": {
                "Variables": {"FRESHPLATE_PARAMETER_PATH": "/freshplate/prod"}
            },
        },
    )
    function = next(iter(api.find_resources("AWS::Lambda::Function").values()))
    image_uri = json.dumps(function["Properties"]["Code"]["ImageUri"])
    assert image_uri.endswith('/freshplate-api:live"]]}')
    assert "FreshPlateRegistry" not in json.dumps(api.to_json())


def test_function_url_is_public_and_needs_both_invoke_permissions(templates) -> None:
    _, api = templates
    api.has_resource_properties("AWS::Lambda::Url", {"AuthType": "NONE"})
    actions = {
        permission["Properties"]["Action"]
        for permission in api.find_resources("AWS::Lambda::Permission").values()
        if permission["Properties"]["Principal"] == "*"
    }
    assert actions == {"lambda:InvokeFunctionUrl", "lambda:InvokeFunction"}


def test_function_reads_only_its_parameter_path_and_writes_its_logs(templates) -> None:
    _, api = templates
    api.has_resource_properties("AWS::Logs::LogGroup", {"RetentionInDays": 14})
    statements = _policy_statements(api, "ApiRole")
    ssm = [s for s in statements if s["Action"] == "ssm:GetParametersByPath"]
    assert len(ssm) == 1
    assert json.dumps(ssm[0]["Resource"]).endswith(':parameter/freshplate/prod"]]}')
    assert not api.find_resources(
        "AWS::IAM::Role", {"Properties": {"ManagedPolicyArns": Match.any_value()}}
    )


def test_cdk_nag_finds_no_unacknowledged_issues(tmp_path) -> None:
    app = build_app(cdk.App(outdir=str(tmp_path), context=_FLAGS))

    app.synth()

    report = json.loads((tmp_path / "validation-report.json").read_text())
    assert report["pluginReports"] == []


def test_deploy_workflow_targets_the_function_and_repository(templates) -> None:
    registry, api = templates
    workflow = (_ROOT / ".github" / "workflows" / "deploy.yml").read_text()
    function = next(iter(api.find_resources("AWS::Lambda::Function").values()))
    repository = next(iter(registry.find_resources("AWS::ECR::Repository").values()))

    assert f"FUNCTION_NAME: {function['Properties']['FunctionName']}\n" in workflow
    assert (
        f"REPOSITORY_NAME: {repository['Properties']['RepositoryName']}\n" in workflow
    )
