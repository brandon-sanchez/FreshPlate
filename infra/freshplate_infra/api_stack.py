"""The Lambda function that serves the API, its Function URL and its logs."""

from aws_cdk import ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack
from aws_cdk import aws_ecr as ecr
from aws_cdk import aws_iam as iam
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_logs as logs
from constructs import Construct

from freshplate_infra.registry_stack import LIVE_TAG

# Covers an image endpoint's provider call, up to the backend's
# image_generation_timeout_seconds (120 s by default), plus its store calls.
# An invocation cut short there loses a generation OpenAI already billed.
_TIMEOUT = Duration.seconds(150)
# Lambda gives CPU in proportion to memory. 2 GB gives a cold start enough
# CPU to import the AI libraries quickly, and the free tier's 400,000 GB-s a
# month still covers about 55 hours of requests.
_MEMORY_MB = 2048


class ApiStack(Stack):
    """The API as a Lambda function behind a public Function URL.

    The URL takes no AWS signature, because the API checks each caller's
    Supabase JWT itself, as it does locally.

    The function's configuration names the repository's ``live`` image. The
    deploy workflow updates the function's code directly and moves ``live``
    to each image that passes ``/health``, so a function CloudFormation
    creates again starts on the last healthy image.
    """

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        repository_name: str,
        function_name: str,
        parameter_path: str,
        **kwargs,
    ) -> None:
        """Define the function, its role, its log group and its URL.

        Args:
            scope: The CDK app.
            construct_id: The stack name.
            repository_name: Name of the ECR repository holding the
                ``live`` image.
            function_name: Name of the Lambda function.
            parameter_path: Parameter Store path the API loads its settings
                from at start, such as ``/freshplate/prod``.
            **kwargs: Passed to ``Stack``, such as ``env``.
        """
        super().__init__(scope, construct_id, **kwargs)

        log_group = logs.LogGroup(
            self,
            "ApiLogs",
            retention=logs.RetentionDays.TWO_WEEKS,
            removal_policy=RemovalPolicy.DESTROY,
        )
        role = iam.Role(
            self,
            "ApiRole",
            description="Runs the FreshPlate API function",
            assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"),
        )
        log_group.grant_write(role)
        # SecureString values use the AWS managed aws/ssm key, whose key
        # policy already lets every role in the account decrypt through SSM.
        role.add_to_policy(
            iam.PolicyStatement(
                actions=["ssm:GetParametersByPath"],
                resources=[
                    self.format_arn(
                        service="ssm",
                        resource="parameter",
                        resource_name=parameter_path.strip("/"),
                        arn_format=ArnFormat.SLASH_RESOURCE_NAME,
                    )
                ],
            )
        )

        function = lambda_.DockerImageFunction(
            self,
            "Api",
            function_name=function_name,
            description="FreshPlate FastAPI backend",
            code=lambda_.DockerImageCode.from_ecr(
                ecr.Repository.from_repository_name(self, "ApiImages", repository_name),
                tag_or_digest=LIVE_TAG,
            ),
            architecture=lambda_.Architecture.ARM_64,
            memory_size=_MEMORY_MB,
            timeout=_TIMEOUT,
            role=role,
            log_group=log_group,
            environment={"FRESHPLATE_PARAMETER_PATH": parameter_path},
        )
        url = function.add_function_url(auth_type=lambda_.FunctionUrlAuthType.NONE)

        CfnOutput(
            self,
            "ApiUrl",
            value=url.url,
            description="Set as EXPO_PUBLIC_API_URL in mobile/.env.",
        )
