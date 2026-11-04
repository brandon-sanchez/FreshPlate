"""Realistic household inventories for latency and quality probes.

Sizes and category mixes come from docs/household-inventory-research.md
(Stevens et al. 2011/2012 scanner inventories, the Rutgers home audit,
Byrd-Bredbenner & Bredbenner 2010). Each category list is ordered from common
to less common, so a fixture takes the first N items of every category and a
larger kitchen always contains the smaller ones.

Entry format: "name | quantity | unit | days until expiry" (blank days = shelf
stable). Items expiring within 5 days are flagged by ``analyze_inventory``.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

CATALOG: dict[str, str] = {
    "proteins": """
eggs|12|each|9
chicken breast|900|g|2
ground beef|450|g|1
bacon|340|g|6
chicken thighs|1000|g|3
deli turkey|200|g|4
salmon fillet|450|g|1
canned tuna|3|can|
canned black beans|2|can|
pork chops|600|g|3
firm tofu|400|g|8
canned chickpeas|2|can|
ground turkey|450|g|2
italian sausage|500|g|4
shrimp|450|g|1
dried lentils|500|g|
ham|300|g|6
canned kidney beans|1|can|
beef stew meat|700|g|2
sirloin steak|500|g|3
pork tenderloin|600|g|4
cod fillet|400|g|2
rotisserie chicken|1|each|3
canned salmon|1|can|
refried beans|1|can|
ground pork|450|g|2
chorizo|300|g|7
chicken drumsticks|900|g|3
chicken wings|1000|g|3
pepperoni|170|g|20
salami|200|g|15
canned white beans|2|can|
dried split peas|450|g|
tempeh|227|g|10
turkey breast|700|g|4
flank steak|680|g|3
lamb chops|500|g|3
short ribs|900|g|4
smoked salmon|113|g|7
tilapia fillet|450|g|2
scallops|300|g|1
sardines|2|can|
prosciutto|100|g|10
pork shoulder|1500|g|4
ribeye steak|450|g|3
ground lamb|450|g|2
duck breast|400|g|3
mussels|900|g|1
crab meat|227|g|3
canned black-eyed peas|1|can|
""",
    "produce": """
yellow onion|4|each|30
garlic|1|head|30
potatoes|2000|g|25
carrots|900|g|21
bananas|6|each|4
apples|6|each|28
lemons|3|each|21
tomatoes|4|each|5
romaine lettuce|1|head|5
broccoli|500|g|5
bell peppers|3|each|7
spinach|280|g|3
celery|1|bunch|14
cucumber|2|each|6
avocados|3|each|3
limes|4|each|14
green onions|1|bunch|6
mushrooms|227|g|4
zucchini|2|each|6
sweet potatoes|900|g|25
red onion|2|each|30
strawberries|454|g|2
oranges|5|each|21
cilantro|1|bunch|5
grapes|900|g|6
blueberries|340|g|5
cabbage|1|head|30
jalapenos|3|each|10
ginger|100|g|21
cauliflower|1|head|6
green beans|450|g|5
kale|1|bunch|5
corn on the cob|4|each|3
asparagus|450|g|3
parsley|1|bunch|6
brussels sprouts|450|g|6
shallots|4|each|30
cherry tomatoes|283|g|5
pears|4|each|10
basil|1|bunch|4
butternut squash|1|each|30
eggplant|1|each|5
peaches|4|each|4
leeks|2|each|10
arugula|142|g|4
radishes|1|bunch|10
mango|2|each|5
pineapple|1|each|4
beets|4|each|21
bok choy|2|each|4
fennel|1|each|7
watermelon|1|each|10
raspberries|170|g|2
kiwi|4|each|10
napa cabbage|1|head|10
snap peas|227|g|5
thyme|1|bunch|10
rosemary|1|bunch|10
mint|1|bunch|5
plantains|3|each|5
turnips|3|each|21
poblano peppers|2|each|7
okra|300|g|3
artichokes|2|each|5
dill|1|bunch|5
""",
    "dairy": """
