import { useCallback, useEffect, useRef, useState } from "react";
import { api, localDraft, localDraftEntries } from "../api";
import type { ReadingEvent } from "./data";
export function useDesktopReading(enabled: boolean) {
  const queue = useRef<ReadingEvent[]>([]),
    serial = useRef(Promise.resolve()),
    inflight = useRef<Promise<void> | null>(null),
    loaded = useRef(false);
  const [error, setError] = useState("");
  const save = useCallback((events: ReadingEvent[]) => {
    // One key per immutable receipt: windows may append or acknowledge their
    // own events without replacing another window's recovery queue.
    serial.current = serial.current
      .catch(() => {})
      .then(async () => {
        for (const event of events)
          await localDraft("reading-event:" + event.id, event);
      });
    serial.current.catch(() =>
      setError("阅读记录未能保存到本机，请检查存储空间"),
    );
  }, []);
  const flush = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current;
    if (!loaded.current || !queue.current.length) return Promise.resolve();
    const task = (async () => {
      try {
        await serial.current;
        const pending = [...queue.current];
        for (let i = 0; i < pending.length; i += 100) {
          const events = pending.slice(i, i + 100);
          await api(
            "/reading/events",
            "POST",
            { events },
            { keepalive: true, signal: AbortSignal.timeout(15000) },
          );
          const ids = new Set(events.map((e) => e.id));
          queue.current = queue.current.filter((e) => !ids.has(e.id));
          await Promise.all(
            events.map((e) => localDraft("reading-event:" + e.id, null)),
          );
        }
        setError("");
      } catch {
        setError("阅读记录等待同步；请保留本机缓存");
      }
    })();
    inflight.current = task;
    void task.finally(() => {
      inflight.current = null;
    });
    return task;
  }, [save]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void Promise.all([
      localDraftEntries("reading-event:"),
      localDraft("reading-events"),
    ])
      .then(async ([receipts, legacy]) => {
        if (!alive) return;
        const recovered = [
          ...receipts,
          ...(Array.isArray(legacy) ? legacy : []),
        ];
        queue.current = [
          ...new Map(
            [...recovered, ...queue.current].map((e) => [e.id, e]),
          ).values(),
        ];
        save(queue.current);
        await serial.current;
        if (Array.isArray(legacy)) await localDraft("reading-events", null);
        if (!alive) return;
        loaded.current = true;
        void flush();
      })
      .catch(() => setError("阅读记录恢复失败，请检查本机存储"));
    const timer = setInterval(() => void flush(), 15000),
      online = () => void flush();
    window.addEventListener("online", online);
    window.addEventListener("pagehide", online);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("pagehide", online);
    };
  }, [enabled, flush, save]);
  const record = useCallback(
    (e: ReadingEvent) => {
      queue.current.push(e);
      save([e]);
      if (loaded.current) void flush();
    },
    [save, flush],
  );
  return { record, flush, error };
}
