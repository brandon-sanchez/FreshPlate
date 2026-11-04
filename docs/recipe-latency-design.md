# Recipe generation latency: design

Status: **on hold.** Brandon asked to try small changes first. They fixed the speed without a new architecture ([experiments](recipe-latency-experiments.md)). Kept for reference only. Brandon also ruled out a fixed dish-style list.
Read with [the diagnosis](recipe-latency-diagnosis.md) and [the research](recipe-latency-research.md).

## Problem

The first card waits on one Gemini call that thinks for about 23 s before it writes anything. Then it writes 1–2 recipes (not the 5 we asked for) as one JSON document. The meal judge can only start after that, and with under 10 s left it can't start at all, so the session fails with a 503. The fix must keep three guarantees for every card shown:

- **Kitchen-only ingredients.** Every ingredient maps to an inventory item, with a valid amount and unit. This is the deterministic `check_quality`.
- **Substantial meals (#54).** Enforced by the `assess_meals` judge.
- **Useful steps (#55).** Enforced by the prompt rules.

It must also keep the server-owned feed and its refill lease, keep the evals working offline (`FakeProvider`) and live (LangSmith), and use Gemini only.

## The idea in plain words

Today the server asks one cook for five dishes and waits until all five are written down. The new design asks **five cooks for one dish each, at the same time**, and tells each cook which style to make: a soup, a skillet, a rice bowl, and so on. Each cook's dish is checked (inventory rules, then the judge) as soon as that cook finishes, without waiting for the others. Separately, we tell every cook to **think less** (`thinking_level=LOW`). That alone removes about 20 s of silent planning per call.

In interviews, this is called **fan-out / map-reduce**. You split one big job into independent small jobs, run them in parallel, and merge the results. In LangGraph, the built-in tool for it is `Send`.

## Options

| | A. Thinking LOW only | **B. Parallel one-recipe lanes (recommended)** | C. Pre-generate per inventory signature |
|---|---|---|---|
| What changes | One line: set `thinking_level=LOW` on the existing batch call | Thinking LOW, plus the graph fans out into 5 one-recipe lanes, each checked and judged on its own | Generate recipes in the background whenever the inventory changes, keyed by a hash of the inventory; the feed reads stored cards |
| Time to first card (p50, 6-item fridge) | ~6–8 s (measured 6.2–7.5 s) | **~8 s** (measured: 3 parallel lanes in 5.8 s, plus ~1.3 s judge and ~0.3 s save) | ~0.5 s on a cache hit; on a miss, falls back to A or B |
| Cards in the first response | **1–2** (measured, every run) | **3–5**, one per lane, distinct dish styles | Whatever was pre-generated |
| Consistency | Better, but the count still varies and a long recipe can still crowd out the judge | Latency no longer depends on fridge size (each lane writes one recipe of about 700 tokens). Each lane has its own time cap, so the judge always gets its time | Stale results whenever the inventory changes faster than the job runs |
| Gemini calls per first page | 2 | ≤ 11 (1 embedding, 5 generations, 5 judges) | Same as B, but spent even on sessions nobody opens |
| Cost per card | Lower than today (thinking tokens are billed as output) | About the same as A per card. More requests, so Tier 1 RPM needs a check | Highest: you pay for unopened sessions |
| Complexity | Trivial | Medium: a new lanes module, one graph instead of two, new eval cases | High: a job queue, cache invalidation, and Cloud Run has no CPU after the response |
| Eval impact | Same harness; scores may shift with LOW thinking | Harness moves to the one new graph. Adds fridge-size cases and scorers for latency, card count and dish diversity | New offline pipeline to evaluate |

**Recommendation: B.** A alone fixes the *speed* but not the *product*: the user still gets 1–2 cards. C is what DoorDash, Instacart and Yelp do (see the research), but those companies have shared "popular" inputs to precompute. Every FreshPlate fridge is private and changes often, so C would mostly pay for work nobody sees. C can be layered on top of B later if a demo ever needs instant cards.

## How B works

```
POST /sessions
  analyze_inventory ──► retrieve_recipes ──► plan_briefs ──┬─Send─► lane 0: generate 1 recipe ─► inventory check ─► judge ─┐
     (pure, ~0 s)        (embed+pgvector,     (pure: picks  ├─Send─► lane 1: …                                              │
                          ~1.3 s, 30 docs)     5 styles,    ├─Send─► lane 2: …                                              ├─► collect_cards ─► save session ─► 3–5 cards
                                               anchors,     ├─Send─► lane 3: …                                              │   (dedup titles)    (unchanged RPC)
                                               2 docs each) └─Send─► lane 4: …                                              ┘
                                                                     each lane ≈ 4.5 s generate + 1.2 s judge, all at once

POST /sessions/{id}/pages  (refill, under the existing DB lease)
  same graph, skips analyze/retrieve, rotates dish styles by run number, excludes titles already shown
```

### Caller's view

```python
# api/recipes.py: the first batch and every refill call the same function
graph = build_recipe_feed_graph(provider, retriever)
batch = await run_feed_batch(graph, FeedBatchInput.head(payload), deadline)
batch.cards          # list[Recipe]; each one passed the inventory check AND the judge
batch.lane_report    # per-lane timings and verdicts, logged and traced to LangSmith

# refill, inside the existing claim/finalize lease
batch = await run_feed_batch(graph, FeedBatchInput.refill(session), deadline)
```

### Core types (sketch)

```python
# app/ai/agents/lanes.py  (new: owns "one card")
@dataclass(frozen=True, slots=True)
class RecipeBrief:                    # everything one lane needs
    lane: int
    dish_style: str                   # from a fixed DISH_STYLES list, rotated per refill
    anchor_item_id: str               # expiring items first
    sibling_styles: tuple[str, ...]   # "other lanes are making …", to discourage duplicates
    inspiration: tuple[RetrievedRecipe, ...]   # 2 retrieved docs, unique to this lane

LaneVerdict = Literal["eligible", "no_recipe", "inventory_failed",
                      "judge_rejected", "timeout", "provider_error"]

@dataclass(frozen=True, slots=True)
class LaneOutcome:
    lane: int
    verdict: LaneVerdict
    recipe: Recipe | None      # set if and only if verdict == "eligible" (checked in __post_init__)
    feedback: str | None
    generate_s: float
    judge_s: float | None

def plan_briefs(usable, pool, *, retrieval_cursor, run_index, count) -> list[RecipeBrief]: ...  # pure
async def run_lane(brief, ctx, provider, deadline) -> LaneOutcome: ...   # never raises; errors become verdicts
def collect_cards(outcomes, exclude_titles) -> list[Recipe]: ...         # pure: eligible only, dedup titles

# app/ai/llm/retry.py
class PipelineDeadline:
    def capped(self, seconds) -> PipelineDeadline: ...   # ends at min(this end, now + seconds)
    def leaving(self, seconds) -> PipelineDeadline: ...  # ends `seconds` before this end

# app/ai/prompts/*.yaml gains `thinking: low`; the provider reads it per call
```

### Load-bearing decisions

1. **Thinking LOW, versioned with the prompt.** `generate_recipe_v4.yaml` and `assess_meals_v2.yaml` each carry `thinking: low`. `GeminiProvider` passes it as `thinking_config`. The reasoning budget lives next to the prompt that was tuned for it, and LangSmith metadata records both. LOW is preferred to MINIMAL: it was just as fast in the probe, and the newer `gemini-3.8-flash` has no MINIMAL level.
2. **One recipe per lane, five lanes, styles chosen by code.** A pure `plan_briefs` decides the variety: dish style, anchor ingredient, and 2 inspiration docs per lane. The model doesn't decide it. That makes runs repeatable and testable. If a style can't be made from the fridge, the lane returns `recipe: null` instead of inventing ingredients.
3. **Every card passes both checks inside its own lane.** A lane can only produce a card after the deterministic check and the judge both pass. `collect_cards` reads only eligible outcomes. No code path shows an unjudged recipe, and a judge failure means no card (no fail-open path).
4. **Per-lane time caps protect the judge.** Generation runs under `deadline.leaving(10).capped(15)`, and the judge under `deadline.capped(10)`. A slow lane becomes a `timeout` verdict, and the other lanes still return. "Slow" can no longer turn into "503".
5. **One graph for the first batch and refills.** `build_recipe_graph` and `build_recipe_generation_graph` merge into `build_recipe_feed_graph`, and `/suggestions` uses it too. A refill skips analyze and retrieve because the session already holds them. That leaves one code path to test and evaluate.
6. **The retry rule stays the same.** If zero cards are eligible and at least 20 s remain, run one rescue round with the failure feedback (today's "retry only if zero valid"). Lanes never retry on their own.
7. **No database change.** The RPCs, the lease and `generation_runs` stay as they are. `retrieval_cursor` advances by 10 docs per run and wraps around the 30-doc pool.
8. **Measurable from logs.** The provider logs per-call time, first-byte time and token counts (thinking and output). LangSmith shows one span per lane, so the numbers in the diagnosis can be re-checked without a probe script.

### Predicted latency (from measured numbers)

| Stage | p50 | Bounded worst case |
|---|---|---|
| auth + analyze | 0.1 s | 0.3 s |
| retrieve | 1.3 s | 2.6 s |
| slowest of 5 lanes, generate (LOW) | 4.8 s | 15 s cap |
| that lane's judge | 1.3 s | 10 s cap |
| save session (RPC) | 0.3 s | 2 s |
| **first response** | **≈ 8 s** | **≈ 28 s**, ending as failed lanes rather than a 503 |

A refill takes about 6.5 s (no retrieval). The mobile buffer already prefetches the next page right after the first render, so a refill should never be visible while scrolling.

## Synthesis decision

Three independent design runs (Opus, Fable, Sonnet) converged on the same core: parallel one-recipe lanes, thinking LOW, and checking and judging per lane. Because they agreed, no cross-judge ran. The base is the **Opus** candidate, because it keeps LangGraph. The README and the portfolio present a LangGraph pipeline with LangSmith tracing, the eval harness already drives the graph, and `Send` map-reduce is the standard, explainable LangGraph pattern for this.

Grafts:

- **From Fable:** the thinking level is versioned in the prompt YAML instead of being a global provider setting. Also, seed the mobile hook's page-latency estimate from the measured first-response time, so prefetch timing matches the new ~7 s refill.
- **From Sonnet and Fable:** fridge-size eval cases (6–10 items), because the 22 small cases hid the slowdown. Also latency and card-count scorers.

Rejected:

- **Delete LangGraph for plain `asyncio` (Fable, Sonnet).** That would give early return at 3 cards and cancel the stragglers. But lanes finish within about 1 s of each other (measured 4.0–4.5 s), so early return saves under a second. Per-lane caps already bound the worst case. And dropping LangGraph removes the showcase and the per-node traces.
- **A protocol-wide `thinking` default (Fable).** The prompt carries the level instead.

## Tradeoffs accepted

- We accept about 5× more Gemini requests per page in exchange for latency that doesn't depend on fridge size and 3–5 cards on the first screen. The cost per card stays about the same, because the dropped thinking tokens were billed as output.
- We accept that LOW thinking may make a single recipe a little less clever, in exchange for an always-on judge and a before/after eval that measures it.
- We accept that the first response waits for its slowest lane (up to the cap), rather than returning early, in exchange for keeping LangGraph and not paying for lanes we would then discard.
- We accept a fixed list of dish styles, which is predictable and testable, instead of letting the model pick variety.

## Locked decisions

This design keeps all three: **no SSE, simulated progress, a 30 s budget.** One optional follow-up, to approve separately and only after production data shows p95 under 12 s: lower the server budget to 20 s and the client abort to 25 s, so an outage fails faster. Streaming to the client isn't needed, because the lanes already put 3–5 cards in the first response.

## Open questions for Brandon

1. **Approve option B?** Or would you rather ship A first (one line, 1–2 cards) as a quick patch and B after it?
2. **Five lanes per batch?** Five gives 5 cards when all pass, and costs up to 11 calls. Four would cost 9 calls and give 3–4 cards.
3. **Tiny fridges.** With 2 items, several styles will honestly return "no recipe", so the user may get fewer than 3 cards. Is that acceptable as honest scarcity (yes, in this design)?
4. **Tier 1 rate limit.** Can you read the RPM for `gemini-3.6-flash` in AI Studio? A session makes up to 11 calls in about 2 s.

## Verification plan (after approval)

1. TDD with `FakeProvider`: tests for `plan_briefs`, `collect_cards`, and every lane verdict, plus the graph fan-out, the rescue round and the lease paths.
2. Live: one probe of the new graph on the same 6-item fridge, to confirm the ~8 s estimate before the app run.
3. `verify` in the app: Recipes → **Generate from my fridge**, timed, 3 runs. The pass bar is a first card in under 12 s on every run, with 3 or more cards.
4. Re-run the #34 eval (22 cases plus the new fridge-size cases) and compare with `freshplate-mvp-eval-5f67a3a2`. That run needs about 50–60 live calls, so it needs Brandon's go-ahead.
