import { anchoredFrame } from "@/lib/anchoredFrame";

const phone = { width: 440, height: 956 };

it("hangs under the anchor, right edges aligned, growing from the anchor's center", () => {
  const frame = anchoredFrame(
    { x: 379, y: 191, width: 45, height: 45 },
    phone,
    34,
    284,
  );

  expect(frame).toEqual({
    top: 242,
    left: 140,
    width: 284,
    maxHeight: 666,
    originX: 261.5,
  });
});

it("stays 8 points inside a narrow window", () => {
  const frame = anchoredFrame(
    { x: 10, y: 100, width: 45, height: 45 },
    { width: 300, height: 600 },
    0,
    284,
  );

  expect(frame.width).toBe(284);
  expect(frame.left).toBe(8);
  expect(frame.maxHeight).toBe(600 - 151 - 14 - 14);
  expect(frame.originX).toBe(24.5);
});

it("keeps the scale origin off the rounded corner", () => {
  const frame = anchoredFrame(
    { x: 420, y: 0, width: 20, height: 20 },
    phone,
    0,
    284,
  );

  expect(frame.left).toBe(148);
  expect(frame.originX).toBe(284 - 14);
});
