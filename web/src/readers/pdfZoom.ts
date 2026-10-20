import { useEffect, useRef, type RefObject } from "react";

export const PDF_ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];
export type ZoomPoint = { clientX: number; clientY: number };
type ZoomAction = "in" | "out" | "reset";

export function usePdfZoom(
  host: RefObject<HTMLDivElement | null>,
  scale: number,
  enabled: boolean,
  change: ((scale: number, persist: boolean) => void) | undefined,
  anchor: (point: ZoomPoint) => void,
) {
  const latest = useRef({ change, anchor });
  latest.current = { change, anchor };
  const desired = useRef(scale),
    published = useRef(scale);
  const frame = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef(false);
  // A direct selection in the percentage menu supersedes a pending gesture.
  useEffect(() => {
    if (scale === published.current) return;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    clearTimeout(timer.current);
    dirty.current = false;
    desired.current = published.current = scale;
  }, [scale]);
  useEffect(() => {
    const root = host.current;
    if (!enabled || !change || !root) return;
    let gestureScale: number | undefined;
    const center = () => {
      const box = root.getBoundingClientRect();
      return {
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      };
    };
    const publish = (persist: boolean) => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      published.current = desired.current;
      latest.current.change?.(desired.current, persist);
    };
    const finish = () => {
      clearTimeout(timer.current);
      if (!dirty.current) return;
      dirty.current = false;
      publish(true);
    };
    const zoom = (value: number, point: ZoomPoint, immediate = false) => {
      const next =
        Math.round(Math.max(0.25, Math.min(4, value)) * 10000) / 10000;
      if (next === desired.current) return;
      latest.current.anchor(point);
      desired.current = next;
      dirty.current = true;
      clearTimeout(timer.current);
      if (immediate) finish();
      else {
        if (!frame.current)
          frame.current = requestAnimationFrame(() => publish(false));
        timer.current = setTimeout(finish, 180);
      }
    };
    const action = (value: ZoomAction) => {
      const current = desired.current;
      const next =
        value === "reset"
          ? 1
          : value === "in"
            ? (PDF_ZOOM_LEVELS.find((n) => n > current + 0.0001) ?? 4)
            : ([...PDF_ZOOM_LEVELS]
                .reverse()
                .find((n) => n < current - 0.0001) ?? 0.25);
      zoom(next, center(), true);
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        !(event.ctrlKey || event.metaKey)
      )
        return;
      const value = ["+", "="].includes(event.key)
        ? "in"
        : ["-", "_"].includes(event.key)
          ? "out"
          : event.key === "0"
            ? "reset"
            : undefined;
      if (!value) return;
      event.preventDefault();
      action(value);
    };
    const desktop = (event: Event) => {
      const value = (event as CustomEvent).detail;
      if (!["in", "out", "reset"].includes(value)) return;
      event.preventDefault();
      action(value);
    };
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.deltaY) return;
      event.preventDefault();
      if (gestureScale !== undefined) return;
      const units =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? root.clientHeight
            : 1;
      const delta = Math.max(-120, Math.min(120, event.deltaY * units));
      zoom(desired.current * Math.exp(-delta * 0.002), event);
    };
    // Safari exposes trackpad pinch as GestureEvents instead of Ctrl+wheel.
    const gestureStart = (event: Event) => {
      event.preventDefault();
      gestureScale = desired.current;
    };
    const gestureChange = (event: Event) => {
      event.preventDefault();
      const value = event as Event & {
        scale: number;
        clientX: number;
        clientY: number;
      };
      if (
        gestureScale === undefined ||
        !Number.isFinite(value.scale) ||
        value.scale <= 0
      )
        return;
      zoom(
        gestureScale * value.scale,
        value.clientX || value.clientY ? value : center(),
      );
    };
    const gestureEnd = (event: Event) => {
      event.preventDefault();
      gestureScale = undefined;
      finish();
    };
    root.addEventListener("wheel", wheel, { passive: false });
    root.addEventListener("gesturestart", gestureStart, { passive: false });
    root.addEventListener("gesturechange", gestureChange, { passive: false });
    root.addEventListener("gestureend", gestureEnd, { passive: false });
    document.addEventListener("keydown", keydown);
    window.addEventListener("openreading-pdf-zoom", desktop);
    window.addEventListener("pagehide", finish);
    return () => {
      finish();
      root.removeEventListener("wheel", wheel);
      root.removeEventListener("gesturestart", gestureStart);
      root.removeEventListener("gesturechange", gestureChange);
      root.removeEventListener("gestureend", gestureEnd);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("openreading-pdf-zoom", desktop);
      window.removeEventListener("pagehide", finish);
    };
  }, [enabled, host, !!change]);
}
