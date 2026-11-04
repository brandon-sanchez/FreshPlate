# Recipe generation latency: small-change experiments (phases 1 and 2)

Measured 2026-11-04 with `backend/scripts/latency_probe.py`. Raw runs are in `docs/recipe-latency-runs/` (`runs.jsonl`, `judge.jsonl`, `report.md`). Background: [diagnosis](recipe-latency-diagnosis.md), [research](recipe-latency-research.md).

## Question

Can the current architecture (one batch call, same graph) produce a reliable first batch of 3 or more good recipes, well under the 30 s budget, on small, medium and large fridges? The only changes allowed are small ones: the thinking level, the prompt and schema, or the model.

## Method

- **Fridges.** Three fixed fridges:
  - small: chicken breast, jasmine rice, broccoli
  - medium: chicken thighs, rice, spinach, garlic, onion, canned tomatoes
  - large: medium plus eggs, spaghetti, cheddar, red bell pepper

  Retrieval ran once per fridge (0.8–1.0 s) and was cached, so every config saw the same five inspiration recipes.
- **Generation.** Uses the production prompt (`generate_recipes_v3`), the production schema, the production prompt builder and the production inventory check (`check_quality`). The Gemini call is streamed only so the first byte and the thinking tokens can be measured.
- **"Good recipe".** Passes the deterministic inventory check *and* the production meal judge (`assess_meals_v1`, `gemini-3.6-flash`, default thinking). The judge ran once per fridge per phase over every inventory-passing recipe. That's cheaper than production, which judges each batch separately, and it may score slightly differently.
- **Count fix (`count` prompt).** Opens the prompt with "Return exactly 5 distinct recipes … never fewer than 3". The response schema carries `minItems: 3, maxItems: 5`.
- **Runs.** 2 per cell in phase 1, 1 per cell in phase 2. That is fewer than a benchmark normally needs. The thinking effects are about 20× larger than the run-to-run spread, so the latency conclusions hold. Judge pass counts on 2 runs are only indicative.
- **Spend.** 42 live Gemini calls: 36 generations, 6 judge calls, 3 embeddings, and 3 embeddings lost to a probe bug.

## Results

Times are the generation call in seconds, as median (min–max). The full graph adds about 1 s of retrieval, the judge, and about 0.3 s to save the session.

| Model | Thinking | Prompt | Fridge | First byte | Call | Thinking tokens | Returned (of 5) | Pass inventory | Pass judge | Cost per batch |
|---|---|---|---|---|---|---|---|---|---|---|
| 3.6 Flash | default (today) | today | small | 25.7 (21.0–30.4) | 27.6 (23.1–32.2) | 4,619 (3,774–5,463) | 1, 2 | 1, 2 | 1, 2 | $0.022 |
| 3.6 Flash | default (today) | today | medium | 26.3 (24.7–27.9) | 28.5 (27.5–29.5) | 4,895 (4,363–5,426) | 1, 1 | 1, 1 | 1, 1 | |
| 3.6 Flash | default (today) | today | large | 21.2 (17.2–25.3) | 26.2 (22.4–30.0) | 4,201 (3,465–4,937) | 3, 3 | 3, 3 | 3, 3 | |
| 3.6 Flash | LOW | today | small | 5.2 (1.2–9.3) | 7.1 (3.4–10.9) | 701 (0–1,402) | 1, 1 | 1, 1 | 0, 1 | $0.008 |
| 3.6 Flash | LOW | today | medium | 6.7 (3.2–10.2) | 9.4 (5.8–13.1) | 1,007 (317–1,696) | 1, 1 | 1, 1 | 1, 1 | |
| 3.6 Flash | LOW | today | large | 4.0 (1.4–6.6) | 10.6 (9.2–12.0) | 497 (0–993) | 2, 3 | 2, 3 | 2, 3 | |
| 3.6 Flash | MINIMAL | today | small | 1.0 (0.9–1.1) | 3.2 (3.2–3.2) | 0 | 1, 1 | 1, 1 | 1, 1 | $0.005 |
| 3.6 Flash | MINIMAL | today | medium | 1.3 (1.1–1.5) | 4.7 (4.5–4.8) | 0 | 1, 1 | 1, 1 | 1, 1 | |
| 3.6 Flash | MINIMAL | today | large | 1.3 (1.3–1.4) | 9.8 (9.1–10.6) | 0 | 3, 3 | 3, 3 | 3, 3 | |
| **3.6 Flash** | **MINIMAL** | **count** | small | 1.1 (1.1–1.2) | 6.6 (6.4–6.8) | 0 | 3, 3 | 3, 3 | 3, 3 | **$0.008** |
| **3.6 Flash** | **MINIMAL** | **count** | medium | 1.2 (1.0–1.4) | 8.2 (7.5–8.8) | 0 | 3, 4 | 3, 4 | **2, 1** | |
| **3.6 Flash** | **MINIMAL** | **count** | large | 1.8 (1.6–2.1) | 13.0 (13.0–13.0) | 0 | 5, 5 | 5, 5 | 5, 5 | |
| 3.8 Flash | LOW (its lowest) | count | small | 19.6 | 29.1 | 0 reported | 3 | 3 | 3 | $0.009 |
| 3.8 Flash | LOW | count | medium | 1.8 | 13.7 | 0 reported | 3 | 3 | 3 | |
| 3.8 Flash | LOW | count | large | 1.8 | 19.8 | 0 reported | 5 | 5 | 4 | |
| 3.5 Flash-Lite | MINIMAL (default) | count | small | 1.1 | 4.5 | 0 | 5 | 5 | 5 | $0.007 |
| 3.5 Flash-Lite | MINIMAL | count | medium | 1.0 | 6.0 | 0 | 5 | 4 | 4 | |
| 3.5 Flash-Lite | MINIMAL | count | large | 1.1 | 5.8 | 0 | 5 | 5 | 5 | |

