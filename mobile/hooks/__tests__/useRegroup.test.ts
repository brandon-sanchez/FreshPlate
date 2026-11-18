import { act, renderHook } from "@testing-library/react-native";
import { useRegroup } from "@/hooks/useRegroup";

async function frames(count: number) {
  for (let frame = 0; frame < count; frame++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 16)));
  }
}

function setup() {
  const hide = jest.fn();
  const show = jest.fn();
  const onHidden = jest.fn();
  const hook = renderHook(() => useRegroup({ hide, show, onHidden, fillTo: 12 }));
  return { hide, show, onHidden, result: hook.result };
}

it("keeps the rows until they fade out, then applies the new grouping and shows it", async () => {
  const { hide, show, onHidden, result } = setup();
  const apply = jest.fn();
  expect(result.current.rowCap).toBeNull();

  act(() => result.current.regroup(0, 2, apply));
  expect(hide).toHaveBeenCalledWith(1);
  await frames(3);
  expect(result.current.rowCap).toBeNull();
  expect(onHidden).not.toHaveBeenCalled();

  await frames(40);

  expect(onHidden).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(onHidden.mock.invocationCallOrder[0]).toBeLessThan(apply.mock.invocationCallOrder[0]);
  expect(show).toHaveBeenCalledWith(1);
  expect(result.current.rowCap).toBeNull();
});

it("applies only the last of several quick regroups", async () => {
  const { show, result } = setup();
  const first = jest.fn();
  const second = jest.fn();

  act(() => result.current.regroup(0, 1, first));
  act(() => result.current.regroup(1, 0, second));
  await frames(40);

  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
  expect(show).toHaveBeenLastCalledWith(-1);
  expect(result.current.rowCap).toBeNull();
});

it("finishes a regroup that starts while the last one is still filling in", async () => {
  const { result } = setup();
  const first = jest.fn();
  const second = jest.fn();

  act(() => result.current.regroup(0, 1, first));
  for (let frame = 0; frame < 40 && result.current.rowCap !== 4; frame++) await frames(1);
  act(() => result.current.regroup(1, 2, second));
  await frames(40);

  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(result.current.rowCap).toBeNull();
});
