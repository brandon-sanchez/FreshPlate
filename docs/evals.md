# Recipe evals

FreshPlate writes recipes from a cook's kitchen and the answers they give in the app. The eval runs that recipe pipeline over a fixed set of kitchens and scores every recipe it returns. This page explains what the eval measures and why, defines the rubric, shows how to run it, and explains how to read the scorecard it prints.

## What the eval measures and why

The question behind the eval is short: given a real kitchen and real answers, does the pipeline return recipes the cook can make and wants to make? It has two halves, and each half gets the grader that suits it.

The first half is rules that code can check exactly. Every ingredient must come from the kitchen or the kitchen basics, every amount must be positive and within stock, and the recipe must have a title, ingredients, and steps. Code scorers check these rules. They are free and deterministic, and they give the same answer on every run.

The second half is judgment that code can't make. Is a chickpea curry made with ghee vegan? Does a 20-minute pasta fit "<15 min"? Is 400 g of dry pasta per serving a normal portion? One LLM judge answers these questions with one rubric.

### The eval runs what the app runs

Each case runs the same graph as the app's first feed page: a batch of five recipes, the same retrieval pool, the same recipe time budget, and one rewrite round only when no recipe passes the in-flow checks. The feed gives its recipe steps 33 seconds, its 48-second budget minus the 15 seconds it keeps for photos. The eval leaves the photo step out, so it makes no image calls.

A case that runs out of time or hits a Gemini error counts as a failed case, not as a harness error. The cook would see "AI unavailable" in that situation, so the eval reports it as a result.

### The judge answers checks, and code turns them into a score

The judge doesn't pick a score from 0 to 100. For each preference the cook stated, it writes its reasoning and then answers one yes-or-no question: is this preference met? Code turns the answers into the preference alignment score, the percentage of stated preferences met. The judge then lists every gross or implausible amount.

Yes-or-no answers vary less between runs than a number a model picks on a 100-point scale. Each miss also names the preference that failed, so a low score points at a cause you can fix, such as "missed diet" on the vegan cases. The reasoning comes before each answer because structured output is written in key order, so the model explains before it decides. If the judge skips, repeats, or invents a preference, `judge_recipe` refuses the grade. The recipe then counts as a judge failure instead of getting a wrong score.

### Read the scores with their limits in mind

- The judge runs on `gemini-3.6-flash`, the same model that writes the recipes. A model can grade its own writing leniently, so treat preference alignment as an upper bound.
- The in-flow checks already reject a recipe with an ungrounded ingredient or an amount over stock, so coverage and mapping validity sit at 100 in a healthy run. They are tripwires. A value under 100 means a recipe got past the in-flow checks that should have stopped it.
- 22 cases with two foods each is a small sample, and model output varies between runs. Compare experiments in LangSmith before you call a small change in a metric an improvement or a regression.
- The eval is not a CI gate. CI runs the offline harness tests on every push. A live run costs money and its scores vary, so a gate on it would fail at random.

## The dataset

`backend/app/ai/eval/dataset.json` holds 22 cases. `load_cases` in `backend/app/ai/eval/cases.py` validates them.

| Field | Meaning |
| --- | --- |
| `name` | A unique label for the case, such as `tomato pasta`. |
| `preferences` | The cook's answers. The keys are the app's preference questions: `meal`, `time`, `mood`, `cuisine`, `diet`, and `occasion`. The values are the app's own option labels, such as `Vegan` or `<30 min`. `occasion` is free text, and in the dataset it names the dish the cook wants. |
| `inventory` | The kitchen's foods, one `FoodLine` each, in the shape the recipe API reads from Supabase. |

Every case also has the five kitchen basics a new household starts with: salt, black pepper, neutral oil, olive oil, and water. Kitchen basics are staples that are always on hand.

## The rubric

### Code scorers

The code scorers are in `backend/app/ai/eval/scorers.py`. Each one scores one recipe from 0 to 100.

