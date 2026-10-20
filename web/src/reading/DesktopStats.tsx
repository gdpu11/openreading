import { tr } from "../i18n";
import { useEffect, useState } from "react";
import { api } from "../api";
import { ReadingStats } from "./ReadingStats";
import type { ReadingData } from "./data";
export function DesktopStats({
  flush,
  onClose,
  notice,
}: {
  flush: () => Promise<void>;
  onClose: () => void;
  notice: string;
}) {
  const [data, setData] = useState<ReadingData>({
      events: [],
      goalMinutes: 30,
    }),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        await flush();
        const d = await api<ReadingData>("/reading");
        if (alive) {
          setData(d);
          setLoaded(true);
          setError("");
        }
      } catch (e: any) {
        if (alive) setError(e.message);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [flush]);
  if (!loaded)
    return (
      <section className="reading-stats">
        <h1>{tr("阅读数据")}</h1>
        <p role="status">{tr(error || "正在读取本机阅读记录…")}</p>
        <button onClick={onClose}>{tr("返回阅读")}</button>
      </section>
    );
  return (
    <ReadingStats
      data={data}
      scope="all"
      notice={error || notice}
      onClose={onClose}
      onGoal={async (minutes) => {
        await api("/reading/goal", "PUT", { minutes });
        setData(await api<ReadingData>("/reading"));
      }}
    />
  );
}
