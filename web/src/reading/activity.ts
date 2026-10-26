import { useEffect, useRef, useState, type RefObject } from "react";
import { ReadingClock, type ReadingEvent, type ReadingInterval } from "./data";
export function useReadingActivity(
  host: RefObject<HTMLDivElement | null>,
  member: string,
  enabled: boolean,
  record?: (e: ReadingEvent) => void,
) {
  const latest = useRef(record);
  const total = useRef({
    member,
    milliseconds: 0,
    intervals: [] as ReadingInterval[],
  });
  const [session, setSession] = useState({
    member,
    milliseconds: 0,
    running: false,
    intervals: [] as ReadingInterval[],
  });
  latest.current = record;
  useEffect(() => {
    if (total.current.member !== member)
      total.current = { member, milliseconds: 0, intervals: [] };
    const base = total.current.milliseconds;
    if (!enabled || !latest.current) {
      setSession({
        member,
        milliseconds: base,
        running: false,
        intervals: [...total.current.intervals],
      });
      return;
    }
    const clock = new ReadingClock(member, (e) => {
      total.current.intervals.push(e);
      latest.current?.(e);
    });
    const visible = () => {
      const nativeState = document.documentElement.dataset.readingSystemActive;
      // Electron's native window state includes focus, minimization and screen
      // lock. Chromium's hasFocus can lag behind native window activation.
      return (
        document.visibilityState === "visible" &&
        (nativeState === undefined
          ? document.hasFocus()
          : nativeState === "true")
      );
    };
    let foreground = visible();
    const publish = (active = visible()) => {
      const milliseconds = base + clock.elapsedMilliseconds;
      const running = active && !clock.idle;
      setSession((previous) =>
        previous.member === member &&
        previous.milliseconds === milliseconds &&
        previous.running === running
          ? previous
          : {
              member,
              milliseconds,
              running,
              intervals: [
                ...total.current.intervals,
                ...(clock.pendingInterval ? [clock.pendingInterval] : []),
              ],
            },
      );
    };
    const tick = () => {
      const active = visible();
      // Also reconcile foreground transitions when DOM focus notifications
      // arrive late. Start a fresh interval; never count the background gap.
      clock.tick(active && foreground);
      if (active && !foreground) clock.interact();
      foreground = active;
      publish(active);
    };
    const activity = () => {
      tick();
      if (foreground) clock.interact();
      publish();
    };
    const focus = () => {
      clock.tick(false);
      foreground = visible();
      if (foreground) clock.interact();
      publish(foreground);
    };
    const pause = () => {
      clock.tick(false);
      clock.flush();
      foreground = false;
      publish(false);
    };
    // Focusing an EPUB iframe can blur the top window while the document
    // still has focus. It must not be treated as switching applications.
    const blur = () => (document.hasFocus() ? tick() : pause());
    const visibility = () => {
      if (document.visibilityState === "visible") focus();
      else pause();
    };
    const frameCleanup = new Map<Document, () => void>();
    const attach = (target: Document | HTMLElement) => {
      const remove: (() => void)[] = [];
      for (const name of [
        "pointerdown",
        "pointermove",
        "keydown",
        "scroll",
        "touchstart",
        "wheel",
      ]) {
        target.addEventListener(name, activity, {
          capture: true,
          passive: true,
        });
        remove.push(() => target.removeEventListener(name, activity, true));
      }
      return () => remove.forEach((f) => f());
    };
    const hostCleanup = host.current ? attach(host.current) : () => {};
    const frames = () => {
      const current = new Set<Document>();
      host.current?.querySelectorAll("iframe").forEach((frame) => {
        try {
          const d = frame.contentDocument;
          if (d) {
            current.add(d);
            if (!frameCleanup.has(d)) frameCleanup.set(d, attach(d));
          }
        } catch {
          /* Untrusted cross-origin frames cannot supply reading activity. */
        }
      });
      for (const [d, remove] of frameCleanup)
        if (!current.has(d)) {
          remove();
          frameCleanup.delete(d);
        }
    };
    const observer = new MutationObserver(frames);
    if (host.current)
      observer.observe(host.current, { childList: true, subtree: true });
    frames();
    const timer = setInterval(() => {
      frames();
      tick();
    }, 1000);
    publish();
    const systemState = () => {
      if (visible()) tick();
      else pause();
    };
    window.addEventListener("openreading-system-state", systemState);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    window.addEventListener("pagehide", pause);
    return () => {
      tick();
      clock.flush();
      total.current.milliseconds = base + clock.elapsedMilliseconds;
      publish(false);
      clearInterval(timer);
      observer.disconnect();
      hostCleanup();
      frameCleanup.forEach((f) => f());
      window.removeEventListener("openreading-system-state", systemState);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      window.removeEventListener("pagehide", pause);
    };
  }, [member, enabled]);
  return session;
}
