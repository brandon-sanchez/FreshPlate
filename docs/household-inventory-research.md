# Household food inventory size: research for recipe-pipeline fixtures

Researched 2026-11-04. Goal: real numbers for how many food items households keep, so we can test the recipe pipeline on realistic and extreme kitchens. Every number has a citation in brackets, for example [S1]. **Secondary** means a news report or press summary of someone else's data. **Unverified** means we could not reach the primary source or its method.

## Summary

- **Measured home inventories put the average family kitchen at about 150 to 200 food items.** A UPC-scan inventory of 80 low-income North Carolina families found an average of 147 items, not counting herbs, spices or leftovers [S1]. A follow-up paper on the same cohort reports a first-visit mean of 194 (SD 97, median 177) [S2].
- **Bigger or better-off homes hold about 250 to 300 food products.** A Rutgers audit of 100 New Jersey homes reports this range, and it excludes condiments, spices and bulk staples [S3, secondary]. Across 160 families of mixed income, inventories ranged from **13 to 389 foods** [S4, abstract only].
- **Sparse kitchens are much smaller.** In 100 university dorm rooms, students had a mean of **47** food and beverage items, with a range of 0 to 208 [S5].
- **The spice rack adds about 40 items.** McCormick estimates that the average American kitchen has about 40 spices and seasonings, up from about 10 in the 1950s [S6, secondary company estimate]. Most studies leave spices out of their counts, so these 40 come on top of the figures above.
- **Households shop about 2.8 times a week** (USDA FoodAPS [S7]; FMI 2026 also reports 2.8 [S8, secondary]). A stock-up trip averages about **16 distinct items**, and a fill-in trip about 9 [S9, secondary, 2005 data]. Costco says its average transaction is about **$150** [S10, secondary]. Members make about 32 to 33 trips a year [S11, secondary, Numerator panel].
- **Fresh proteins and soft produce last 1 to 5 days in the fridge** (ground meat, poultry and fish 1 to 2 days; berries 2 to 3 days; greens 1 to 2 days) [S12, S13]. These items drive any "expiring soon" flag.
- **Much of what goes into the fridge is not finished.** In a US refrigerator study, people finished only about 40 to 50% of meat, vegetables, fruit and dairy items, although they expected to eat 71 to 97% [S14]. UK homes wasted 6.4 Mt of food in 2021, of which 4.7 Mt was edible. £3bn of that waste was food past its label date [S15].

## 1. How many distinct items a household keeps

| Household type | Count | What was counted | Source |
|---|---|---|---|
| Student, dorm room | mean 47, range 0–208 | food and beverage items per room | [S5] |
| Low-income family with an infant (NC) | mean 147 | all food and drink, not herbs, spices or leftovers | [S1] |
| Same cohort, first visit | mean 194, SD 97, median 177 | food items | [S2] |
| Average NJ home | 250–300 | food products, not condiments, spices or bulk staples | [S3, secondary] |
| 160 families, mixed income | 13–389 | foods on hand | [S4, abstract only] |

**Caveat on units versus distinct items.** None of these studies says clearly whether three cans of the same beans count as one item or three. Scanning-based methods probably count each package. That makes these counts an upper estimate of *distinct* items before spices are added. Adding back about 40 spices [S6] and the condiments that [S3] leaves out pushes the totals back up. Our working estimate is about **150 distinct items for a typical home**, **about 45 for a sparse one**, and **250 to 300 for a well-stocked one**.

**A credible extreme upper bound.** The highest observed count is 389 [S4]. That figure matches the mean plus 2 SD in [S2] (194 + 2 × 97 = 388). If a serious cook adds 60 to 80 spices and a large condiment collection, about **450 to 500** is a defensible stress ceiling. The 500 figure is our own inference, not a measured value.

**Trend.** Circana reports that households stored 10% fewer pantry items in 2023 than in 2020, and calls this a shift toward "just-in-time" stocking [S16, secondary].

## 2. Category mix

**No source we found gives item-count shares across all of the categories we need.** Home-inventory papers report totals or nutrients, not category counts [S1, S2]. The anchors we do have:

