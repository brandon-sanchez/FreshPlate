import type { RecipeFeedSessionRequest } from "@/types/recipes";

const mockApiFetch = jest.fn();

jest.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import {
  createRecipeFeedSession,
  fetchRecipeFeedPage,
  RECIPE_FEED_REQUEST_TIMEOUT_MS,
} from "@/lib/recipe-feed-api";

const request: RecipeFeedSessionRequest = {
  household_id: "household-1",
  preferences: {},
};

describe("recipe feed API", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("aborts a session request at the mobile deadline", async () => {
    jest.useFakeTimers();
    mockApiFetch.mockImplementation(
      (_path: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
        }),
    );

    const pending = createRecipeFeedSession(request);
    jest.advanceTimersByTime(RECIPE_FEED_REQUEST_TIMEOUT_MS);

    await expect(pending).rejects.toThrow("Aborted");
    jest.useRealTimers();
  });

  it("sends a page's steering only when there is some", async () => {
    mockApiFetch.mockResolvedValue({});
    const steering = { more_like: ["recipe-1"], less_like: [] };

    await fetchRecipeFeedPage({ sessionId: "session-1", cursor: "5" });
    await fetchRecipeFeedPage({ sessionId: "session-1", cursor: "10", steering });

    const bodies = mockApiFetch.mock.calls.map(
      ([, init]: [string, RequestInit]) => JSON.parse(String(init.body)),
    );
    expect(bodies).toEqual([
      { cursor: "5", limit: 5 },
      { cursor: "10", limit: 5, steering },
    ]);
  });
});