milk|3.8|l|6
butter|454|g|30
cheddar cheese|227|g|25
liquid egg whites|500|ml|7
greek yogurt|907|g|10
shredded mozzarella|227|g|14
cream cheese|227|g|21
sour cream|454|g|14
parmesan|150|g|60
half and half|473|ml|7
heavy cream|473|ml|8
cottage cheese|454|g|7
string cheese|12|each|21
feta|170|g|14
sliced american cheese|340|g|30
plain yogurt|907|g|10
swiss cheese|200|g|25
buttermilk|946|ml|10
ricotta|425|g|5
pepper jack cheese|227|g|25
goat cheese|113|g|14
oat milk|1.9|l|7
provolone|200|g|25
whipped cream|200|g|10
brie|200|g|10
mascarpone|227|g|7
almond milk|1.9|l|7
gouda|200|g|30
blue cheese|113|g|21
fresh mozzarella|227|g|4
kefir|946|ml|10
queso fresco|283|g|7
ghee|340|g|90
halloumi|225|g|30
creme fraiche|200|ml|10
""",
    "frozen": """
frozen peas|454|g|180
frozen mixed vegetables|454|g|180
frozen corn|454|g|180
frozen broccoli|454|g|180
frozen chicken breasts|1360|g|180
frozen shrimp|907|g|180
frozen berries|907|g|180
frozen pizza|1|each|120
frozen fries|907|g|180
frozen spinach|283|g|180
ice cream|1.4|l|120
frozen ground beef|907|g|120
frozen waffles|10|each|120
frozen fish fillets|680|g|180
frozen meatballs|907|g|120
frozen dumplings|680|g|120
frozen edamame|340|g|180
frozen green beans|454|g|180
frozen burritos|8|each|120
frozen salmon|907|g|180
frozen chicken nuggets|907|g|120
frozen bread|1|loaf|90
frozen pie crust|2|each|120
frozen hash browns|907|g|120
frozen stir fry vegetables|454|g|180
frozen mango|454|g|180
frozen cauliflower rice|340|g|180
frozen pork chops|900|g|120
frozen turkey burgers|907|g|120
frozen tortellini|567|g|120
frozen pierogies|454|g|120
frozen egg rolls|8|each|120
frozen garlic bread|1|each|120
frozen lasagna|1|each|120
frozen okra|454|g|180
frozen butternut squash|340|g|180
frozen chicken thighs|1360|g|180
frozen scallops|454|g|180
frozen ravioli|708|g|120
frozen cod|907|g|180
frozen sausage links|340|g|120
frozen bagels|6|each|90
frozen naan|4|each|90
frozen puff pastry|490|g|120
frozen pineapple|454|g|180
frozen brussels sprouts|454|g|180
frozen pot stickers|680|g|120
frozen steak|900|g|180
frozen tilapia|907|g|180
frozen crab cakes|4|each|120
frozen lamb|900|g|180
frozen gnocchi|454|g|120
frozen artichoke hearts|340|g|180
frozen tamales|6|each|120
frozen udon noodles|5|each|120
""",
    "dry_goods": """
