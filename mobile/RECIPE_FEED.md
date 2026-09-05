# Recipe feed design

The native recipe flow adapts these 21st catalog components:

| App component | Catalog reference | Adaptation |
| --- | --- | --- |
| Recipe carousel | [Scrollable Card Stack](https://21st.dev/@educalvolpz/components/scrollable-card-stack) | A centered, upright vertical stack matching the supplied visual examples. Smaller neighbors overlap above and below; only the centered card accepts taps or accessibility focus. Recipes stay in cursor order and never loop. |
| Recipe cards | [Offer Carousel](https://21st.dev/@ravikatiyar162/components/offer-carousel) | Image area, rounded card, title, recipe facts, ingredients, and actions. Artwork remains a placeholder. |
| Action buttons | [Interactive Hover Button](https://21st.dev/@dillionverma/components/interactive-hover-button) | Dot-to-fill motion on native press and keyboard focus, with an accent primary action. |
| Session context | [AI Chat Input](https://21st.dev/@jahed/components/ai-chat-input) | Expandable text input and submit action. Context applies to the current recipe session. |
| Initial generation | [AI Loader](https://21st.dev/@beratberkayg/components/ai-loader) | Animated ring, generation label, and progress copy. |
| Preference answers | [Radio Group](https://21st.dev/@originui/components/radio-group) | Native radio rows with selected state and automatic advancement. |

The app uses React Native views and animation APIs for these interactions. Colors come from the Evergreen theme; typography remains Inter and Fraunces.
Ingredient details use a scrollable sheet. The bottom navigation uses native liquid glass on supported iOS versions, blur on older iOS versions, and an opaque background on Android or with Reduce Transparency enabled.

The stack uses native pan gestures, with previous/next buttons as an alternative. A fling advances at most two recipes. Dismissal moves the successor into the centered position; an arriving batch replaces a reached loading tail without resetting that position.
Larger text and viewports that cannot fit the full card plus its neighbors use free scrolling. Reduce Motion keeps the static stack and disables animated navigation, entry, dismissal, and skeleton pulse.
The bottom navigation hides while the software keyboard is open.

## Loading behavior

The feed maintains a target reserve of 10 to 20 unseen cards using observed refill latency and scroll consumption.
Only one refill runs at a time. Each response triggers another reserve check.
If browsing outruns generation, a skeleton with the same card dimensions appears at the tail.

The backend limits each session to six generation attempts. The ending describes the current set of ideas, since that limit does not establish that every possible recipe has been found.
Recipe images and recipe-detail cooking actions remain separate work.

## Verify the flow

1. Generate from inventory, then repeat through the preference questions and optional context field.
2. Swipe up and down through several cards. Check that the centered card stays upright and the smaller neighbors layer above and below. Repeat with the arrow buttons. Only the centered card’s actions should be reachable.
3. Press **Not this**. Check that the card fades upward and the next card moves into its place without jumping.
4. Open **Ingredients** and check names, quantities, scrolling, and dismissal.
5. Scroll rapidly during a slow refill. Check the skeleton, recovery, and absence of repeated cards.
6. Reach the session ending. Check **Add items** and **Edit answers**.
7. Repeat with dark mode, larger text, and Reduce Motion. Check that card actions remain reachable and navigation stays clear of the keyboard.

Run `npm test -- --runInBand` and `npx tsc --noEmit` from `mobile/`.
Hook tests simulate refill durations of 1, 25, and 35 seconds across six batches. These tests check scheduling and card retention, not device frame rate.