| Metric | Function | What it measures |
| --- | --- | --- |
| Coverage | `ingredient_coverage_percent` | The percentage of ingredients that map to a kitchen food, with kitchen basics left out. The app shows the same function's result as the match percentage on each recipe card. |
| Completeness | `completeness_percent` | The percentage of four structural checks that pass: a title, at least one ingredient, a name and a unit on every ingredient, and steps with instructions. |
| Mapping validity | `mapping_validity_percent` | The percentage of mapped ingredients the cook flow could deduct: the food exists in the kitchen, the amount is positive, and the exact amounts of every ingredient on that food add up to no more than its stock. Approximate and spoon-sized amounts count as valid, because the cook confirms them when cooking. |

### LLM judge

`judge_recipe` in `backend/app/ai/eval/judge.py` makes one Gemini call per recipe. Its prompt is `backend/app/ai/prompts/judge_recipe_v1.yaml`. The judge sees the stated preferences, the kitchen foods with their stock, the kitchen basics, and the recipe.

The judge writes one check for each stated preference and reads each answer this way:

| Preference | Met when |
| --- | --- |
| `meal` | For Breakfast, Lunch, or Dinner, people eat the dish as that meal, in a full portion. For Snack, the dish is snack-sized. For Dessert, the dish is sweet. |
| `time` | `total_minutes`, or `cook_time_minutes` when `total_minutes` is empty, is within the limit: 15 for `<15 min`, 30 for `<30 min`, and 60 for `<60 min`. `I have all night` is always met. |
| `mood` | Comfort is a warm, hearty, or familiar dish. `Light & clean` is fresh, not rich or heavy. Adventurous has bold flavors or is a less familiar dish. Fancy is a dish to serve guests. |
| `cuisine` | The dish belongs to or clearly draws on the cuisine. `Whatever works` is always met. |
| `diet` | High protein has a protein food as the main component. Keto has no grains, bread, pasta, rice, potatoes, beans, or sugar. Vegan has nothing from an animal. Vegetarian has no meat or fish. Gluten-free has no wheat, barley, or rye. None is always met. |
| `occasion` | The recipe is the named dish or a close version of it, or it suits the occasion described. |

The judge then lists every amount that is gross or implausible:

- an amount over what the kitchen holds,
- a zero or negative amount,
- a portion far outside normal for the servings, such as 1 kg of dry pasta per serving,
- a seasoning, fat, or liquid in an amount no cook would use, such as a cup of salt for two servings, or
- a unit that doesn't fit the food, such as cups of eggs.

## Run the evals

The runner is `backend/scripts/run_evals.py`, and it runs as one command from `backend/`. Set up the backend first, as [`backend/README.md`](../backend/README.md) describes.

### Run the offline evals

The offline evals need no keys, cost nothing, and never upload to LangSmith. Run them after you change the harness, the scorers, or the judge's code.

```sh
venv/bin/python -m scripts.run_evals
```

`OfflineModel` in `backend/app/ai/eval/offline.py` answers every model call with a fixture. Everything else is the real code: the graph, the in-flow code checks, the scorers, the judge's validation, and the scorecard. Every case gets a fixture recipe, and the judge's fixture answer meets every preference, so a healthy offline run scores 100 on every metric. A lower score means the harness broke. An offline run says nothing about recipe quality.

### Run the live evals

The live evals call Gemini for every recipe, meal review, and judge call. Gemini bills every live run.

1. In `backend/.env`, set `GEMINI_API_KEY`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY`. To log a LangSmith experiment, also set `LANGSMITH_API_KEY`.
2. Run the live mode with a name for the experiment:

	```sh
	venv/bin/python -m scripts.run_evals --live --experiment judge-prompt-v1
	```

Each case makes five generation calls and one meal review for each recipe that passes the code checks. When no recipe passes, the case makes one more round of rewrites and reviews. The case then makes one judge call per returned recipe. The scorecard's Gemini usage block shows the calls and tokens the run used.

### Runner options

| Option | Effect |
| --- | --- |
| `--live` | Runs on Gemini and the production vector store instead of fixtures. |
| `--experiment NAME` | Names the live run's LangSmith experiment. The default is `freshplate-live`. LangSmith adds a random suffix. |
| `--no-upload` | Runs live without logging a LangSmith experiment. |
| `--json` | Prints the scorecard as JSON instead of text. |

When `LANGSMITH_API_KEY` is set, a live run logs a LangSmith experiment unless you pass `--no-upload`. Offline runs never upload, so fixture scores never sit beside real ones. The runner exits with status 0 whatever the scores are.

## Read the scorecard

The runner prints a scorecard like this one, from an offline run:

```text
FreshPlate recipe eval (offline)
Experiment: not uploaded

