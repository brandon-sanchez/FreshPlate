"""Entry point that ``cdk`` runs to synthesize the FreshPlate stacks."""

import aws_cdk as cdk

from freshplate_infra.app import build_app

build_app(cdk.App()).synth()
