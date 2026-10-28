// EPUB pointer events stay inside its iframe, so install the same handlers on
// both the reader surface and each EPUB document. Actions always read live state.
export function readerGestures(
  surface: HTMLElement | Document,
  actions: {
    enabled: () => boolean;
    tap: (clientX: number) => void;
    swipe: (direction: -1 | 1) => void;
  },
) {
  const owner =
    surface.nodeType === 9 ? (surface as Document) : surface.ownerDocument!;
  let start:
    | {
        id: number;
        x: number;
        y: number;
        at: number;
        moved: number;
        selected: boolean;
      }
    | undefined;
  let suppressClick = 0;
  const selected = () => !!owner.getSelection()?.toString().trim();
  const interactive = (target: EventTarget | null) => {
    const element = target as Element | null;
    return (
      element?.nodeType === 1 &&
      !!element.closest(
        'a,button,input,textarea,select,[contenteditable="true"],[role="button"],[role="slider"]',
      )
    );
  };
  const down = (event: Event) => {
    const e = event as PointerEvent;
    if (
      !e.isPrimary ||
      e.button !== 0 ||
      !actions.enabled() ||
      interactive(e.target)
    ) {
      start = undefined;
      return;
    }
    start = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      at: Date.now(),
      moved: 0,
      selected: selected(),
    };
  };
  const move = (event: Event) => {
    const e = event as PointerEvent;
    if (start?.id === e.pointerId)
      start.moved = Math.max(
        start.moved,
        Math.hypot(e.clientX - start.x, e.clientY - start.y),
      );
  };
  const up = (event: Event) => {
    const e = event as PointerEvent,
      first = start;
    start = undefined;
    if (
      !first ||
      first.id !== e.pointerId ||
      !actions.enabled() ||
      first.selected ||
      selected() ||
      interactive(e.target)
    )
      return;
    const dx = e.clientX - first.x,
      dy = e.clientY - first.y,
      elapsed = Date.now() - first.at;
    if (
      elapsed < 800 &&
      Math.abs(dx) >= 50 &&
      Math.abs(dx) > Math.abs(dy) * 1.5 &&
      Math.abs(dy) < 65
    ) {
      suppressClick = Date.now() + 400;
      actions.swipe(dx < 0 ? 1 : -1);
    } else if (elapsed < 350 && Math.max(first.moved, Math.hypot(dx, dy)) < 10)
      actions.tap(e.clientX);
  };
  const cancel = () => {
    start = undefined;
  };
  const click = (e: Event) => {
    if (Date.now() < suppressClick) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  surface.addEventListener("pointerdown", down);
  surface.addEventListener("pointermove", move, { passive: true });
  surface.addEventListener("pointerup", up);
  surface.addEventListener("pointercancel", cancel);
  surface.addEventListener("click", click, true);
  return () => {
    surface.removeEventListener("pointerdown", down);
    surface.removeEventListener("pointermove", move);
    surface.removeEventListener("pointerup", up);
    surface.removeEventListener("pointercancel", cancel);
    surface.removeEventListener("click", click, true);
  };
}
