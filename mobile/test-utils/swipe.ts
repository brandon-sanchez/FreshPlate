import { act } from "@testing-library/react-native";
import { State } from "react-native-gesture-handler";
import {
  fireGestureHandler,
  getByGestureTestId,
} from "react-native-gesture-handler/jest-utils";

/**
 * Drags the swipe whose pan gesture has the test id `testId` 120 points to
 * the left and lets go, past the point where it snaps open, then waits for
 * the state updates the gesture callbacks schedule.
 */
export async function swipeOpen(testId: string) {
  await act(async () => {
    fireGestureHandler(getByGestureTestId(testId), [
      { state: State.BEGAN, translationX: 0 },
      { state: State.ACTIVE, translationX: -20 },
      { state: State.ACTIVE, translationX: -120 },
      { state: State.END, translationX: -120, velocityX: 0 },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
