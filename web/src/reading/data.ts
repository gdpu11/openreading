import { tr } from "../i18n";
export type ReadingEvent = {
  id: string;
  member: string;
  startedAt: number;
  endedAt: number;
  title?: string;
};
export type ReadingData = { events: ReadingEvent[]; goalMinutes: number };
export type ReadingInterval = Pick<
  ReadingEvent,
  "member" | "startedAt" | "endedAt"
>;
export function bookReadingMilliseconds(
  events: ReadingInterval[],
  member: string,
) {
  return union(events.filter((event) => event.member === member)).reduce(
    (sum, [start, end]) => sum + end - start,
    0,
  );
}
export function clockTime(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return [
    ...(seconds >= 3600 ? [Math.floor(seconds / 3600)] : []),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}
export const dayKey = (time: number | Date) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const dateFromKey = (key: string) =>
  new Date(
    Number(key.slice(0, 4)),
    Number(key.slice(5, 7)) - 1,
    Number(key.slice(8, 10)),
  );
export function union(events: Pick<ReadingEvent, "startedAt" | "endedAt">[]) {
  const sorted = events
    .filter(
      (e) =>
        Number.isFinite(e.startedAt) &&
        Number.isFinite(e.endedAt) &&
        e.endedAt > e.startedAt,
    )
    .map((e) => [e.startedAt, e.endedAt])
    .sort((a, b) => a[0] - b[0]);
  const ranges: number[][] = [];
  for (const [a, b] of sorted) {
    const last = ranges.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else ranges.push([a, b]);
  }
  return ranges;
}
export function dailyTotals(events: ReadingEvent[]) {
  const days: Record<string, number> = {};
  for (const [start, end] of union(events)) {
    let at = start;
    while (at < end) {
      const next = new Date(at);
      next.setHours(24, 0, 0, 0);
      const stop = Math.min(end, next.getTime());
      const key = dayKey(at);
      days[key] = (days[key] || 0) + (stop - at);
      at = stop;
    }
  }
  return days;
}
export function readingSummary(events: ReadingEvent[], now = Date.now()) {
  const days = dailyTotals(events),
    today = dayKey(now),
    dates = Object.keys(days)
      .filter((k) => days[k] >= 60000)
      .sort();
  let longest = 0,
    run = 0,
    previous = "";
  for (const key of dates) {
    const before = dateFromKey(key);
    before.setDate(before.getDate() - 1);
    run = dayKey(before) === previous ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = key;
  }
  const cursor = new Date(now);
  let streak = 0;
  if ((days[today] || 0) < 60000) cursor.setDate(cursor.getDate() - 1);
  while ((days[dayKey(cursor)] || 0) >= 60000) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return {
    days,
    today,
    todayMs: days[today] || 0,
    totalMs: Object.values(days).reduce((a, b) => a + b, 0),
    readingDays: dates.length,
    streak,
    longest,
  };
}
export function booksForDay(events: ReadingEvent[], key: string) {
  const start = dateFromKey(key).getTime(),
    next = dateFromKey(key);
  next.setDate(next.getDate() + 1);
  const end = next.getTime();
  const books = new Map<string, { title: string; events: ReadingEvent[] }>();
  for (const e of events) {
    if (e.endedAt <= start || e.startedAt >= end) continue;
    const book = books.get(e.member) || {
      title: e.title || "历史文档",
      events: [],
    };
    book.events.push({
      ...e,
      startedAt: Math.max(start, e.startedAt),
      endedAt: Math.min(end, e.endedAt),
    });
    books.set(e.member, book);
  }
  return [...books.entries()]
    .map(([member, b]) => ({
      member,
      title: b.title,
      milliseconds: union(b.events).reduce((sum, [a, z]) => sum + z - a, 0),
    }))
    .sort((a, b) => b.milliseconds - a.milliseconds);
}
export function duration(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return tr(
    seconds >= 3600
      ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`
      : seconds >= 60
        ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
        : `${seconds} 秒`,
  );
}
// A monotonic clock rejects sleep/throttling gaps and wall-clock changes.
export class ReadingClock {
  private elapsed = 0;
  private wall: number;
  private mono: number;
  private interaction: number;
  private start: number | null = null;
  private end = 0;
  constructor(
    private member: string,
    private emit: (event: ReadingEvent) => void,
    wall = Date.now(),
    mono = performance.now(),
  ) {
    this.wall = wall;
    this.mono = mono;
    this.interaction = mono;
  }
  interact(mono = performance.now()) {
    this.interaction = mono;
  }
  get elapsedMilliseconds() {
    return this.elapsed;
  }
  get pendingInterval(): ReadingInterval | null {
    return this.start === null
      ? null
      : {
          member: this.member,
          startedAt: this.start,
          endedAt: this.end,
        };
  }
  get idle() {
    return this.mono >= this.interaction + 120000;
  }
  tick(active: boolean, wall = Date.now(), mono = performance.now()) {
    const delta = mono - this.mono,
      wallDelta = wall - this.wall;
    const stop = Math.min(mono, this.interaction + 120000),
      effective = Math.max(0, stop - this.mono);
    if (
      active &&
      delta > 0 &&
      delta <= 5000 &&
      Math.abs(delta - wallDelta) < 2000 &&
      effective > 0
    ) {
      const finish = this.wall + effective;
      this.elapsed += effective;
      if (this.start === null) this.start = this.wall;
      this.end = finish;
      if (this.end - this.start >= 15000) this.flush();
    } else this.flush();
    this.wall = wall;
    this.mono = mono;
  }
  flush() {
    if (this.start !== null && this.end - this.start >= 1000)
      this.emit({
        id: crypto.randomUUID(),
        member: this.member,
        startedAt: Math.round(this.start),
        endedAt: Math.round(this.end),
      });
    this.start = null;
  }
}
