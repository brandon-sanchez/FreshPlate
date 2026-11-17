/**
 * The spring the tab bar's selection pill uses, critically damped so it
 * settles without bouncing. Controls that move a selection, such as the
 * segmented control's indicator, share it so every selection moves the same
 * way.
 */
export const TAB_SPRING = { stiffness: 320, damping: 30, mass: 0.7 } as const;
