# Recipe grading step: options

Status: **option A approved and tested; final settings proposed below.** No app code has changed.
Evidence: [experiments](recipe-latency-experiments.md) (measured) and [grading research](recipe-grading-research.md) (sources).

## Where the grading step stands

Every shown recipe passes two checks:

1. The deterministic inventory check: ids, names, units and amounts. It takes milliseconds and is reliable.
2. The LLM meal judge (`assess_meals`), which decides whether the dish is a real, substantial meal (#54).

Measured on the same batches:

| Judge setting | Time per 5-recipe batch | Thin dishes caught (4 known) | False rejections seen |
|---|---|---|---|
| Default thinking (today) | 7.8–14.2 s | 4 of 4 | 0 |
| LOW | 1.7–2.0 s | 0 of 4 | 0 |
| MINIMAL | 1.4–2.6 s | 1 of 4 | 1 (rejected a dish for adding water) |

So today the "substantial meal" guarantee costs as much time as writing the recipes, and the cheap settings rubber-stamp. Two design flaws explain why the fast judge is weak (per the research):

- **The rubric is vague.** The prompt lists what *not* to require (no fixed protein or starch rules) but never says what *does* make a dish substantial. A thinking judge invents its own rule. A non-thinking judge falls back to "uses the listed ingredients", which only repeats the inventory check.
- **The verdict comes before the reason.** `MealDecision` is `candidate_index, verdict, reason`. Structured output is generated in key order, so the model commits to a verdict first and writes the justification after. Vendor guidance is to reason first ([OpenAI](https://developers.openai.com/api/docs/guides/structured-outputs), [Anthropic](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests)). Whether Gemini keeps key order is undocumented.

## Options

| | A. Checklist judge (recommended) | B. Strict judge, one call per recipe in parallel | C. Rules in code plus the strict judge offline |
|---|---|---|---|
| What it does | Rewrite the judge as a short yes/no checklist per recipe, with the reasoning fields first. For example: what is the main component; is it a full meal (not a side, a plain grain, or one ingredient plus seasoning); is the amount per serving realistic; does the title or a step name a food not in the list (water, salt and oil excepted, per Brandon's allowlist). Code turns the answers into the verdict. It runs at MINIMAL or LOW, one call per batch | Keep today's judge and thinking level, but send each recipe to its own call at the same time | Code checks a substance floor: at least 2 inventory foods in meaningful amounts per serving, and a main component of roughly 150 g or more per serving. This loosely follows the FDA "main dish" definition ([21 CFR 101.13(m)](https://www.law.cornell.edu/cfr/text/21/101.13)). The LLM judge leaves the request path and runs in offline evals |
| Latency per batch | ~2 s (estimated from MINIMAL and LOW timings; the checklist adds a little output) | Probably 3–8 s, the slowest single recipe. Not measured | ~0 s online |
| Accuracy vs the strict judge | Unknown until tested. Research shows checklists and explicit criteria close much of the gap for fast or small judges ([CheckEval](https://arxiv.org/abs/2403.18771), [MT-Bench](https://arxiv.org/abs/2306.05685), [Prometheus](https://arxiv.org/abs/2310.08491)) | Same as today or better, because each verdict no longer depends on the other recipes in the batch ([BatchEval](https://ar5iv.labs.arxiv.org/html/2401.00437)) | Catches token portions and "one ingredient plus seasoning". Misses incoherent combinations and unlisted foods in the steps. Needs unit-to-gram conversion and a food-group tag per item |
| Cost | Lowest: 1 short call per batch | About 5× today's judge calls, with thinking tokens on each | Lowest online, plus offline eval spend |
| Complexity | Low: a new prompt version, a new schema, and a small function that maps answers to a verdict | Low: fan the existing call out with `asyncio.gather` | Medium to high: unit conversion and food-group data, and thresholds that risk boxing recipes in |
| Explain it in an interview | "We replaced a vague yes/no LLM judge with a structured checklist, so a fast model can answer it reliably and code makes the decision" | "Parallel fan-out of an expensive check" | "Deterministic guardrail first, LLM eval offline" |

**Also in every option.** Generation carries the quality bar first. The real-meals wording already produced no thin dishes in 6 recipes and returned zero on a near-empty fridge, so the judge becomes a safety net rather than the main filter. The strict default-thinking judge moves to the offline eval suite, where it measures how often the fast check disagrees with it.

## Recommendation

**Option A**, the checklist judge at MINIMAL or LOW, together with real-meals wording in generation. It's the only option that is both fast (about 2 s) and specific about what "substantial" means. B keeps the slow, expensive judge. C would either box recipes into categories (which Brandon ruled out) or miss incoherent dishes.

Expected first response with A, estimated from the measured parts:

| Fridge | Estimated first response |
|---|---|
| Near-empty | ~2 s, honest zero |
| Small | ~8–9 s |
| Medium and large | ~10–17 s |

Each estimate is retrieval of about 1 s, generation of 1.3–15 s, the checklist judge at about 2 s, and saving the session at about 0.3 s.

**Proof before app code, about 4 live calls.**

- **Test batches.** Run the checklist judge on the 4 batches with known strict verdicts.
- **Pass bar.** It rejects the 4 known thin dishes, approves the 15 known good ones, and takes under 3 s per batch.
- **Calibration set.** A small set of 20–30 recipes that Brandon labels "real meal / thin / incoherent" would give every judge setting a fair score. It would also become a permanent eval set.

If A fails the bar, fall back to B. It's slower but keeps today's accuracy.

## Questions for Brandon

1. Approve option A and about 4 live calls to prove it on the known batches?
2. Which foods may a recipe use without an inventory item? Water seems obviously fine. What about salt, pepper, cooking oil? Today the inventory check and the judge allow none, and the MINIMAL judge rejected a dish because a step adds water.
3. Prompt wording sits between two tested extremes. `soft` gave 5 recipes on the medium fridge, one of them thin. `real` gave 2 but returned zero honestly on a near-empty fridge. OK to settle the final wording on the eval set rather than more one-off runs?

## Results (round 4) and final proposed settings

The checklist judge agreed with the strict batch judge on 15 of 17 known dishes in 2.7–3.5 s. Both disagreements are strict-judge inconsistencies. The fallback B (strict judge per recipe, in parallel) took 4.4–7.4 s and approved 3 of the 4 known thin dishes. Details are in [experiments, round 4](recipe-latency-experiments.md).

**Proposed settings:**

| Step | Setting |
|---|---|
| Generation | `gemini-3.6-flash`, `thinking_level=MINIMAL`. Wording: up to 5 distinct meals; each may use the full inventory; vary the cooking method or format; an empty list is fine. Water is the only ingredient not in inventory. Schema: `recipes` with `maxItems: 5` and no minimum |
| Inventory check | As today, plus: an ingredient named "water" with no inventory id is allowed. Salt, pepper, oil and all other seasonings and fats must map to inventory |
| Meal judge | The checklist judge at MINIMAL, reasoning fields first, verdict decided in code. Water never counts as an unlisted food |
| Retry | Retry once only when candidates were generated and all were rejected, and at least 20 s remain. An honest empty list goes straight to the friendly "A little more to work with" state |
| Offline | The strict default-thinking judge and a hand-labeled set (follow-up eval task) measure how often the checklist is wrong |

Estimated first response: near-empty about 3 s; small about 9 s; medium and large about 10–17 s. That's retrieval about 1 s, generation 1.7–15 s, checklist 2–4 s, and saving 0.3 s.

**One check before app code, about 7 live calls.** The generation wording in this table (the `soft` wording plus an empty-list allowance and the water rule, with no "never pad" sentence) hasn't been run as one combination. It needs one pass over the four fixed fridges, with the checklist judge on each non-empty batch. Pass bar:

- near-empty returns 0;
- small returns 2–3 approved meals;
- medium and large return 4–5 approved meals;
- no near-duplicates.
