import type { RecipeFeedSessionRequest } from "@/types/recipes";

const mockApiFetch = jest.fn();

jest.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import {
  createRecipeFeedSession,
  RECIPE_FEED_REQUEST_TIMEOUT_MS,
} from "@/lib/recipe-feed-api";

const request: RecipeFeedSessionRequest = {
  inventory: [],
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
});
