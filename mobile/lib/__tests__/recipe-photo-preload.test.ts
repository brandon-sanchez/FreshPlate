import { RECIPE_PHOTO_PRELOAD_CAP_MS } from "@/lib/recipe-photo-preload";
import type { ImageResult } from "@/types/images";

type Download = {
  uri: string;
  finish: () => void;
  fail: () => void;
};

let mockDownloads: Download[];

jest.mock("expo-image", () => ({
  Image: {
    loadAsync: ({ uri }: { uri: string }) =>
      new Promise((resolve, reject) => {
        mockDownloads.push({
          uri,
          finish: () => resolve({ release: jest.fn() }),
          fail: () => reject(new Error("download failed")),
        });
      }),
  },
}));

function photo(name: string): ImageResult {
  return {
    status: "ready",
    image_key: `key-${name}`,
    url: `https://images.test/${name}.webp`,
    expires_at: "2026-01-01T00:00:00Z",
    reason: null,
  };
}

function started(): string[] {
  return mockDownloads.map(({ uri }) => uri.replace("https://images.test/", ""));
}

async function settle(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

// Each test gets its own copy of the module, as a freshly launched app does.
function freshPreload() {
  jest.resetModules();
  return jest.requireActual<typeof import("@/lib/recipe-photo-preload")>(
    "@/lib/recipe-photo-preload",
  ).preloadRecipePhotos;
}

describe("preloadRecipePhotos", () => {
  beforeEach(() => {
    mockDownloads = [];
    // Drops the preload cap timer of a page a test leaves unfinished.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("holds a page's other photos until the app's first download has finished", async () => {
    const preload = freshPreload();

    const page = preload([photo("a"), photo("b"), photo("c"), photo("d")]);
    await settle();
    expect(started()).toEqual(["a.webp"]);

    mockDownloads[0].finish();
    await settle();
    expect(started()).toEqual(["a.webp", "b.webp", "c.webp", "d.webp"]);

    mockDownloads.slice(1).forEach(({ finish }) => finish());
    await expect(page).resolves.toBeUndefined();
  });

  it("holds an overlapping page's photos behind the first download too", async () => {
    const preload = freshPreload();

    void preload([photo("a"), photo("b")]);
    void preload([photo("c")]);
    await settle();
    expect(started()).toEqual(["a.webp"]);

    mockDownloads[0].finish();
    await settle();
    expect(started()).toEqual(["a.webp", "b.webp", "c.webp"]);
  });

  it("starts the other photos when the first download fails", async () => {
    const preload = freshPreload();

    const page = preload([photo("a"), photo("b")]);
    await settle();
    mockDownloads[0].fail();
    await settle();
    expect(started()).toEqual(["a.webp", "b.webp"]);

    mockDownloads[1].finish();
    await expect(page).resolves.toBeUndefined();
  });

  it("shows a page at the cap while the first download is still running", async () => {
    const preload = freshPreload();
    let shown = false;

    void preload([photo("a"), photo("b")]).then(() => {
      shown = true;
    });
    await jest.advanceTimersByTimeAsync(RECIPE_PHOTO_PRELOAD_CAP_MS - 1);
    expect(shown).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(shown).toBe(true);
    expect(started()).toEqual(["a.webp"]);
  });

  it("downloads every photo of a later page at once", async () => {
    const preload = freshPreload();
    const first = preload([photo("a")]);
    await settle();
    mockDownloads[0].finish();
    await first;

    void preload([photo("b"), photo("c"), photo("d")]);
    await settle();

    expect(started()).toEqual(["a.webp", "b.webp", "c.webp", "d.webp"]);
  });

  it("skips results that have no photo to download", async () => {
    const preload = freshPreload();

    await preload([
      {
        status: "pending",
        image_key: "key-p",
        url: null,
        expires_at: null,
        reason: null,
      },
      {
        status: "unavailable",
        image_key: "key-u",
        url: null,
        expires_at: null,
        reason: "failed",
      },
    ]);

    expect(started()).toEqual([]);
  });
});