- **Spices and seasonings:** about 40 in an average kitchen [S6, secondary]. One survey sponsored by Kenwood found about 10 [unverified, methods unknown].
- **Canned goods:** an average of 24 cans in the pantry, and 5 canned items used a week [S17, secondary, survey sponsored by the Can Manufacturers Institute (CMI), 2013]. These are units, not distinct items.
- **Condiments and sauces:** a radio poll claims 8 sauces in the fridge [unverified]. YouGov found that 35% of Americans say they probably have expired condiments at home [S18].
- **What gets wasted, by value (a rough proxy for how common the perishables are):** meat, poultry and fish make up 30% of US retail and consumer food loss, vegetables 19% and dairy 17% [S19]. In the UK, fresh vegetables and salad make up 28% of household food waste by weight [S15].

The category counts in the fixtures below are therefore **our own design choices**. They are anchored on the spice count, on dry goods being the largest group (pantry items last longest and pile up), and on perishables being a minority of items but the majority of expiring ones.

## 3. Shelf life and "expiring soon"

Refrigerator storage times from university extension guidance [S12, S13]:

| Item | Fridge life |
|---|---|
| Ground meat, poultry, fish and shellfish | 1–2 days |
| Steaks, chops, roasts | 3–5 days |
| Leftovers, opened deli meat | 3–5 days |
| Bacon | 7 days |
| Eggs in the shell | 3–5 weeks |
| Opened mayonnaise | 2 months |
| Berries, leafy greens, herbs, corn | 1–3 days |
| Broccoli, grapes, green onions | 3–5 days |
| Lettuce | 5–7 days |
| Root vegetables | 1–2 weeks |
| Apples (crisper) | up to 1 month |

In the freezer, meat keeps 3 to 12 months [S12], so frozen items almost never count as expiring soon.

**No source measures how many items in a home are within N days of expiry at a given moment.** Our estimate below comes from the table above. In a typical home, about 15 to 25 items are short-life fresh proteins and produce. At any moment, roughly half to two-thirds of them are within 5 days. A few long-life items, such as opened condiments and dairy, are also near their dates. Our estimate is that **about 10% of all items, or about 25 to 30% of fridge items, are within 5 days of expiry.** Right after a big shopping trip, the share of fresh *proteins* expiring soon goes **up**, because raw meat and fish have only 1 to 2 days of fridge life unless frozen [S12].

## 4. Basket size and trip frequency

- **Frequency:** households make 2.8 trips a week to large grocery stores and supermarkets, and get food from some source 11 times a week [S7]. Individual shoppers make 1.6 trips a week, and households spend $169 a week on groceries [S8, secondary, FMI 2026].
- **Items per supermarket trip** (Unilever, 2005): quick trip 3.5, quick meal 4.8, fill-in 9.1, stock-up 16.2 [S9, secondary, dated]. In 2014, dunnhumby found that 31% of supermarket visits involve 3 or fewer products [S20, secondary].
- **Warehouse club:** Costco says its average transaction is about $150 [S10, secondary]. Numerator's receipt panel shows about 33 trips a year and about $3,200 a year per Costco shopper [S11, secondary]. Costco stocks fewer than 4,000 active SKUs per warehouse [S21, secondary]. **We found no published items-per-trip figure for Costco** (see open questions).

**Sanity check for the post-Costco fixture.** A $150 club trip of multipacks and bulk packs probably adds only about 20 to 40 *distinct* items, because many of them restock things the home already has. This estimate is unverified. Adding a same-week supermarket stock-up of about 16 items [S9] to a well-stocked base of about 250 gives about **300 to 320 distinct items**.

## Proposed fixtures

Counts are distinct items. "Proteins" covers fresh and frozen meat and fish, eggs, tofu and legumes (dry and canned). "Frozen" covers non-protein frozen food. "Dry goods" covers grains, pasta, flour, sugar, canned goods, bread, cereal and snacks.