Cases with recipes      22/22
Cases failed            0
Recipes scored          22
Coverage                100.0
Completeness            100.0
Mapping validity        100.0
Preference alignment    100.0
Quantity violation rate 0.000
Judge failures          0
Pipeline seconds        median 0.0, max 0.0

Case               Recipes   Pref  Qty    Sec  Notes
tomato pasta             1    100    0    0.0
chickpea curry           1    100    0    0.0
...

Gemini usage
  none
```

The recipe metrics average every recipe the pipeline returned, across all cases, so each card a cook could see counts once. A dash means that nothing was scored.

| Line | Meaning |
| --- | --- |
| Cases with recipes | Cases that returned at least one recipe, out of all cases. A case returns none when the kitchen can't make the dish, when every recipe fails the in-flow checks, or when the pipeline fails. |
| Cases failed | Cases whose pipeline failed, such as on its deadline. The case row's notes give the error. |
| Recipes scored | Recipes returned across all cases. A case returns up to five. |
| Coverage, Completeness, Mapping validity | The mean code scores, from 0 to 100. |
| Preference alignment | The mean percentage of stated preferences met, over the recipes the judge graded. |
| Quantity violation rate | The share of graded recipes with at least one quantity violation, from 0 to 1. |
| Judge failures | Recipes the judge couldn't grade. They count in the code scores but not in the judge's metrics. |
| Pipeline seconds | The median and the slowest wall time of a case's pipeline run. Compare them with the 33-second recipe budget. |

Each case row gives the recipes returned, the case's mean preference alignment (`Pref`), its total quantity violations (`Qty`), and its pipeline seconds (`Sec`). The notes name the preferences that any recipe missed, or the error when the pipeline failed.

The Gemini usage block has one line per response model. `RecipeBatchOf1` lines are generation calls, `MealCheck` lines are in-flow meal reviews, and `JudgeResult` lines are judge calls. Each line gives the call count, the failed calls, and the input, output, and thinking tokens. Gemini bills thinking tokens at the output rate. Retrieval also embeds one query per case, and the usage block doesn't count those calls.

### Read the experiment in LangSmith

An uploaded live run is one LangSmith experiment, and the scorecard prints its name and link. All experiments on the same cases share one LangSmith dataset, named `freshplate-recipe-eval-` followed by a hash of the cases. LangSmith's comparison view lines those experiments up case by case. Editing a case starts a new LangSmith dataset, so LangSmith never compares experiments that ran on different cases.

Each case is one trace. Its root run, `recipe_pipeline`, holds the graph's `analyze_inventory`, `retrieve_recipes`, and `write_recipes` runs. Each case gets the same numbers as its scorecard row, as this feedback:

| Key | Value |
| --- | --- |
| `recipes` | The number of recipes returned. The comment holds the pipeline's error, if any. |
| `pipeline_seconds` | Pipeline wall time. |
| `coverage`, `completeness`, `mapping_validity` | The mean code scores of the case's recipes. |
| `preference_alignment` | The mean judge score of the case's graded recipes. The comment names the missed preferences. |
| `quantity_violations` | The number of violations across the case's recipes. The comment lists them. |
| `judge_failures` | The number of recipes the judge couldn't grade, present only when there are any. |

The experiment's metadata records the mode, the model, the batch size, the LangSmith dataset name, and the versions of the `generate_recipes`, `assess_meals`, and `judge_recipe` prompts.
