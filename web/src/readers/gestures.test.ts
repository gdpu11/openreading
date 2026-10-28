// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { readerGestures } from "./gestures";
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});
function setup() {
  const surface = document.createElement("div");
  surface.innerHTML = "<p>Reading text</p><button>Menu</button>";
  document.body.append(surface);
  const actions = { enabled: () => true, tap: vi.fn(), swipe: vi.fn() };
  const dispose = readerGestures(surface, actions);
  const fire = (
    type: string,
    x: number,
    y: number,
    target: Element = surface,
    id = 1,
    primary = true,
  ) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, {
      clientX: x,
      clientY: y,
      pointerId: id,
      isPrimary: primary,
      button: 0,
    });
    target.dispatchEvent(e);
  };
  return { surface, actions, dispose, fire };
}
it("distinguishes taps, directional swipes and vertical scrolling; cleans up listeners", () => {
  const { actions, dispose, fire } = setup();
  fire("pointerdown", 200, 100);
  fire("pointerup", 200, 100);
  expect(actions.tap).toHaveBeenCalledTimes(1);
  expect(actions.tap).toHaveBeenLastCalledWith(200);
  fire("pointerdown", 280, 100);
  fire("pointerup", 60, 105);
  expect(actions.swipe).toHaveBeenLastCalledWith(1);
  fire("pointerdown", 60, 100);
  fire("pointerup", 280, 110);
  expect(actions.swipe).toHaveBeenLastCalledWith(-1);
  fire("pointerdown", 200, 100);
  fire("pointermove", 200, 200);
  fire("pointerup", 200, 100);
  expect(actions.tap).toHaveBeenCalledTimes(1);
  expect(actions.swipe).toHaveBeenCalledTimes(2);
  dispose();
  fire("pointerdown", 200, 100);
  fire("pointerup", 200, 100);
  expect(actions.tap).toHaveBeenCalledTimes(1);
});
it("leaves long presses, selected text, menu controls and multi-touch intact", () => {
  vi.useFakeTimers();
  const { surface, actions, fire } = setup();
  fire("pointerdown", 100, 100);
  vi.advanceTimersByTime(500);
  fire("pointerup", 100, 100);
  fire("pointerdown", 100, 100, surface.querySelector("button")!);
  fire("pointerup", 100, 100, surface.querySelector("button")!);
  fire("pointerdown", 280, 100);
  fire("pointerdown", 270, 100, surface, 2, false);
  fire("pointerup", 60, 100);
  const range = document.createRange();
  range.selectNodeContents(surface.querySelector("p")!);
  window.getSelection()!.addRange(range);
  fire("pointerdown", 280, 100);
  fire("pointerup", 60, 100);
  expect(actions.tap).not.toHaveBeenCalled();
  expect(actions.swipe).not.toHaveBeenCalled();
});
