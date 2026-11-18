import { pinnedOffset, stickyOffset } from "@/lib/stickyOffset";

const header = { pinHeight: 60, top: 500, height: 40, nextTop: 900 };

it("leaves a header in place until it reaches the pinned header", () => {
  expect(stickyOffset({ ...header, scrollY: 0 })).toBe(0);
  expect(stickyOffset({ ...header, scrollY: 440 })).toBe(0);
});

it("holds a header just below the pinned header while its section scrolls", () => {
  expect(stickyOffset({ ...header, scrollY: 600 })).toBe(160);
});

it("lets the next section's header push a header away", () => {
  expect(stickyOffset({ ...header, scrollY: 820 })).toBe(360);
  expect(stickyOffset({ ...header, scrollY: 1000 })).toBe(360);
});

it("keeps the last header stuck when no header follows", () => {
  expect(stickyOffset({ ...header, nextTop: null, scrollY: 2000 })).toBe(1560);
});

it("leaves a header that hasn't been laid out in place", () => {
  expect(stickyOffset({ ...header, height: -1, scrollY: 2000 })).toBe(0);
});

it("pins the pinned header once the list scrolls past it, and not on overscroll", () => {
  expect(pinnedOffset(100, 180)).toBe(0);
  expect(pinnedOffset(300, 180)).toBe(120);
  expect(pinnedOffset(-40, 180)).toBe(0);
});