white rice|2000|g|
spaghetti|454|g|
all-purpose flour|2270|g|
sugar|1810|g|
bread|1|loaf|6
rolled oats|1190|g|
canned diced tomatoes|3|can|
penne|454|g|
brown sugar|907|g|
chicken broth|1.9|l|
breakfast cereal|510|g|
crackers|255|g|
peanut butter|454|g|
tortillas|10|each|14
canned tomato sauce|2|can|
macaroni|454|g|
brown rice|907|g|
breadcrumbs|425|g|
baking soda|454|g|
baking powder|227|g|
canned corn|2|can|
tomato paste|2|can|
honey|340|g|
egg noodles|340|g|
jasmine rice|2270|g|
canned soup|3|can|
beef broth|946|ml|
cornstarch|454|g|
popcorn kernels|850|g|
quinoa|680|g|
pancake mix|907|g|
granola|340|g|
canned green beans|2|can|
ramen noodles|6|each|
tortilla chips|368|g|
potato chips|283|g|
vegetable broth|946|ml|
couscous|283|g|
canned coconut milk|2|can|
lasagna noodles|454|g|
maple syrup|355|ml|
canned pumpkin|1|can|
rice noodles|397|g|
cornmeal|680|g|
jam|340|g|
pretzels|454|g|
basmati rice|907|g|
bagels|6|each|7
hamburger buns|8|each|7
canned peaches|1|can|
canned pineapple|1|can|
dried cranberries|170|g|
raisins|340|g|
almonds|454|g|
walnuts|227|g|
fettuccine|454|g|
rotini|454|g|
chocolate chips|340|g|
cocoa powder|227|g|
vanilla extract|59|ml|
yeast|3|each|
powdered sugar|907|g|
orzo|454|g|
farro|454|g|
barley|454|g|
canned mushrooms|1|can|
canned artichoke hearts|1|can|
sun-dried tomatoes|227|g|
roasted red peppers|340|g|
canned crushed tomatoes|2|can|
panko|227|g|
udon noodles|3|each|
soba noodles|227|g|
graham crackers|408|g|
pita bread|6|each|6
english muffins|6|each|8
cashews|454|g|
peanuts|454|g|
sunflower seeds|227|g|
chia seeds|340|g|
flaxseed|454|g|
whole wheat flour|2270|g|
bread flour|2270|g|
wild rice|454|g|
arborio rice|907|g|
polenta|500|g|
grits|680|g|
instant mashed potatoes|382|g|
stuffing mix|170|g|
mac and cheese boxes|3|each|
canned chili|2|can|
canned evaporated milk|1|can|
sweetened condensed milk|1|can|
canned olives|1|can|
canned water chestnuts|1|can|
canned bamboo shoots|1|can|
canned beets|1|can|
canned carrots|1|can|
canned spinach|1|can|
canned potatoes|1|can|
dried black beans|907|g|
dried pinto beans|907|g|
dried chickpeas|454|g|
pecans|227|g|
pistachios|454|g|
dried apricots|227|g|
dates|454|g|
coconut flakes|198|g|
rice cakes|6|each|
corn tortillas|30|each|21
lentil pasta|227|g|
gnocchi|500|g|
angel hair pasta|454|g|
ziti|454|g|
shells pasta|454|g|
bow tie pasta|454|g|
lo mein noodles|454|g|
glass noodles|250|g|
vermicelli|454|g|
matzo meal|454|g|
semolina|907|g|
masa harina|1810|g|
tapioca pearls|227|g|
sorghum|454|g|
millet|454|g|
buckwheat groats|454|g|
nutritional yeast|142|g|
dried mushrooms|28|g|
seaweed sheets|10|each|
rice paper|340|g|
wonton wrappers|340|g|10
canned jackfruit|1|can|
canned clams|1|can|
canned crab|1|can|
canned oysters|1|can|
canned anchovies|1|can|
canned corned beef|1|can|
canned spam|1|can|
canned hominy|1|can|
canned tomatillos|1|can|
canned chipotle peppers|1|can|
""",
    "condiments": """
ketchup|907|g|
yellow mustard|397|g|
mayonnaise|887|ml|
soy sauce|296|ml|
hot sauce|148|ml|
ranch dressing|473|ml|
barbecue sauce|510|g|
salsa|454|g|
pasta sauce|680|g|
dijon mustard|340|g|
pickles|710|ml|
italian dressing|473|ml|
worcestershire sauce|296|ml|
apple cider vinegar|473|ml|
white vinegar|946|ml|
sriracha|482|g|
balsamic vinegar|250|ml|
relish|296|ml|
teriyaki sauce|296|ml|
honey mustard|340|g|
pesto|190|g|
red wine vinegar|473|ml|
hoisin sauce|240|ml|
fish sauce|200|ml|
rice vinegar|355|ml|
oyster sauce|255|g|
tahini|454|g|
caesar dressing|473|ml|
buffalo sauce|354|ml|
sweet chili sauce|295|ml|
capers|100|g|
horseradish|227|g|
enchilada sauce|283|g|
curry paste|113|g|
miso paste|400|g|
gochujang|500|g|
alfredo sauce|425|g|
thousand island dressing|473|ml|
blue cheese dressing|473|ml|
tartar sauce|296|ml|
cocktail sauce|340|g|
steak sauce|283|g|
chili garlic sauce|226|g|
harissa|190|g|
tamari|296|ml|
mirin|296|ml|
sesame dressing|354|ml|
pizza sauce|397|g|
marinara|680|g|
salsa verde|454|g|
chutney|340|g|
kimchi|473|ml|
sauerkraut|907|g|
olive tapenade|190|g|
anchovy paste|56|g|
""",
    "spices": """
