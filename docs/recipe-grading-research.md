# Recipe grading: making the meal judge fast and trustworthy

Date: 2026-11-04. Builds on [recipe-latency-research.md](recipe-latency-research.md) (tiered checks, DoorDash/Instacart layering, Flash-Lite, parallel fan-out) and the measurements in [recipe-latency-experiments.md](recipe-latency-experiments.md). This doc doesn't repeat those, and it doesn't pick a design.

**The problem in one paragraph.** Every recipe passes two gates. The first is a deterministic inventory check (`check_quality` in `backend/app/ai/agents/nodes.py`), which takes milliseconds. The second is one Gemini "meal judge" call per batch of up to 5 recipes (`assess_meals` in `backend/app/ai/agents/meal_quality.py`, prompt `assess_meals_v1.yaml`). At default thinking the judge takes 7.8–14.2 s per batch, about as long as generation. At `MINIMAL` it takes 1.4–2.6 s, but it errs in both directions: it approved three thin dishes and rejected a good dish because a step adds water. The default judge also rejects for "lacks protein", even though its prompt says not to use protein rules. So the rubric is ambiguous, and thinking is covering for it.

## Summary

- **The judge's output order is probably working against it.** `MealDecision` puts `verdict` before `reason`. Structured output is generated in schema order (OpenAI states this; for Gemini it's unverified), so the reason is written after the verdict is fixed. MT-Bench, Anthropic and OpenAI all say a judge does better when it reasons first ([Zheng et al. 2023](https://arxiv.org/abs/2306.05685), [Anthropic](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests), [OpenAI](https://developers.openai.com/api/docs/guides/evaluation-best-practices)).
- **A vague rubric produces vague judges.** CheckEval found that splitting fuzzy criteria into binary checklist questions raised agreement between judge models and reduced variance ([Lee et al., EMNLP 2025](https://arxiv.org/abs/2403.18771)). Vertex AI's own evaluation service now grades with per-prompt pass/fail rubric items ([Google Cloud](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/rubric-metric-details)). "Substantial, coherent meal" is one fuzzy criterion today.
- **Thinking helps judges, but it's partly a crutch for missing structure.** A 2025 study found thinking judges about 10 points more accurate at under 2x the cost ([Jayarao et al.](https://arxiv.org/abs/2509.13332)). MT-Bench found a reference answer cut math-grading failures from 14/20 to 3/20, more than chain-of-thought did (6/20). Explicit structure can recover some of what thinking buys.
- **Vendors say to calibrate against human labels before trusting any judge.** Both OpenAI and JUDGE-BENCH say this ([OpenAI](https://developers.openai.com/api/docs/guides/evaluation-best-practices), [Bavaresco et al.](https://arxiv.org/abs/2406.18403)). FreshPlate has no labeled set of good and thin meals. Without one, "MINIMAL is sloppy" rests on 4 batches.
- **Batch judging is double-edged.** BatchEval found judging samples together *improved* correlation with humans, because the judge compares them. But each sample's score then depends on its neighbors ([Yuan et al., ACL 2024](https://ar5iv.labs.arxiv.org/html/2401.00437)). Our experiments show exactly that: one call accepted one protein-free rice dish and rejected another.
- **Part of "substantial" can be checked in code, but a code rule alone won't capture Brandon's bar.** The FDA's "main dish" label rule (≥6 oz per serving, ≥40 g from each of 2+ food groups) is a real, category-free proxy ([21 CFR 101.13(m)](https://www.law.cornell.edu/cfr/text/21/101.13)). It rejects "one ingredient plus seasoning". It would likely still *pass* "Steamed Tomato Rice with Spinach" (grain + vegetable).
- **Self-refine inside generation costs a whole extra pass.** Madaan et al. report about 20% gains from generate-critique-refine ([arXiv 2303.17651](https://arxiv.org/abs/2303.17651)). DeepMind found self-correction without outside feedback can make results worse ([Huang et al. 2023](https://arxiv.org/abs/2310.01798)). Our inventory check is that outside feedback.
- **Expensive judging belongs offline, cheap checks belong online.** Anthropic ranks code-based grading as "fastest and most reliable" and LLM grading second ([Anthropic](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests)). The strict default judge works well as an offline reference grader.

## 1. Online vs offline quality checks

**Concept.** "Online" (in the request path) means the user waits for the check. "Offline" means it runs later on stored outputs, usually a sample. Production teams put cheap, deterministic checks online and run expensive model judges offline or on samples. The previous research doc covers DoorDash and Instacart; this section adds the frameworks.

- **NVIDIA NeMo Guardrails** runs "rails" (checks) before and after the main LLM call. It offers a `parallel` flag so independent rails run at once. NVIDIA says this helps most for I/O-bound rails such as LLM calls ([NeMo config guide](https://docs.nvidia.com/nemo/guardrails/0.15.0/user-guides/configuration-guide/guardrails-configuration.html)). For streaming, `stream_first: True` sends tokens to the user before the output rail finishes. That's faster, but the user can briefly see something the rail later blocks ([output rail streaming](https://docs.nvidia.com/nemo/guardrails/0.20.0/configure-rails/yaml-schema/streaming/output-rail-streaming.html)). This is the same "hold or show-then-swap" choice FreshPlate faces.
- **Guardrails AI** wraps output in validators. Each validator has an `on_fail` action: fix, reask, filter, refrain, noop or exception. Reask means re-prompting the LLM, which costs a full extra call. Their docs recommend exceptions over reasks and fixes as use cases get more complex ([error remediation](https://guardrailsai.com/guardrails/docs/concepts/error_remediation.md), [streaming fixes](https://guardrailsai.com/docs/concepts/streaming_fixes)). FreshPlate's current `quality_feedback` retry is effectively a reask.
- **OpenAI's guardrails cookbook** runs a smaller-model guardrail in parallel with the main call and treats it as a trade-off between accuracy, latency and cost (covered in the prior doc).
- **Latency budgets.** None of these sources publish a millisecond budget for an LLM judge in the request path. Unverified. The vendor pattern is "deterministic first, model second, in parallel where possible."

## 2. LLM-as-judge design that improves accuracy

**Concept.** An "LLM-as-judge" is a model call that grades another model's output. Its accuracy depends on how the question is framed, not just on how smart the model is.

**Known biases** (all from [Zheng et al., MT-Bench, NeurIPS 2023](https://arxiv.org/abs/2306.05685)):
- *Position bias:* the judge prefers an answer because of where it appears. Even GPT-4 gave consistent results under swapped order in only about 65% of cases. Few-shot examples raised that to 77.5%, but made calls 4× more expensive.
- *Verbosity bias:* the judge prefers longer answers. A "repetitive list" attack fooled Claude-v1 and GPT-3.5 91.3% of the time and GPT-4 8.7%. Smaller or weaker judges are much more exposed.
- *Self-preference:* GPT-4 favored itself by about a 10% win rate. A follow-up found models can recognize their own text, and that self-recognition correlates with self-preference ([Panickssery et al. 2024](https://arxiv.org/abs/2404.13076)). FreshPlate judges Gemini output with Gemini. Anthropic's examples advise grading with "a different model" from the generator. Provider rules make that hard here, though another Google model family member is allowed.

**What improves accuracy:**
- *Reasoning before the verdict.* Anthropic: use thinking "so that it reasons before it produces an evaluation score". OpenAI: chain-of-thought before the score improves eval performance. In structured output, field order decides this. OpenAI says Structured Outputs "preserves the order of the schema's properties", and its own chain-of-thought example puts `steps` before `final_answer` ([OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)). Gemini's docs don't say whether output follows schema order (unverified). Today `MealDecision` is `candidate_index, verdict, reason`.
- *Reference-guided grading.* This means giving the judge a known-good answer to compare against. In MT-Bench it beat chain-of-thought (failures 14/20 default, 6/20 CoT, 3/20 reference). FreshPlate has no reference meal per inventory. A static reference would be a short written definition with labeled good and bad examples.
- *Decomposed checklists.* This means splitting one fuzzy criterion into several yes/no questions. CheckEval reports higher agreement and lower variance across 12 judge models, and less sensitivity to which model judges ([arXiv 2403.18771](https://arxiv.org/abs/2403.18771); the "+0.45 agreement" figure came from a secondary summary, unverified). G-Eval uses model-written evaluation steps plus a form to fill in, and reached 0.514 Spearman with humans on summarization ([Liu et al. 2023](https://arxiv.org/abs/2303.16634)). Vertex's adaptive rubrics turn each prompt into pass/fail tests, each with a rationale.
- *Binary verdicts over scales.* OpenAI recommends "pairwise comparison or pass/fail for more reliability". Anthropic says to "be empirical or specific". Practitioner Hamel Husain (blog, secondary) recommends pass/fail plus a written critique. He reports judge-vs-expert agreement as separate true-positive and true-negative rates, because raw agreement hides rare failures ([hamel.dev](https://hamel.dev/blog/posts/llm-judge/)). FreshPlate's verdict enum is already binary in effect.
- *Explicit, non-contradictory rubric.* Anthropic's example rubric is concrete enough to grade mechanically. FreshPlate's prompt says "substantial" but also bans "protein … rules" without saying what *does* make a dish substantial. The default judge fills the gap with its own protein rule; MINIMAL fills it more loosely.

**Small vs big judges, and thinking.** OpenAI: "Use the most capable model to grade if you can." Prometheus (13B, fine-tuned for rubric grading) matched GPT-4's correlation with humans (0.897 vs 0.882) *when given a rubric and reference answer* ([Kim et al. 2023](https://arxiv.org/abs/2310.08491)). Small judges can work, but only with explicit criteria. On thinking:
- Jayarao et al. found thinking judges about 10 points more accurate at under 2× overhead, and more robust to bias ([arXiv 2509.13332](https://arxiv.org/abs/2509.13332)).
- A 2026 paper found reasoning judges more accurate but still vulnerable to superficial-quality biases ([arXiv 2601.03630](https://arxiv.org/html/2601.03630); abstract-level only).
- Another 2026 paper found the gain shrinks as the judge gets bigger, and recommends using reasoning selectively ([arXiv 2605.10805](https://arxiv.org/pdf/2605.10805); search-snippet only, unverified).
- Google's thinking docs suggest minimal "for fact retrieval or classification" and default for "comparing concepts" ([Gemini thinking](https://aistudio.google.com/docs/thinking)).

The meal judge is a classification call, but each decision needs judgment, so it sits between those two cases.

## 3. Per-item parallel judging vs one batch call

**Concept.** "Batch" means one call grades all 5 recipes. "Per-item" means 5 separate calls, one recipe each, run at the same time.

- **Accuracy, batch side.** BatchEval found that judging 10 samples together beat one-at-a-time scoring (Pearson .752 vs .682 on Topical-Chat), at about 64% of the cost. The reason is that the judge compares samples to each other. But it only worked with *heterogeneous* batches, re-drawn over 5 rounds and averaged (homogeneous batches: .671). Batch size had to drop to 2–3 for a 13B model ([BatchEval](https://ar5iv.labs.arxiv.org/html/2401.00437)). FreshPlate runs one round, and its batches are homogeneous: five dishes from one fridge. So it gets the cross-item influence without the averaging that corrects for it. That matches the inconsistency seen in the experiments.
- **Accuracy, per-item side.** Judging alone removes neighbor effects and position effects. It loses the comparison signal, so the absolute criteria must carry the decision. That's another reason for an explicit rubric.
- **Latency.** Batch prompting cuts tokens and time roughly in inverse proportion to batch size, up to 5× on Codex ([Cheng et al. 2023](https://arxiv.org/abs/2301.08721)). That's about total spend. For wall-clock time, parallel per-item calls each write about one-fifth of the output, so they should finish close to one small call's time. Each call re-sends the inventory, though, and counts against RPM. Per-item wall-clock time for our judge is unmeasured.
- **Fit with streaming.** Per-item judging allows judging recipe 1 while recipe 5 is still being generated (see the prior doc's streaming section). That overlaps judge time with generation.

## 4. Moving the quality bar into generation

**Concept.** Instead of catching thin meals after the fact, make the generator less likely to produce them, and make it state facts a cheap check can verify.

- **Constraint-heavy prompts.** These already work partly. The `soft` wording fixed padding on the medium fridge, but the small fridge returned 1 recipe without `minItems: 3`. Prompts shift the distribution; they don't guarantee anything.
- **Self-refine.** This means the model critiques and rewrites its own output. Madaan et al. report about 20% absolute average gains across 7 tasks. Each refinement round is another generation call, so 6–15 s each at our sizes. Huang et al. (DeepMind) found self-correction without outside feedback can make reasoning worse. With outside feedback, it becomes FreshPlate's existing retry loop.
- **Declared fields that make "substantial" checkable.** This means adding required schema fields, so the generator commits to claims code can check. Examples:
  - `main_component_item_ids`: which inventory items carry the dish.
  - `grams_per_serving`, or per-ingredient amounts per serving.
  - `dish_role`: main or side.

  Gemini enforces `enum`, `required`, `minItems`/`maxItems`, `minimum`/`maximum`. It does *not* enforce `minLength`, `uniqueItems` and others, which it strips silently ([Gemini structured output](https://aistudio.google.com/docs/structured-output)). The app must validate those. Risks:
  - The model can lie in a declared field. That's why the code checks the fields against ingredient amounts, rather than trusting them.
  - Extra output tokens add roughly 0.2–0.4 s per recipe at about 230 tok/s (estimate).
  - Asking for a "main component" can push the model toward protein-plus-starch templates. That boxes recipes in, which Brandon doesn't want.

## 5. Rule-based proxies for "a substantial meal"

**Concept.** A proxy is a cheap, measurable stand-in for a fuzzy goal. The best-documented one is US food-labeling law, which had to define "meal" and "main dish" for nutrition claims.

| Proxy | Source | What it catches | Failure mode for FreshPlate |
|---|---|---|---|
| Main dish: ≥6 oz (170 g) per serving; ≥40 g from each of ≥2 of 4 food groups; sauces, condiments and garnishes don't count | [21 CFR 101.13(m)](https://www.law.cornell.edu/cfr/text/21/101.13) | "One ingredient plus a seasoning"; token portions | Rice + spinach passes (grain + vegetable). Needs gram conversion for "each" and "cup" units, plus a food-group tag per inventory item. |
| Meal: ≥10 oz per serving; three 40 g portions from ≥2 groups | same, 101.13(l) | Thin single-component dishes | Stricter than many real one-pot dinners. Could reject a legit omelette. |
| Reference serving of a mixed dish: 1 cup, or 140 g (+55 g with sauce) | [21 CFR 101.12](https://www.law.cornell.edu/cfr/text/21/101.12) | Portions far below a normal serving | It's a labeling reference, not a minimum. Volume-to-weight conversion is error-prone. |
| Requires protein, or protein + starch | Common heuristic, no primary source found | Rice-and-vegetable dishes | Brandon's prompt explicitly rejects this. It boxes in vegetarian and bean dishes. |
| Minimum distinct ingredients or steps | No primary source found | Two-ingredient "recipes" | Easy to game (add garnish, split steps). Penalizes good simple dishes like eggs on toast. |

FreshPlate needs a quantity floor per serving whatever rule it picks. The 200 g-of-chicken "stew for 4" from Flash-Lite would fail the 170 g rule only if the other ingredients were also light. So these proxies work as *floors* that catch the obviously thin. They don't settle "is this a proper dinner". That needs judgment, from the LLM or a trained classifier.

## 6. Smaller or specialized judges

**Concept.** A smaller judge is a cheaper model (Flash-Lite) doing the same prompt. A specialized judge is a model trained only for this decision, often by "distillation": a strong model labels thousands of examples, and a small model learns to imitate it.

- **Gemini Flash-Lite.** 3.5 Flash-Lite is stable, "fastest, most cost-effective", and defaults to minimal thinking ([models](https://aistudio.google.com/docs/models), [thinking](https://aistudio.google.com/docs/thinking)). The experiments measured about 500 tok/s and $0.30/$2.50 per 1M tokens. MT-Bench's verbosity results show weaker judges are much more exposed to bias, so its accuracy needs a labeled set.
- **Fine-tuned classifier (Instacart pattern).** Instacart reportedly trains a DeBERTa cross-encoder on LLM-judge plus human labels and uses it as a filter. It outputs a score but no rationale ([sysdesign-wiki, secondary](https://sysdesign-wiki.pages.dev/patterns/fine-tuned-cross-encoder-as-filter/); primary post not fetched). Cost to build: thousands of labeled recipe-plus-inventory pairs, a training pipeline, model hosting, and retraining when the generator changes. Worth it at high volume. For a portfolio app, labeling and hosting likely outweigh the savings.
- **Tuned Gemini.** The Gemini API currently offers no fine-tuning; tuning is through Vertex AI. Which current models support it is unverified ([model tuning guidance](https://ai.google.dev/docs/model_tuning_guidance), [Vertex tuning](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/tuning)).
- **Prometheus lesson.** A small judge can match a big one when it gets a rubric and a reference. The rubric work in sections 2 and 5 comes before any model swap.

## 7. What belongs online vs offline

**Concept.** Online checks protect the user right now. Offline evals protect the product over time: they catch regressions and measure whether online checks are any good.

- **Online.** Anything fast and high-precision: the inventory check, schema validation, quantity floors, and possibly one fast judge pass.
- **Offline.** The strict default-thinking judge as a reference grader, run on stored sessions or a nightly sample. It measures the online judge's false-accept and false-reject rates. The Batch API is 50% off, but turnaround can be hours ([batch](https://aistudio.google.com/docs/batch-api)).
- **Calibration set.** A few dozen recipes labeled by Brandon (good / thin / incoherent / unsupported), following OpenAI's and Hamel's advice. Without it, no online option can be compared fairly. `docs/evals.md` is the natural home for it.
- **Escalation, a hybrid.** The fast judge decides online. Only `unknown`, or low-confidence cases, go to a stronger pass. This is the "use reasoning selectively" idea from arXiv 2605.10805 (unverified).

## Option menu for FreshPlate's grading step

Latencies are per 5-recipe batch. Measured: default judge 7.8–14.2 s, MINIMAL 1.4–2.6 s. Everything else is an estimate unless marked.

| Option | What it does | Expected latency per batch | Accuracy risk vs strict default judge | Cost | Complexity | Sources |
|---|---|---|---|---|---|---|
| A. Keep default judge | Status quo | 7.8–14.2 s (measured) | Baseline; still rejects on "lacks protein" against its own prompt | ~1.4–2.5k thinking tokens billed per batch | None | experiments doc |
| B. MINIMAL judge as-is | Flip thinking level | 1.4–2.6 s (measured) | High: 3 false accepts and 1 false reject seen in 4 batches | Lowest | Trivial | [thinking](https://aistudio.google.com/docs/thinking) |
| C. LOW judge | Middle level | ~2–8 s (est.; LOW generation was bimodal) | Unknown; LOW thought on some runs and not others | Low–medium | Trivial | experiments doc |
| D. Reason-first schema + explicit checklist rubric, MINIMAL | Reorder to reason → verdict; per-criterion yes/no fields; define "substantial" and allowed staples (water) | ~2–4 s (est.; more output tokens) | Medium; structure should recover some accuracy, unproven | Low | Low (prompt + schema + tests) | MT-Bench, CheckEval, Anthropic, OpenAI |
| E. D at LOW | Same, with some thinking | ~3–8 s (est.) | Lower than D | Low–medium | Low | Jayarao et al. |
| F. Per-item parallel judge (any of B/D/E) | 5 concurrent calls, one recipe each | ≈ single-recipe call, ~1–2 s at MINIMAL (est.) | Removes neighbor and position effects; loses comparison signal | ~5× input tokens, 5× RPM | Medium | BatchEval, Cheng et al. |
| G. Per-item judge overlapped with streamed generation | Judge recipe N while N+1 is generated | Near 0 s added after the last recipe (est.) | Same as F | As F | High (streaming parser) | prior doc, NeMo `stream_first` |
| H. Declared fields + deterministic floor (e.g. FDA-style g/serving and 2 food groups) | Generator states main items and per-serving grams; code verifies | ms check; +~1–2 s generation output (est.) | Catches token and one-ingredient dishes; misses rice + spinach; can box in recipes | Small token increase | Medium (needs unit→gram and food-group tags) | 21 CFR 101.13, Gemini structured output |
| I. Flash-Lite judge | Faster model, same prompt | ~1–2 s (est. from ~500 tok/s) | Unknown; weaker judges show more bias in MT-Bench | ~60% cheaper per token | Low (needs model-rule exception) | [models](https://aistudio.google.com/docs/models) |
| J. Self-refine in generation | Model critiques and rewrites its own batch | +6–15 s (a second generation) | Can improve; can also degrade without outside feedback | ~2× generation | Medium | Madaan et al., Huang et al. |
| K. Fine-tuned classifier | Distilled small model scores each recipe | Tens of ms (est.) | Good only with many labels; no rationale | High build and hosting cost, low per call | High | Instacart (secondary), Prometheus |
| L. Strict judge offline + calibration set | Default judge grades samples later; human-labeled set measures online judge | 0 s online | No online protection by itself; makes every other option measurable | Batch API 50% off | Low–medium | OpenAI, JUDGE-BENCH, Anthropic |
| M. Escalation hybrid | Fast judge online; `unknown` or borderline cases get a LOW/default pass | 1.4–2.6 s typical, +8–14 s on escalations | Depends on how often escalation fires | Low | Medium | arXiv 2605.10805 (unverified) |

These combine. For example, H + D + L, or H + F + L. Choosing is a separate step.

## Open questions

1. **Gemini field order.** Does Gemini structured output generate fields in schema order, as OpenAI states? If it does, reordering `reason` before `verdict` is a free experiment. The docs are silent.
2. **Staples.** Which foods may appear without an inventory item: water, salt, oil, pepper? Today the judge rejects water, and the inventory check has no allowlist. This is a product rule only Brandon can set.
3. **Defining "substantial".** What exactly is it, written as checkable criteria? Example: "has a component that carries the dish, and enough food per serving to be dinner". The current prompt bans protein rules but gives no positive definition.
4. **Labeled set.** How many labeled recipes are enough to compare options B–M? Hamel's examples converge in about 3 prompt iterations. No source gives a minimum count for a binary judge.
5. **Per-item latency.** What do a per-item MINIMAL judge call and a LOW judge call actually take? Both are unmeasured.
6. **Model rules.** Does the model rule permit Flash-Lite, or a different Google model as judge to reduce self-preference? Is Vertex AI tuning on the table?
7. **Show-then-swap.** Is showing a recipe and later swapping it acceptable (the NeMo `stream_first` trade-off), or must every card be judged before it's shown?

## Sources

Vendor docs (fetched 2026-11-04): [Gemini thinking](https://aistudio.google.com/docs/thinking), [Gemini structured output](https://aistudio.google.com/docs/structured-output), [Gemini models](https://aistudio.google.com/docs/models), [Gemini batch](https://aistudio.google.com/docs/batch-api), [Gemini model tuning guidance](https://ai.google.dev/docs/model_tuning_guidance), [Vertex AI tuning API](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/tuning), [Vertex AI rubric-based metrics](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/rubric-metric-details), [Anthropic: develop tests / grading](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests), [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices), [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

Guardrail frameworks: [NeMo Guardrails configuration (0.15.0)](https://docs.nvidia.com/nemo/guardrails/0.15.0/user-guides/configuration-guide/guardrails-configuration.html), [NeMo output rail streaming (0.20.0)](https://docs.nvidia.com/nemo/guardrails/0.20.0/configure-rails/yaml-schema/streaming/output-rail-streaming.html), [Guardrails AI error remediation](https://guardrailsai.com/guardrails/docs/concepts/error_remediation.md), [Guardrails AI streaming fixes](https://guardrailsai.com/docs/concepts/streaming_fixes).

Papers: [Zheng et al., Judging LLM-as-a-Judge (MT-Bench), 2023](https://arxiv.org/abs/2306.05685) (full PDF read), [Liu et al., G-Eval, 2023](https://arxiv.org/abs/2303.16634), [Kim et al., Prometheus, 2023](https://arxiv.org/abs/2310.08491), [Lee et al., CheckEval, EMNLP 2025](https://arxiv.org/abs/2403.18771), [Bavaresco et al., JUDGE-BENCH, 2024](https://arxiv.org/abs/2406.18403), [Panickssery et al., self-preference, 2024](https://arxiv.org/abs/2404.13076), [Jayarao et al., Explicit reasoning makes better judges, 2025](https://arxiv.org/abs/2509.13332) (search-summary level), [Huang et al., Reasoning model is superior LLM-judge, 2026](https://arxiv.org/html/2601.03630) (abstract level), [Reasoning is not free, 2026](https://arxiv.org/pdf/2605.10805) (snippet only, unverified), [Yuan et al., BatchEval, ACL 2024](https://ar5iv.labs.arxiv.org/html/2401.00437), [Cheng et al., Batch prompting, 2023](https://arxiv.org/abs/2301.08721), [Madaan et al., Self-Refine, 2023](https://arxiv.org/abs/2303.17651), [Huang et al., LLMs cannot self-correct reasoning yet, 2023](https://arxiv.org/abs/2310.01798).

Regulation: [21 CFR 101.13 (meal and main dish definitions)](https://www.law.cornell.edu/cfr/text/21/101.13), [21 CFR 101.12 (reference amounts)](https://www.law.cornell.edu/cfr/text/21/101.12).

Secondary, labeled as such: [Hamel Husain, LLM-as-a-Judge guide (practitioner blog)](https://hamel.dev/blog/posts/llm-judge/), [sysdesign-wiki on Instacart's DeBERTa filter](https://sysdesign-wiki.pages.dev/patterns/fine-tuned-cross-encoder-as-filter/).
