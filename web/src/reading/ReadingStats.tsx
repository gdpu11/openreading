import { tr, locale } from "../i18n";
import { saveExport } from "../ord";
import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Clock,
  Flame,
  CalendarDays,
  Target,
  X,
} from "lucide-react";
import {
  booksForDay,
  dayKey,
  dateFromKey,
  duration,
  readingSummary,
  type ReadingData,
} from "./data";
import "./reading.css";
export function ReadingStats({
  data,
  scope,
  onGoal,
  onClose,
  notice = "",
}: {
  data: ReadingData;
  scope: "all" | "authorized";
  onGoal?: (minutes: number) => Promise<void>;
  onClose: () => void;
  notice?: string;
}) {
  const [month, setMonth] = useState(() => dayKey(Date.now()).slice(0, 7)),
    [selected, setSelected] = useState(() => dayKey(Date.now())),
    [goal, setGoal] = useState(data.goalMinutes || 30),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  useEffect(() => setGoal(data.goalMinutes || 30), [data.goalMinutes]);
  const summary = useMemo(() => readingSummary(data.events), [data.events]);
  const first = dateFromKey(month + "-01"),
    next = new Date(first.getFullYear(), first.getMonth() + 1, 1),
    count = new Date(next.getTime() - 1).getDate(),
    offset = (first.getDay() + 6) % 7;
  const monthMs = Object.entries(summary.days)
    .filter(([k]) => k.startsWith(month))
    .reduce((sum, [, v]) => sum + v, 0);
  const ratio = Math.min(
    1,
    summary.todayMs / ((data.goalMinutes || 30) * 60000),
  );
  const books = booksForDay(data.events, selected);
  const changeMonth = (delta: number) => {
    const d = dateFromKey(month + "-01");
    d.setMonth(d.getMonth() + delta);
    const key = dayKey(d);
    setMonth(key.slice(0, 7));
    setSelected(key);
  };
  const exportCSV = async () => {
    const csv =
      "日期,阅读秒数,阅读分钟数\n" +
      Object.entries(summary.days)
        .sort()
        .map(
          ([day, ms]) =>
            `${day},${Math.floor(ms / 1000)},${(ms / 60000).toFixed(2)}`,
        )
        .join("\n");
    try {
      await saveExport(
        new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }),
        "Open-Reading-阅读数据",
        "csv",
      );
    } catch (e: any) {
      setError(e.message || "阅读数据导出失败");
    }
  };
  return (
    <section className="reading-stats" aria-label={tr("阅读数据")}>
      <header className="reading-stats-heading">
        <div>
          <span className="eyebrow">YOUR READING HABIT</span>
          <h1>{tr("阅读数据")}</h1>
          <p>
            {tr(
              scope === "all"
                ? "汇总所有工作区的阅读记录，切换工作区不会影响统计。"
                : "汇总手机已授权工作区的阅读记录，包含离线阅读。",
            )}
          </p>
        </div>
        <div>
          <button className="secondary" onClick={exportCSV}>
            <Download size={16} />
            {tr("导出数据")}
          </button>
          <button aria-label={tr("关闭阅读数据")} onClick={onClose}>
            <X size={20} />
          </button>
        </div>
      </header>
      {(notice || error) && (
        <p role="status" className="reading-stats-notice">
          {tr(error || notice)}
        </p>
      )}
      <div className="reading-overview">
        <article className="reading-goal">
          <div className="reading-ring">
            <svg viewBox="0 0 160 160" aria-hidden="true">
              <circle className="ring-track" cx="80" cy="80" r="69" />
              <circle
                className="ring-progress"
                cx="80"
                cy="80"
                r="69"
                pathLength="100"
                strokeDasharray={`${ratio * 100} 100`}
              />
            </svg>
            <div>
              <span>{tr("今日阅读")}</span>
              <strong data-testid="today-reading">
                {duration(summary.todayMs)}
              </strong>
              <small>
                {ratio >= 1
                  ? tr("今日目标已达成")
                  : tr(`目标 ${data.goalMinutes || 30} 分钟`)}
              </small>
            </div>
          </div>
          {onGoal ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setSaving(true);
                setError("");
                try {
                  await onGoal(goal);
                } catch (e: any) {
                  setError(e.message || "目标保存失败");
                } finally {
                  setSaving(false);
                }
              }}
            >
              <label>
                <Target size={15} />
                {tr("每日目标")}
                <input
                  aria-label={tr("每日阅读目标（分钟）")}
                  type="number"
                  min="1"
                  max="1440"
                  step="1"
                  required
                  value={goal}
                  onChange={(e) => setGoal(Number(e.target.value))}
                />
                {tr("分钟")}
              </label>
              <button className="secondary" disabled={saving}>
                {saving ? tr("保存中…") : tr("保存目标")}
              </button>
            </form>
          ) : (
            <p className="muted">{tr("每日目标可在电脑端设置")}</p>
          )}
        </article>
        <div className="reading-metrics">
          <article>
            <Flame size={20} />
            <span>{tr("连续阅读")}</span>
            <strong>
              {summary.streak}
              <small>{tr("天")}</small>
            </strong>
            <p>
              {tr("最长连续")}
              {summary.longest}
              {tr("天")}
            </p>
          </article>
          <article>
            <Clock size={20} />
            <span>{tr("累计阅读")}</span>
            <strong>
              {(summary.totalMs / 3600000).toFixed(2)}
              <small>{tr("小时")}</small>
            </strong>
            <p>{duration(summary.totalMs)}</p>
          </article>
          <article>
            <CalendarDays size={20} />
            <span>{tr("阅读天数")}</span>
            <strong>
              {summary.readingDays}
              <small>{tr("天")}</small>
            </strong>
            <p>{tr("每天满 1 分钟计为阅读一天")}</p>
          </article>
        </div>
      </div>
      <article className="reading-calendar">
        <header>
          <div>
            <h2>{tr("阅读日历")}</h2>
            <p>
              {tr("本月累计")}
              {duration(monthMs)}
            </p>
          </div>
          <nav>
            <button aria-label={tr("上个月")} onClick={() => changeMonth(-1)}>
              <ChevronLeft size={18} />
            </button>
            <strong>
              {first.toLocaleDateString(locale(), {
                year: "numeric",
                month: "long",
              })}
            </strong>
            <button
              aria-label={tr("下个月")}
              disabled={month >= summary.today.slice(0, 7)}
              onClick={() => changeMonth(1)}
            >
              <ChevronRight size={18} />
            </button>
            <button
              className="secondary"
              onClick={() => {
                setMonth(summary.today.slice(0, 7));
                setSelected(summary.today);
              }}
            >
              {tr("今天")}
            </button>
          </nav>
        </header>
        <div className="reading-calendar-grid">
          {["一", "二", "三", "四", "五", "六", "日"].map((d) => (
            <span className="calendar-weekday" key={d}>
              {locale() === "zh-CN" ? "周" + d : tr(d)}
            </span>
          ))}
          {Array.from({ length: offset }, (_, i) => (
            <span key={"empty" + i} />
          ))}
          {Array.from({ length: count }, (_, i) => {
            const key = month + "-" + String(i + 1).padStart(2, "0"),
              ms = summary.days[key] || 0,
              level =
                ms === 0
                  ? 0
                  : Math.min(
                      4,
                      Math.max(
                        1,
                        Math.ceil(
                          (ms / ((data.goalMinutes || 30) * 60000)) * 4,
                        ),
                      ),
                    );
            return (
              <button
                key={key}
                data-level={level}
                className={
                  "calendar-day" +
                  (key === selected ? " selected" : "") +
                  (key === summary.today ? " today" : "")
                }
                aria-label={tr(`${key} 阅读 ${duration(ms)}`)}
                aria-pressed={key === selected}
                disabled={key > summary.today}
                onClick={() => setSelected(key)}
              >
                <strong>{i + 1}</strong>
                <small>
                  {ms
                    ? ms >= 60000
                      ? tr(`${Math.floor(ms / 60000)} 分`)
                      : tr("不足 1 分")
                    : "—"}
                </small>
              </button>
            );
          })}
        </div>
        <footer>
          <span>{tr("少")}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <i data-level={level} key={level} />
          ))}
          <span>{tr("多 · 按每日目标分级")}</span>
        </footer>
      </article>
      <article className="reading-day-details">
        <header>
          <h2>
            {selected}
            {tr("的阅读")}
          </h2>
          <strong>{duration(summary.days[selected] || 0)}</strong>
        </header>
        {books.length ? (
          books.map((b) => (
            <div className="reading-book" key={b.member}>
              <span>{b.title.split("/").pop()}</span>
              <strong>{duration(b.milliseconds)}</strong>
            </div>
          ))
        ) : (
          <p className="muted">
            {tr("这一天还没有阅读记录。打开一本书开始阅读吧。")}
          </p>
        )}
      </article>
      <p className="reading-stat-rules">
        {tr(
          "仅记录前台阅读；后台、锁屏或超过 2 分钟无操作时暂停。重叠时段合并计时，避免多个窗口或设备重复累计。连续天数以每日满 1 分钟计算，今天尚未开始时保留截至昨天的连续记录。日期按本机时区",
        )}{" "}
        {Intl.DateTimeFormat().resolvedOptions().timeZone}{" "}
        {tr(
          "展示。统计从功能启用后开始，旧阅读进度不会折算为时长。手机离线记录在连接电脑后合并；各本书的时长分别统计，可能存在重叠。",
        )}
      </p>
    </section>
  );
}