salt|737|g|
black pepper|113|g|
garlic powder|88|g|
onion powder|74|g|
paprika|60|g|
cinnamon|69|g|
chili powder|71|g|
cumin|43|g|
dried oregano|21|g|
italian seasoning|21|g|
red pepper flakes|42|g|
dried basil|17|g|
crushed red pepper|42|g|
smoked paprika|50|g|
bay leaves|5|g|
dried thyme|18|g|
cayenne pepper|45|g|
nutmeg|31|g|
ground ginger|23|g|
taco seasoning|28|g|
curry powder|48|g|
dried rosemary|19|g|
seasoned salt|227|g|
lemon pepper|99|g|
cajun seasoning|71|g|
garlic salt|88|g|
dried parsley|8|g|
turmeric|43|g|
ground cloves|31|g|
allspice|38|g|
dried dill|7|g|
coriander|35|g|
everything bagel seasoning|65|g|
poultry seasoning|14|g|
pumpkin pie spice|31|g|
dried sage|12|g|
celery salt|85|g|
white pepper|35|g|
mustard powder|48|g|
steak seasoning|99|g|
garam masala|48|g|
chinese five spice|48|g|
cardamom|45|g|
fennel seeds|40|g|
mustard seeds|60|g|
sesame seeds|113|g|
dried marjoram|8|g|
ground sumac|50|g|
za'atar|50|g|
herbes de provence|28|g|
ancho chili powder|50|g|
chipotle powder|50|g|
old bay seasoning|170|g|
star anise|20|g|
whole peppercorns|56|g|
cream of tartar|42|g|
saffron|1|g|
dried tarragon|8|g|
ras el hanout|45|g|
berbere|45|g|
dried chives|5|g|
caraway seeds|40|g|
celery seed|40|g|
anise seed|40|g|
onion flakes|56|g|
kosher salt|1360|g|
sea salt|737|g|
msg|113|g|
jerk seasoning|71|g|
adobo seasoning|226|g|
sazon|50|g|
furikake|50|g|
togarashi|20|g|
tandoori masala|50|g|
dried mint|10|g|
fenugreek|40|g|
nigella seeds|40|g|
juniper berries|20|g|
mace|20|g|
smoked salt|100|g|
""",
    "oils_fats": """
olive oil|1|l|
vegetable oil|1.4|l|
cooking spray|340|g|
canola oil|1.4|l|
coconut oil|414|ml|
sesame oil|148|ml|
shortening|453|g|
avocado oil|500|ml|
extra virgin olive oil|500|ml|
lard|454|g|
peanut oil|946|ml|
bacon grease|200|g|30
chili oil|200|ml|
truffle oil|60|ml|
grapeseed oil|500|ml|
walnut oil|250|ml|
duck fat|200|g|60
margarine|454|g|60
garlic oil|250|ml|
toasted sesame oil|148|ml|
""",
}

FIXTURE_SIZES: dict[str, dict[str, int]] = {
    "typical": {
        "proteins": 14,
        "produce": 22,
        "dairy": 12,
        "frozen": 12,
        "dry_goods": 40,
        "condiments": 20,
        "spices": 25,
        "oils_fats": 5,
    },
    "well-stocked": {
        "proteins": 24,
        "produce": 35,
        "dairy": 18,
        "frozen": 22,
        "dry_goods": 70,
        "condiments": 30,
        "spices": 40,
        "oils_fats": 11,
    },
    "post-costco": {
        "proteins": 34,
        "produce": 45,
        "dairy": 24,
        "frozen": 32,
        "dry_goods": 95,
        "condiments": 32,
        "spices": 45,
        "oils_fats": 13,
    },
    "extreme": {
        "proteins": 50,
        "produce": 65,
        "dairy": 35,
        "frozen": 55,
        "dry_goods": 140,
        "condiments": 55,
        "spices": 80,
        "oils_fats": 20,
    },
}


def _entries(category: str) -> list[tuple[str, float, str, int | None]]:
    rows = []
    for line in CATALOG[category].strip().splitlines():
        name, quantity, unit, days = (part.strip() for part in line.split("|"))
        rows.append((name, float(quantity), unit, int(days) if days else None))
    return rows


def household_inventory(
    size: str, *, today: date | None = None
) -> list[dict[str, Any]]:
    """Return the inventory for one fixture size, as the app sends it."""
    reference = today or date.today()
    items: list[dict[str, Any]] = []
    for category, count in FIXTURE_SIZES[size].items():
        entries = _entries(category)
        if count > len(entries):
            raise ValueError(f"{category} has {len(entries)} items, {count} requested")
        for name, quantity, unit, days in entries[:count]:
            items.append(
                {
                    "id": f"{category}-{name.replace(' ', '-')}",
                    "name": name,
                    "quantity": quantity,
                    "unit": unit,
                    "expiration_date": (
                        None if days is None else str(reference + timedelta(days=days))
                    ),
                    "category": category,
                }
            )
    return items


def category_of(item_id: str) -> str:
    return item_id.split("-", 1)[0]
