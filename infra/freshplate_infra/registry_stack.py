"""Image registry and the GitHub Actions role that deploys the API."""

from aws_cdk import Acknowledgment, ArnFormat, CfnOutput, Duration, Stack, Validations
from aws_cdk import aws_ecr as ecr
from aws_cdk import aws_iam as iam
from constructs import Construct

_GITHUB_OIDC_HOST = "token.actions.githubusercontent.com"
LIVE_TAG = "live"
"""Image tag the deploy workflow moves to each image that passes /health."""
# At about 170 MB compressed each, two images fit ECR's 500 MB free tier.
_KEPT_NEWEST_IMAGES = 2


class RegistryStack(Stack):
    """The ECR repository for API images and the role GitHub deploys with.

    The registry lives apart from the function because the function can only
    be created once its first image is in the repository.
    """

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        repository_name: str,
        function_name: str,
        github_repository: str,
        github_oidc_provider_arn: str | None = None,
        **kwargs,
    ) -> None:
        """Define the repository, the GitHub OIDC provider and the deploy role.

        Args:
            scope: The CDK app.
            construct_id: The stack name.
            repository_name: Name of the ECR repository.
            function_name: Name of the Lambda function the role may update.
            github_repository: ``owner/name`` of the only repository whose
                ``main`` branch may assume the role.
            github_oidc_provider_arn: ARN of the account's GitHub OIDC
                provider, when one exists. ``None`` creates it.
            **kwargs: Passed to ``Stack``, such as ``env``.
        """
        super().__init__(scope, construct_id, **kwargs)

        repository = ecr.Repository(
            self,
            "ApiImages",
            repository_name=repository_name,
            image_scan_on_push=True,
            image_tag_mutability=ecr.TagMutability.IMMUTABLE_WITH_EXCLUSION,
            image_tag_mutability_exclusion_filters=[
                ecr.ImageTagMutabilityExclusionFilter.wildcard(LIVE_TAG)
            ],
            lifecycle_rules=[
                # A rule never expires an image a higher-priority rule
                # selected, so the image the function runs is never deleted.
                ecr.LifecycleRule(
                    rule_priority=1,
                    description="Keep the image the function runs.",
                    tag_status=ecr.TagStatus.TAGGED,
                    tag_prefix_list=[LIVE_TAG],
                    max_image_count=1,
                ),
                # A lower-priority rule still counts the images a higher one
                # selected, so `live` is one of the newest images it keeps.
                ecr.LifecycleRule(
                    rule_priority=2,
                    description="Keep the two newest images, for rollback.",
                    tag_status=ecr.TagStatus.ANY,
                    max_image_count=_KEPT_NEWEST_IMAGES,
                ),
            ],
        )

        function_arn = self.format_arn(
            service="lambda",
            resource="function",
            resource_name=function_name,
            arn_format=ArnFormat.COLON_RESOURCE_NAME,
        )
        repository.add_to_resource_policy(
            iam.PolicyStatement(
                principals=[iam.ServicePrincipal("lambda.amazonaws.com")],
                actions=["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
                conditions={"ArnLike": {"aws:SourceArn": function_arn}},
            )
        )

        deploy_role = iam.Role(
            self,
            "DeployRole",
            role_name="freshplate-github-deploy",
            description=f"GitHub Actions deploys of {github_repository} main",
            assumed_by=iam.WebIdentityPrincipal(
                self._github_provider_arn(github_oidc_provider_arn),
                conditions={
                    "StringEquals": {
                        f"{_GITHUB_OIDC_HOST}:aud": "sts.amazonaws.com",
                        f"{_GITHUB_OIDC_HOST}:sub": (
                            f"repo:{github_repository}:ref:refs/heads/main"
                        ),
                    }
                },
            ),
            max_session_duration=Duration.hours(1),
        )
        repository.grant_pull_push(deploy_role)
        deploy_role.add_to_policy(
            iam.PolicyStatement(
                actions=[
                    "lambda:GetFunction",
                    "lambda:GetFunctionUrlConfig",
                    "lambda:UpdateFunctionCode",
                ],
                resources=[function_arn],
            )
        )
        Validations.of(deploy_role).acknowledge(
            Acknowledgment(
                id="AwsSolutions-IAM5[Resource::*]",
                reason="ecr:GetAuthorizationToken supports only the * resource.",
            )
        )

        CfnOutput(
            self,
            "DeployRoleArn",
            value=deploy_role.role_arn,
            description="Set as the AWS_DEPLOY_ROLE_ARN repository variable.",
        )

    def _github_provider_arn(self, existing_arn: str | None) -> str:
        if existing_arn:
            return existing_arn
        provider = iam.OidcProviderNative(
            self,
            "GitHubOidc",
            url=f"https://{_GITHUB_OIDC_HOST}",
            client_ids=["sts.amazonaws.com"],
        )
        return provider.oidc_provider_arn
