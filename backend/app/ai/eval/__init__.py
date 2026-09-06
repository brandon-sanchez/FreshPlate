"""Deterministic scorers shared by the product path and local evals."""

from app.ai.eval.judge import JudgeResult, judge_recipe
from app.ai.eval.scorers import ingredient_coverage_percent

__all__ = ["JudgeResult", "ingredient_coverage_percent", "judge_recipe"]