Cost uses Google's paid Standard prices (fetched 2026-11-04 from [the pricing page](https://aistudio.google.com/docs/pricing)), as the median across that config's runs:

| Model | Input, per 1M tokens | Output, per 1M tokens | Note |
|---|---|---|---|
| 3.6 Flash | $0.75 | $3.75 | Both double on 2027-01-01 |
| 3.8 Flash | $0.75 | $3.75 | Both double on 2027-01-01 |
| 3.5 Flash-Lite | $0.30 | $2.50 | |

Thinking tokens are billed as output. Generation calls only, no judge.

## What the numbers say

1. **Thinking explains the slowness, and MINIMAL removes it.** With today's default ("medium" per [Google's docs](https://aistudio.google.com/docs/thinking)), the model thinks for 3,500–5,500 tokens and writes its first byte after 17–30 s on every fridge. Even the 3-item fridge took 32 s. So thinking time does **not** grow with fridge size. It's just high and random. LOW still thinks on some runs (first byte up to 10 s), so it isn't consistent. MINIMAL never thought: the first byte came at 0.9–2.1 s on every run.
2. **The low recipe count is caused by the prompt and schema, not thinking.** Default, LOW and MINIMAL all returned 1 recipe on the small and medium fridges and 2–3 on the large one. Adding an explicit count plus `minItems`/`maxItems` raised every run to 3–5, and all of them passed the inventory check. This answers open question 1 in the research doc.
3. **More recipes cost writing time.** At MINIMAL, a 5-recipe batch is about 2,500 output tokens, about 13 s on the large fridge. That's still well under budget, but it's now the main cost.
4. **Forcing a count can make the model pad the batch.** On the medium fridge, the count prompt produced thin dishes ("Garlic Onion Jasmine Rice Bowl", "Steamed Tomato Rice with Spinach"), and the judge rejected them as insufficient. So only 2 and 1 recipes per run were good. The small fridge gave 3 good recipes, but some were near-duplicates (two chicken-broccoli-rice bowls), because 3 ingredients only allow so much variety. The judge is also inconsistent: across calls it accepted one protein-free rice dish and rejected another, although its prompt says not to require protein.
5. **3.8 Flash is slower, not faster.** At its lowest level (LOW, since it has no MINIMAL), calls took 14–29 s, with one 19.6 s first byte. It writes about 150 output tokens per second, against about 230 for 3.6 at MINIMAL and about 500 for 3.5 Flash-Lite. It costs the same as 3.6, and one of its recipes was rejected for "basil" in the title. Not worth switching.
6. **3.5 Flash-Lite is the fastest and cheapest, but its recipes are visibly weaker.** It returned 5 recipes in 4.5–6 s on every fridge, and the judge passed 14 of 15. Reading the recipes shows problems the judge doesn't check:
   - **Merged stages.** A 2-step stew, and "dice and cook" written as one step. #55 asks for one stage per step.
   - **Broken formatting.** One run put each step heading in its own list item, which the app would show as separate steps.
   - **Thin portions.** A "stew for 4" uses 200 g of chicken.
   - **Display glitches.** Amounts print as "1.0 each".
   - **One inventory failure.** One recipe failed the inventory check.

## Recommendation

**Keep the architecture and keep `gemini-3.6-flash`. Make two small changes to the existing batch call:**

1. **Set `thinking_level=MINIMAL` on generation.** This takes the first byte from 17–30 s to 1–2 s, removes the run-to-run randomness, and cuts cost per batch from about $0.022 to about $0.008.
2. **Ask for a count explicitly.** Put the count in the prompt and `minItems: 3, maxItems: 5` in the schema. This takes the batch from 1–2 recipes to 3–5.

The generation call then takes 6–13 s on every fridge. With retrieval, the judge and the save, the first response should land around 9–16 s (estimated), well under the 30 s budget. **Phase 3 (a new architecture) isn't needed** for speed: the bottleneck was a setting, not the design.

**Not yet proven:** "3 or more *good* recipes on every fridge". On the medium fridge, the judge passed only 2 and 1. Two small follow-ups would close that, for about 10–12 more live calls:

- **Soften the count wording.** For example, "3 to 5 distinct, substantial meals; never pad the list with side dishes or plain rice". The schema keeps its minimum of 3. The aim is to stop the padding without losing the count.
- **Set the judge's thinking level too, and time it per batch as production does.** The production judge also runs on default thinking. Here it took 12–48 s to judge 7–27 recipes in one call. Per batch it might take seconds or tens of seconds, which is unmeasured and could eat the savings. MINIMAL judge calls took about 1.2 s in the earlier probe, but their accuracy at MINIMAL hasn't been checked against the default.

Switching to Flash-Lite would save about 30% per batch and about 5 s, but step quality drops (#55). That's Brandon's call. It isn't recommended now.
