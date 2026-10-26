import { Clock3 } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { api, localDraftEntries } from "../api";
import { tr } from "../i18n";
import { useReadingActivity } from "./activity";
import { bookReadingMilliseconds, clockTime, type ReadingEvent } from "./data";

export function SessionTimer({
  host,
  member,
  enabled,
  record,
  show,
}: {
  host: RefObject<HTMLDivElement | null>;
  member: string;
  enabled: boolean;
  record?: (event: ReadingEvent) => void;
  show: boolean;
}) {
  const session = useReadingActivity(host, member, enabled, record);
  const [history, setHistory] = useState({
    member: "",
    events: [] as ReadingEvent[],
    error: "",
  });
  useEffect(() => {
    if (!show) return;
    let alive = true,
      loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        // Read the recovery queue first: an acknowledged receipt can disappear
        // locally only after the subsequent server snapshot can include it.
        const pending = await localDraftEntries("reading-event:");
        const saved = await api<{ events: ReadingEvent[] }>(
          `/reading/documents/${encodeURIComponent(member)}`,
          "GET",
          undefined,
          { signal: AbortSignal.timeout(10000) },
        );
        if (alive)
          setHistory({
            member,
            events: [
              ...saved.events,
              ...pending.filter((e) => e.member === member),
            ],
            error: "",
          });
      } catch {
        if (alive)
          setHistory((previous) => ({
            ...previous,
            error: "累计时长暂未更新，恢复连接后自动重试",
          }));
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [member, show]);
  if (!show) return null;
  const loaded = history.member === member;
  const total = bookReadingMilliseconds(
    [
      ...(loaded ? history.events : []),
      ...(session.member === member ? session.intervals : []),
    ],
    member,
  );
  return (
    <div className="reading-timers">
      <div
        className="cumulative-reading-time"
        title={tr(
          history.error ||
            "这本书历次有效阅读时间的累计，包含本次阅读；重叠时段只计一次。",
        )}
      >
        <span>{tr("累计已读")}</span>
        <output role="timer" aria-live="off" aria-label={tr("累计阅读时长")}>
          {loaded
            ? clockTime(total)
            : history.error
              ? tr("暂不可用")
              : tr("读取中…")}
        </output>
        {loaded && history.error && <small>{tr("待更新")}</small>}
      </div>
      <div
        className="session-timer"
        data-state={session.running ? "running" : "paused"}
        title={tr(
          "仅在前台阅读时计时；离开窗口、休眠或连续 2 分钟无操作时暂停。",
        )}
      >
        <Clock3 size={14} aria-hidden="true" />
        <span>{tr("本次阅读")}</span>
        <output role="timer" aria-live="off" aria-label={tr("本次阅读时长")}>
          {clockTime(session.member === member ? session.milliseconds : 0)}
        </output>
        {!session.running && <small>{tr("已暂停")}</small>}
      </div>
    </div>
  );
}
