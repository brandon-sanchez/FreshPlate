# Recipe generation rubric

This reference records the evidence behind prompt version 3 and the checks used when reviewing generated meals.

The curated instruction cases in `backend/app/ai/eval/instruction_fixtures.json` give the judge four labeled examples: vague instructions, missing heat or timing, an unsupported ingredient, and a complete brief pasta recipe. The fixture test validates the case schema and the expected outcome for each named case. These cases guide evaluation and do not claim that a FakeProvider obeys the prompt.

## Sources

- [Fresh Midwest excerpt on Epicurious](https://www.epicurious.com/recipes/food/views/chicken-and-potato-skillet) by cookbook author Maren Ellingboe King: four servings use four thighs and two pounds of potatoes. The method names the skillet, heat, browning cue, bake time, thermometer endpoint, and potato tenderness.
- [Martha Stewart's Cooking School excerpt on Epicurious](https://www.epicurious.com/recipes/food/views/buttermilk-fried-chicken-393756): the cookbook excerpt specifies oil temperature, batch spacing, temperature maintenance, and an instant-read thermometer check.
- [USDA FSIS safe temperature chart](https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation/food-safety-basics/safe-temperature-chart): poultry reaches 165°F and fish reaches 145°F. The agency also advises separating raw foods and refrigerating perishables promptly.
- [Bon Appétit Salt and Pepper Fish](https://www.bonappetit.com/recipe/salt-and-pepper-fish): four servings use 1.5 pounds of cod and rice; golden browning and caramelized scallions provide observable cues.
- [Epicurious Pan-Roasted Chicken with Harissa Chickpeas](https://services.epicurious.com/recipes/food/views/pan-roasted-chicken-with-harissa-chickpeas-51209850): eight thighs and two cans of chickpeas make four servings; batching, simmering, roasting, and lemon finishing are explicit.
- [BBC Good Food Spinach and Chickpea Curry](https://www.bbcgoodfood.com/recipes/spinach-chickpea-curry): four servings use two cans of chickpeas and spinach; the tomato reduction and residual-heat wilting are explicit.
- [BBC Good Food Mushroom and Rice One-Pot](https://www.bbcgoodfood.com/recipes/mushroom-rice-one-pot): four servings use 200g rice, 250g mushrooms, vegetables, and stock; covered baking ends when rice is tender.
- [Food52 Lentil Bolognese](https://food52.com/recipes/8555-lentil-bolognese): lentils cook until al dente, aromatics soften, dairy and wine reduce, and the sauce simmers before pairing with pasta or polenta.
- [Food52 Khara Huggi](https://food52.com/recipes/83331-pongal-recipe): rice and moong dal serve four; toasted lentils smell nutty and the finished dish is creamy like risotto.
- [The Mediterranean Dish Easy Baked Fish](https://www.themediterraneandish.com/baked-fish-recipe/): two pounds of fish serve six; refrigerated marinating, 425°F baking, opacity, flaking, and 145°F are all specified.

## Review tests

- A four-serving chicken meal uses a quantity that matches the stated servings. The exact amount depends on the cut and the rest of the dish.
- A four-serving fish meal has about 1.25–1.5 pounds or four fillets, a side plan, thickness-aware timing, and a thermometer endpoint of 145°F. Opacity and easy flaking are useful additional cues.
- A vegan four-serving meal uses quantities that make the named dish substantial. Do not present garnish quantities as the main ingredient.
- Every meal states servings, uses the number of meaningful ordered steps its method needs, names heat or equipment where relevant, gives useful timing, supplies a sensory or thermometer cue where relevant, and explains serving or resting where relevant.
- Each step begins with a short action heading, then a newline and one or two concise sentences for one cooking stage. Separate stages use separate steps.
- Reviewers judge role, quantity, technique, and plate completeness together. They do not use a fixed ingredient count, calorie cutoff, or minimum word count as a quality proxy.
