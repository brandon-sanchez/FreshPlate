import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  loadRecipeFeedMemory,
  saveRecipeFeedMemory,
} from "@/lib/recipe-feed-memory";

const memory = {
  sessionId: "session-1",
  dismissedIds: ["recipe-1"],
  signals: [{ direction: "less" as const, recipeId: "recipe-2" }],
};
const empty = (sessionId: string) => ({ sessionId, dismissedIds: [], signals: [] });

describe("recipe feed memory", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it("returns what was saved for the same session", async () => {
    await saveRecipeFeedMemory(memory);

    await expect(loadRecipeFeedMemory("session-1")).resolves.toEqual(memory);
  });

  it("keeps only the newest session", async () => {
    await saveRecipeFeedMemory(memory);
    await saveRecipeFeedMemory(empty("session-2"));

    await expect(loadRecipeFeedMemory("session-1")).resolves.toEqual(
      empty("session-1"),
    );
  });

  it.each([
    ["unreadable JSON", "{"],
    ["a wrong shape", JSON.stringify({ ...memory, signals: [{ direction: "up" }] })],
  ])("starts empty from %s", async (_, stored) => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await AsyncStorage.setItem("freshplate.recipe-feed-memory", stored);

    await expect(loadRecipeFeedMemory("session-1")).resolves.toEqual(
      empty("session-1"),
    );
    jest.restoreAllMocks();
  });
});