| Fixture | Total | Proteins | Produce | Dairy | Frozen | Dry goods | Condiments & sauces | Spices & seasonings | Oils & fats | Fridge / Freezer / Pantry | Expiring ≤5 days |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Sparse (optional, student or single person) | 45 | 4 | 6 | 5 | 5 | 12 | 6 | 5 | 2 | 15 / 7 / 23 | ~5 |
| **A. Typical household** | **150** | 14 | 22 | 12 | 12 | 40 | 20 | 25 | 5 | 44 / 17 / 89 | **~15** |
| **B. Well-stocked** | **250** | 24 | 35 | 18 | 22 | 70 | 30 | 40 | 11 | 70 / 35 / 145 | **~25** |
| **C. Post-Costco full** | **320** | 34 | 45 | 24 | 32 | 95 | 32 | 45 | 13 | 95 / 50 / 175 | **~35** |
| **D. Extreme upper bound** | **500** | 50 | 65 | 35 | 55 | 140 | 55 | 80 | 20 | 150 / 85 / 265 | **~60** |

Why these sizes:

- **Sparse (45)** matches the dorm-room mean of 47 [S5].
- **Typical (150)** matches the EHFI mean of 147 [S1]. That figure leaves spices out but probably counts duplicate packages, and we assume the two roughly cancel. It sits below the median of 177 [S2] because we count distinct items.
- **Well-stocked (250)** is the low end of the Rutgers "average home" range of 250 to 300 [S3]. It is also close to the [S2] mean plus 1 SD (about 290). It includes McCormick's spice count of 40 [S6].
- **Post-Costco (320)** is well-stocked plus about 40 new distinct items from a club trip and about 16 from a supermarket stock-up [S9, S10]. Its expiring count rises because fresh meat and fish bought in bulk last 1 to 2 days unless frozen [S12].
- **Extreme (500)** is the observed maximum of 389 [S4], which equals the [S2] mean plus 2 SD, plus 60 to 80 spices and a large sauce collection. It is a stress ceiling, not a typical home.
- **Expiring ≤5 days** is about 10 to 12% of items in every fixture, concentrated in fresh proteins, soft produce and opened dairy (see section 3). This is our derived estimate, not a measured value.

## Open questions and unverified items

- **Units versus distinct items.** No study clearly separates "3 cans of beans" from "beans". Every count above may overstate distinct items by an unknown amount.
- **Rutgers 250–300** [S3] comes from a trade-press summary that we could not open (HTTP 403). We have not seen the primary paper.
- **Byrd-Bredbenner 13–389** [S4]: we read only the abstract. We do not know whether the count includes spices or condiments.
- **McCormick's 40 spices** [S6] is a company estimate from 2010 with no published method.
- **Costco items per trip:** not found. The estimate of 20 to 40 new distinct items is our assumption. Numerator's panel figures come only from its receipt app, and Costco disputes its dollar-per-trip estimate [S10].
- **Items per supermarket trip** [S9] is 2005 Unilever data from a trade article. We found no current Circana or NielsenIQ figure.
- **Category shares:** no source gives them. The fixture splits are design choices.
- **Share of items expiring:** no source measures a point-in-time count. This is derived from storage-time tables.
- **Will users log spices and condiments at all?** If FreshPlate users skip them, real inventories will look about 30 to 40% smaller than these fixtures. Check this against production data.
- The Davenport et al. refrigerator inventory dataset [S14] (Mendeley, CC BY 4.0) has item-level fridge contents and could give real fridge category counts if downloaded.

## Sources

