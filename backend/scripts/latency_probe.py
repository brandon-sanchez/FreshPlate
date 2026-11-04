"""Measure the recipe batch call across fridges, thinking levels, prompts and models.

Calls live Gemini, so every run costs money. Each invocation appends one JSON
record per run to the results file and prints a one-line summary.

Usage:
    cd backend
    venv/bin/python -m scripts.latency_probe generate --fridge medium --thinking low
    venv/bin/python -m scripts.latency_probe judge --fridge medium --phase 1
    venv/bin/python -m scripts.latency_probe report

Generation runs the production prompt and schema through the same nodes the
feed uses (``analyze_inventory``, ``generate_recipes`` input, ``check_quality``),
but streams the Gemini call so the first byte and the thinking tokens can be
seen. Retrieval is cached per fridge so every config sees the same inspiration.
The meal judge runs once per fridge over every candidate that passed the
inventory check, with the production ``assess_meals`` prompt.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from google.genai import types
from pydantic import BaseModel, ConfigDict, Field

from app.ai.agents.meal_quality import MealAssessment
from app.ai.agents.models import Recipe
from app.ai.agents.nodes import _generation_prompt, analyze_inventory, check_quality
from app.ai.llm.providers import DEFAULT_GEMINI_MODEL, GeminiProvider
from app.ai.prompts.loader import load_prompt
from app.ai.rag.embeddings import EmbeddingClient
from app.ai.rag.retriever import RecipeRetriever
from app.ai.rag.vector_store import RetrievedRecipe, SupabaseVectorStore

RESULTS_DIR = Path(__file__).resolve().parents[2] / "docs" / "recipe-latency-runs"
RUNS_FILE = RESULTS_DIR / "runs.jsonl"
JUDGE_FILE = RESULTS_DIR / "judge.jsonl"
JUDGE_BATCH_FILE = RESULTS_DIR / "judge_batches.jsonl"
BATCH_SIZE = 5
MIN_RECIPES = 3
RETRIEVAL_LIMIT = 5


def _item(
    item_id: str, name: str, quantity: float, unit: str, expires_in: int | None = None
) -> dict[str, Any]:
    expiration = (
        None if expires_in is None else str(date.today() + timedelta(days=expires_in))
    )
    return {
        "id": item_id,
        "name": name,
        "quantity": quantity,
        "unit": unit,
        "expiration_date": expiration,
    }


FRIDGES: dict[str, list[dict[str, Any]]] = {
    "small": [
        _item("i-chicken-breast", "chicken breast", 500, "g", 2),
        _item("i-rice", "jasmine rice", 1000, "g"),
        _item("i-broccoli", "broccoli", 300, "g", 3),
    ],
    "medium": [
        _item("i-chicken", "chicken thighs", 900, "g", 2),
        _item("i-rice", "jasmine rice", 1000, "g"),
        _item("i-spinach", "spinach", 200, "g", 1),
        _item("i-garlic", "garlic", 8, "cloves"),
        _item("i-onion", "yellow onion", 3, "each"),
        _item("i-tomato", "canned diced tomatoes", 2, "can"),
    ],
}
FRIDGES["large"] = [
    *FRIDGES["medium"],
    _item("i-eggs", "eggs", 12, "each", 6),
    _item("i-pasta", "spaghetti", 500, "g"),
    _item("i-cheddar", "cheddar cheese", 200, "g", 10),
    _item("i-pepper", "red bell pepper", 3, "each", 4),
]

THINKING_LEVELS = {
    "default": None,
    "minimal": types.ThinkingLevel.MINIMAL,
    "low": types.ThinkingLevel.LOW,
    "medium": types.ThinkingLevel.MEDIUM,
}


class CountedRecipes(BaseModel):
    """The production response with the batch size enforced by the JSON schema."""

    model_config = ConfigDict(extra="forbid")
    recipes: list[Recipe] = Field(min_length=MIN_RECIPES, max_length=BATCH_SIZE)


def _count_prompt(base: str) -> str:
    return (
        f"Return exactly {BATCH_SIZE} distinct recipes: different dishes, not "
        "variations of one dish. Return fewer only if the inventory truly cannot "
        f"support {BATCH_SIZE} substantial meals, and never fewer than "
        f"{MIN_RECIPES}.\n\n"
        + base.replace(
            f"Batch ceiling: {BATCH_SIZE}", f"Number of recipes to return: {BATCH_SIZE}"
        )
    )


class OpenRecipes(BaseModel):
    """The production response capped at the batch size with no forced minimum."""

    model_config = ConfigDict(extra="forbid")
    recipes: list[Recipe] = Field(min_length=1, max_length=BATCH_SIZE)


def _soft_prompt(base: str) -> str:
    return (
        f"Suggest up to {BATCH_SIZE} distinct, substantial meals. Each recipe is a "
        "separate option the cook chooses between, so every recipe may use the full "
        "listed inventory, including the same main ingredient as another recipe. "
        "Make each one a different dish, not a variation of another. Never pad the "
        "list with thin dishes such as plain rice or a side; return fewer instead.\n\n"
        + base.replace(
            f"Batch ceiling: {BATCH_SIZE}", f"Target number of recipes: {BATCH_SIZE}"
        )
    )


VARIANTS: dict[str, tuple[Any, type[BaseModel] | None]] = {
    "base": (None, None),
    "count": (_count_prompt, CountedRecipes),
    "soft": (_soft_prompt, OpenRecipes),
}


async def _retrieval(fridge: str, usable_terms: list[str]) -> list[dict[str, Any]]:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    cache = RESULTS_DIR / f"retrieval-{fridge}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    async with httpx.AsyncClient() as http:
        retriever = RecipeRetriever(
            EmbeddingClient(), SupabaseVectorStore(http_client=http)
        )
        started = time.monotonic()
        docs = await retriever.search(" ".join(usable_terms), limit=RETRIEVAL_LIMIT)
        elapsed = time.monotonic() - started
    payload = [doc.model_dump(mode="json") for doc in docs]
    cache.write_text(json.dumps(payload, indent=1))
    _append(
        RESULTS_DIR / "retrieval.jsonl",
        {"fridge": fridge, "seconds": round(elapsed, 2), "docs": len(payload)},
    )
    return payload


async def _stream(
    client: Any,
    *,
    model: str,
    prompt: str,
    system: str,
    response_model: type[BaseModel],
    thinking: str,
) -> dict[str, Any]:
    config: dict[str, Any] = {
        "response_mime_type": "application/json",
        "response_json_schema": response_model.model_json_schema(),
        "system_instruction": system,
        "http_options": types.HttpOptions(
            timeout=90_000, retry_options=types.HttpRetryOptions(attempts=1)
        ),
    }
    if THINKING_LEVELS[thinking] is not None:
        config["thinking_config"] = types.ThinkingConfig(
            thinking_level=THINKING_LEVELS[thinking]
        )
    started = time.monotonic()
    first_byte = None
    text = ""
    usage = None
    stream = await client.aio.models.generate_content_stream(
        model=model, contents=prompt, config=types.GenerateContentConfig(**config)
    )
    async for chunk in stream:
        piece = chunk.text or ""
        if piece and first_byte is None:
            first_byte = time.monotonic() - started
        text += piece
        if chunk.usage_metadata:
            usage = chunk.usage_metadata
    return {
        "seconds": round(time.monotonic() - started, 2),
        "first_byte_s": None if first_byte is None else round(first_byte, 2),
        "prompt_tokens": getattr(usage, "prompt_token_count", None),
        "thinking_tokens": getattr(usage, "thoughts_token_count", None) or 0,
        "output_tokens": getattr(usage, "candidates_token_count", None),
        "text": text,
    }


async def generate(args: argparse.Namespace) -> None:
    template = load_prompt("generate_recipes")
    state: dict[str, Any] = {
        "inventory": FRIDGES[args.fridge],
        "preferences": {},
        "batch_ceiling": BATCH_SIZE,
    }
    state.update(analyze_inventory(state))
    state["retrieved_recipes"] = [
        RetrievedRecipe.model_validate(doc)
        for doc in await _retrieval(args.fridge, state["query_terms"])
    ]
    prompt = _generation_prompt(state, state["usable_items"])
    rewrite, response_model = VARIANTS[args.variant]
    response_model = response_model or _production_response_model()
    if rewrite:
        prompt = rewrite(prompt)
    client = GeminiProvider()._get_client()

    for run in range(args.runs):
        record: dict[str, Any] = {
            "run_id": uuid4().hex[:8],
            "phase": args.phase,
            "model": args.model,
            "thinking": args.thinking,
            "variant": args.variant,
            "fridge": args.fridge,
            "items": len(state["usable_items"]),
            "requested": BATCH_SIZE,
        }
        try:
            call = await _stream(
                client,
                model=args.model,
                prompt=prompt,
                system=template.system,
                response_model=response_model,
                thinking=args.thinking,
            )
            text = call.pop("text")
            record.update(call)
            recipes = json.loads(text).get("recipes", [])
            quality = check_quality(
                {"usable_items": state["usable_items"], "generated_recipes": recipes}
            )
            passed = {recipe.title for recipe in quality["valid_recipes"]}
            record.update(
                returned=len(recipes),
                inventory_pass=len(quality["valid_recipes"]),
                inventory_feedback=quality["quality_feedback"],
                steps=[len(recipe.get("steps", [])) for recipe in recipes],
                recipes=recipes,
                inventory_passed_titles=sorted(passed),
            )
        except (
            Exception
        ) as exc:  # the probe records failures instead of stopping the sweep
            record["error"] = f"{type(exc).__name__}: {exc}"[:300]
        _append(RUNS_FILE, record)
        print(_summary(record), flush=True)


def _production_response_model() -> type[BaseModel]:
    from app.ai.agents.models import RecipeGenerationResponse

    return RecipeGenerationResponse


async def judge(args: argparse.Namespace) -> None:
    """Judge every inventory-passing candidate for one fridge in a single call."""
    runs = [
        r
        for r in _read(RUNS_FILE)
        if r["fridge"] == args.fridge and r["phase"] == args.phase and "recipes" in r
    ]
    judged = {(j["run_id"], j["title"]) for j in _read(JUDGE_FILE)}
    candidates: list[tuple[str, Recipe]] = []
    for run in runs:
        for raw in run["recipes"]:
            recipe = Recipe.model_validate(raw)
            if (
                recipe.title in run["inventory_passed_titles"]
                and (run["run_id"], recipe.title) not in judged
            ):
                candidates.append((run["run_id"], recipe))
    if not candidates:
        print("nothing to judge")
        return
    decisions, call = await _assess(args.fridge, [r for _, r in candidates], "default")
    for (run_id, recipe), decision in zip(candidates, decisions, strict=True):
        _append(JUDGE_FILE, {"run_id": run_id, "title": recipe.title, **decision})
    print(
        f"judged {len(candidates)} candidates for {args.fridge} in {call['seconds']} s"
    )


async def judge_batch(args: argparse.Namespace) -> None:
    """Judge one generated batch in one call, the way production reviews it."""
    run = next(r for r in _read(RUNS_FILE) if r["run_id"] == args.run_id)
    recipes = [
        Recipe.model_validate(raw)
        for raw in run["recipes"]
        if raw["title"] in run["inventory_passed_titles"]
    ]
    decisions, call = await _assess(run["fridge"], recipes, args.thinking)
    record = {
        "run_id": run["run_id"],
        "fridge": run["fridge"],
        "variant": run["variant"],
        "judge_thinking": args.thinking,
        "candidates": len(recipes),
        "eligible": sum(d["verdict"] == "eligible" for d in decisions),
        "seconds": call["seconds"],
        "thinking_tokens": call["thinking_tokens"],
        "decisions": [
            {"title": recipe.title, **decision}
            for recipe, decision in zip(recipes, decisions, strict=True)
        ],
    }
    _append(JUDGE_BATCH_FILE, record)
    print(
        f"{run['fridge']} {run['variant']} judge={args.thinking} "
        f"{record['eligible']}/{len(recipes)} eligible in {call['seconds']} s "
        f"(thinking {call['thinking_tokens']})"
    )


async def _assess(
    fridge: str, recipes: list[Recipe], thinking: str
) -> tuple[list[dict[str, str]], dict[str, Any]]:
    state: dict[str, Any] = {"inventory": FRIDGES[fridge], "preferences": {}}
    state.update(analyze_inventory(state))
    payload = {
        "candidates": [
            {"candidate_index": index, "recipe": recipe.model_dump(mode="json")}
            for index, recipe in enumerate(recipes)
        ],
        "inventory": state["usable_items"],
        "preferences": {},
    }
    call = await _stream(
        GeminiProvider()._get_client(),
        model=DEFAULT_GEMINI_MODEL,
        prompt=json.dumps(payload, sort_keys=True, default=str),
        system=load_prompt("assess_meals").system,
        response_model=MealAssessment,
        thinking=thinking,
    )
    by_index = {d["candidate_index"]: d for d in json.loads(call["text"])["decisions"]}
    missing = {"verdict": "missing", "reason": "no decision returned"}
    decisions = [
        {
            "verdict": by_index.get(i, missing)["verdict"],
            "reason": by_index.get(i, missing)["reason"],
        }
        for i in range(len(recipes))
    ]
    return decisions, call


def report(_: argparse.Namespace) -> None:
    verdicts: dict[str, list[str]] = defaultdict(list)
    for decision in _read(JUDGE_FILE):
        verdicts[decision["run_id"]].append(decision["verdict"])
    cells: dict[tuple[Any, ...], list[dict[str, Any]]] = defaultdict(list)
    for run in _read(RUNS_FILE):
        cells[
            (run["phase"], run["model"], run["thinking"], run["variant"], run["fridge"])
        ].append(run)
    print(_row(REPORT_COLUMNS))
    print(_row(["---"] * len(REPORT_COLUMNS)))
    for key in sorted(cells, key=_cell_order):
        runs = cells[key]
        ok = [r for r in runs if "error" not in r]
        eligible = [
            sum(v == "eligible" for v in verdicts.get(r["run_id"], [])) for r in ok
        ]
        judged = all(r["run_id"] in verdicts or r["inventory_pass"] == 0 for r in ok)
        print(
            _row(
                [
                    *key,
                    len(runs),
                    _spread(ok, "first_byte_s"),
                    _spread(ok, "seconds"),
                    _spread(ok, "thinking_tokens"),
                    _spread(ok, "output_tokens"),
                    _list(r["returned"] for r in ok),
                    _list(r["inventory_pass"] for r in ok),
                    _list(eligible) if judged else "pending",
                    len(runs) - len(ok),
                ]
            )
        )


REPORT_COLUMNS = [
    "phase",
    "model",
    "thinking",
    "prompt",
    "fridge",
    "runs",
    "first byte s",
    "call s",
    "thinking tok",
    "output tok",
    "returned/5",
    "inventory pass",
    "judge eligible",
    "errors",
]


def _row(values: Any) -> str:
    return "| " + " | ".join(str(value) for value in values) + " |"


def _cell_order(key: tuple[Any, ...]) -> tuple[Any, ...]:
    return (*key[:4], list(FRIDGES).index(key[4]))


def _spread(runs: list[dict[str, Any]], field: str) -> str:
    values = [r[field] for r in runs if r.get(field) is not None]
    if not values:
        return "-"
    if len(values) == 1:
        return f"{values[0]}"
    return f"{statistics.median(values):g} ({min(values):g}-{max(values):g})"


def _list(values: Any) -> str:
    return ", ".join(str(v) for v in values) or "-"


def _summary(record: dict[str, Any]) -> str:
    label = (
        f"{record['model']} {record['fridge']} {record['thinking']} {record['variant']}"
    )
    if "error" in record:
        return f"{label} ERROR {record['error']}"
    fields = (
        "first_byte_s",
        "seconds",
        "thinking_tokens",
        "output_tokens",
        "returned",
        "inventory_pass",
    )
    return label + " " + " ".join(f"{field}={record[field]}" for field in fields)


def _append(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        handle.write(json.dumps(record, default=str) + "\n")


def _read(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    commands = parser.add_subparsers(dest="command", required=True)
    gen = commands.add_parser("generate")
    gen.add_argument("--fridge", choices=FRIDGES, required=True)
    gen.add_argument("--thinking", choices=THINKING_LEVELS, default="default")
    gen.add_argument("--variant", choices=VARIANTS, default="base")
    gen.add_argument("--model", default=DEFAULT_GEMINI_MODEL)
    gen.add_argument("--runs", type=int, default=2)
    gen.add_argument("--phase", type=int, default=1)
    jud = commands.add_parser("judge")
    jud.add_argument("--fridge", choices=FRIDGES, required=True)
    jud.add_argument("--phase", type=int, default=1)
    batch = commands.add_parser("judge-batch")
    batch.add_argument("--run-id", required=True)
    batch.add_argument("--thinking", choices=THINKING_LEVELS, default="default")
    commands.add_parser("report")
    args = parser.parse_args()
    if args.command == "report":
        report(args)
    else:
        asyncio.run(
            {"generate": generate, "judge": judge, "judge-batch": judge_batch}[
                args.command
            ](args)
        )


if __name__ == "__main__":
    main()
