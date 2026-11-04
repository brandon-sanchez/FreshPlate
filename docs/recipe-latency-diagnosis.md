# Recipe generation latency: diagnosis

Measured on 2026-11-04. The research is in [recipe-latency-research.md](recipe-latency-research.md).

## Symptom

On the Recipes tab, a user taps **Generate from my fridge**. The "Generating" loader runs for about 30 seconds, then the screen shows "We couldn't generate recipes". The API log for the same run:

```
Recipe feed session failed after 29.70s: LLM pipeline deadline exhausted
"POST /api/recipes/sessions HTTP/1.1" 503 Service Unavailable
```

That run used Brandon's household (6 usable items out of 23; 17 are expired) on the iOS simulator, through the `verify` skill.

## How it was measured

A probe script ran the real feed-session graph (`build_recipe_graph` with the `/sessions` settings: batch 5, 30-doc retrieval pool, one quality retry) against live Gemini. It made one change for measurement only: it **streamed** the Gemini call. Streaming shows when the first byte arrives, and its `usage_metadata` splits hidden "thinking" tokens from visible output tokens. Every run used the same 6-item fridge.

| Run | `generate_recipes` call | First byte | Thinking tokens | Output tokens | Recipes returned | Whole graph | Outcome |
|---|---|---|---|---|---|---|---|
| Default (today's code) #1 | 27.0 s | 23.4 s | 4,439 | 935 | 2 | 29.6 s | Quality check skipped (0.36 s left) |
| Default (today's code) #2 | 28.2 s | 23.8 s | 4,561 | 1,144 | 2 | 29.2 s | Quality check skipped (0.77 s left) |
| `thinking_level=MINIMAL` | 5.0 s | 1.6 s | 0 | 751 | 1 | 7.5 s | Passed; quality call 1.2 s |
| `thinking_level=LOW` | 4.0 s | 1.1 s | 0 | 696 | 1 | 6.2 s | Passed; quality call 1.2 s |
| 3 parallel calls, 1 recipe each, MINIMAL, each with a different dish style | 4.0–4.5 s each | 1.1–1.4 s | 0 | ~680 each | 3 different dishes | 5.8 s (1.3 s retrieval + calls) | Quality not run |

Other stages:

- Retrieval: 0.9–2.6 s. The embedding takes 0.4–0.6 s and the pgvector search 0.5–2.1 s.
- Meal-quality judge (`assess_meals`): about 1.2 s.
- Gemini writes visible output at about 200–250 tokens per second. One full recipe in the #55 step style is about 650–750 tokens, so about 3 s.

LangSmith already had node timings from the #34 eval (`freshplate-mvp-eval-5f67a3a2`, 22 small inventories of 2–5 items). There, `generate_recipes` averaged 14.5 s (median 15.0 s, max 19.4 s), and 12 of 22 cases failed because the quality call could not start. LangSmith does not trace the Gemini calls themselves, so it has no token counts. That is why the probe was needed.

## What dominates, and why

1. **Hidden thinking (about 80% of the time).** Gemini 3.x Flash reasons before it answers unless told otherwise. `GeminiProvider` sets no `thinking_config`, so every call uses the model's default. On this fridge, the model generated about 4,500 thinking tokens (about 23 s) before writing the first byte of JSON. The amount varies a lot from run to run (3,500–5,500 tokens) but does not grow with fridge size: a 3-item fridge thought just as long as a 10-item one ([experiments](recipe-latency-experiments.md)). That randomness is the inconsistency. With thinking at MINIMAL, the same call takes 4–5 s.
2. **Output size and batching (second).** Even with no thinking, one call that writes 5 full recipes produces about 3,500 tokens, about 15 s. The first card can't be shown until the whole JSON document arrives, because the batch is one response.
3. **Sequential stages plus the 10 s floor (turns slow into failed).** Retrieval, generation, and quality run one after another under one shared deadline. `GeminiProvider` will not start a call with under 10 s left, because Gemini rejects HTTP deadlines under 10 s. So any generation over about 14–18 s means the quality check never runs, and the session fails instead of being slow.

Ruled out:

- **Retries.** No run retried. Every call succeeded on its first attempt, and the quality loop never fired.
- **Prompt size.** The input is about 2,700 tokens, which Gemini reads in well under a second. That cost is small next to the thinking time.
- **Network and feed overhead.** These add a few hundred milliseconds. The embedding plus pgvector add 1–2.6 s.

## A consistency bug found along the way

The prompt asks for "up to 5" recipes and says to use the full ceiling. The model returned 1 or 2 recipes in every run, with or without thinking. So even when a batch call works, the first screen holds 1–2 cards, not 5. Asking for one recipe per call, each steered toward a different dish, returned 3 distinct dishes.

## Reproducing

- In the app: `.claude/skills/verify` (PR #68), then Recipes → **Generate from my fridge**. Watch `api.log` for the `POST /api/recipes/sessions` line and its time.
- The probe scripts live in the session scratchpad, not in the repo. They were throwaway measurement tools. The design adds per-call timing and token logging to the provider, so the numbers above can be re-measured from logs and LangSmith in the future.