- [S1] Stevens J, Bryant M, Wang L, Borja J, Bentley ME. "Exhaustive measurement of food items in the home using a universal product code scanner." *Public Health Nutrition* 14(2):314–318, 2011. https://doi.org/10.1017/S1368980010001837 (primary; full text read)
- [S2] Stevens J, Bryant M, Wang C-H, Cai J, Bentley ME. "Sample size and repeated measures required in studies of foods in the homes of African-American families." *J Nutrition* 142(6):1123–1127, 2012. https://pmc.ncbi.nlm.nih.gov/articles/PMC3349983 (primary)
- [S3] Progressive Grocer, "Rutgers, Gladson Interactive Peer into Pantries to Gain Nutrition Insights." https://progressivegrocer.com/rutgers-gladson-interactive-peer-pantries-gain-nutrition-insights (secondary; page returned 403, figures taken from search excerpt)
- [S4] Byrd-Bredbenner C, Bredbenner CA. "Assessing the home food environment nutrient supply using mobile barcode (UPC) scanning technology." *Nutrition & Food Science*, 2010. https://doi.org/10.1108/00346651011044005 (primary; abstract only)
- [S5] Nelson MC, Story M. "Food environments in university dorms: 20,000 calories per dorm room and counting." *Am J Prev Med* 36(6):523–526, 2009. PMID 19356889 (primary; abstract)
- [S6] CBS News, "Spice usage soars," 13 Aug 2010, quoting a McCormick estimate. https://www.cbsnews.com/news/spice-usage-soars-seasoning-us-melting-pot (secondary)
- [S7] USDA ERS, "USDA's FoodAPS: Providing insights into U.S. food demand," *Amber Waves*, Aug 2017. https://www.ers.usda.gov/amber-waves/2017/august/usda-s-foodaps-providing-insights-into-u-s-food-demand-and-food-assistance-programs (primary)
- [S8] The Shelby Report on FMI *U.S. Grocery Shopper Trends 2026*, 20 May 2026. https://theshelbyreport.com/2026/05/20/fmi-report-finds-shoppers-visit-more-than-5-grocery-banners-per-month/ (secondary)
- [S9] Chief Marketer, "Walk This Way," 1 Jul 2005, citing Unilever trip data. https://chiefmarketer.com/walk-this-way (secondary, dated)
- [S10] Nexstar/The Hill, "How much does the average Costco shopper spend per visit?" https://digital-release.thehill.com/?p=3912068 (secondary; Costco spokesperson)
- [S11] MMCG, "Costco vs Sam's Club in 2026," citing Numerator. https://www.mmcginvest.com/post/costco-vs-sam-s-club-in-2026-a-comparative-analysis-of-the-u-s-warehouse-club-market (secondary)
- [S12] University of Minnesota Extension, "Storage times for food in the refrigerator and freezer," reviewed 2021. https://extension.umn.edu/preserving-and-preparing/storage-times-food-refrigerator-and-freezer (primary guidance)
- [S13] Scott A., "Safe Storage of Fresh Fruits and Vegetables," Texas A&M AgriLife Extension E-200, 2008. https://aggie-horticulture.tamu.edu/wp-content/uploads/2017/10/safe_storage_of_fresh_fruits_and_vegetables_200.pdf (primary guidance)
- [S14] Davenport M, Qi D, Roe B. *Resources, Conservation and Recycling* 150, 2019, doi:10.1016/j.resconrec.2019.104440; press release https://www.eurekalert.org/news-releases/662807; data https://data.mendeley.com/datasets/yx9ffwdgjg/1 (primary study; figures from press release)
- [S15] WRAP, "Urgent action needed at scale to tackle food waste in our homes," 23 Nov 2023 (2021 data). https://wrap.ngo/media-centre/press-releases/urgent-action-needed-scale-tackle-food-waste-our-homes (primary)
- [S16] Circana podcast page, "A sneak peek into Inside America's Kitchen." https://circana.com/podcasts/a-sneak-peek-into-inside-americas-kitchen (secondary; we could not confirm the figure on the current page)
- [S17] Packaging World, "Survey: canned foods stocked in 98% of Americans' kitchens," 2013 (CMI-sponsored). https://www.packworld.com/design/materials-containers/news/13363651/survey-canned-foods-stocked-in-98-of-americans-kitchens (secondary; page returned 403, figures from search excerpt)
- [S18] YouGov, condiments survey. https://yougov.com/en-us/articles/54116-americans-favorite-condiments (primary survey)
- [S19] Buzby JC, Wells HF, Hyman J. *The Estimated Amount, Value, and Calories of Postharvest Food Losses at the Retail and Consumer Levels in the United States*, USDA ERS EIB-121, 2014. https://ers.usda.gov/publications/43836 (primary)
- [S20] Coupons in the News, 27 Jun 2014, citing dunnhumby. https://couponsinthenews.com/2014/06/27/three-items-or-less-why-so-many-are-buying-so-little-so-often/ (secondary)
- [S21] Priceva, "Costco vs. Sam's Club vs. BJ's," citing Costco annual reporting. https://priceva.com/blog/costco-vs-sams-club-vs-bjs (secondary)
