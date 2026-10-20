import { Clock3 } from "lucide-react";
import type { RefObject } from "react";
import { tr } from "../i18n";
import { useReadingActivity } from "./activity";
import type { ReadingEvent } from "./data";

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
  if (!show) return null;
  const seconds = Math.floor(session.milliseconds / 1000);
  const time = [
    ...(seconds >= 3600 ? [Math.floor(seconds / 3600)] : []),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return (
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
        {time}
      </output>
      {!session.running && <small>{tr("已暂停")}</small>}
    </div>
  );
}
