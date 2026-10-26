import { describe, it, expect } from "vitest";
import {
  dailyTotals,
  readingSummary,
  booksForDay,
  ReadingClock,
  type ReadingEvent,
  bookReadingMilliseconds,
  clockTime,
} from "./data";
let serial = 0;
const event = (start: number, end: number, member = "a"): ReadingEvent => ({
  id: String(++serial),
  member,
  startedAt: start,
  endedAt: end,
});
describe("reading intervals and calendar", () => {
  it("combines book history, pending receipts and the live interval without counting overlaps twice", () => {
    const start = Date.now() - 120000;
    const history = event(start, start + 30000);
    const live = event(start + 20000, start + 50000);
    expect(
      bookReadingMilliseconds(
        [
          history,
          history,
          live,
          event(start, start + 90000, "other-book"),
          event(start - 86400000, start - 86400000 + 10000),
        ],
        "a",
      ),
    ).toBe(60000);
    expect(bookReadingMilliseconds([], "a")).toBe(0);
    expect(bookReadingMilliseconds([history], "other-book")).toBe(0);
  });
  it("formats cumulative reading time without wrapping at an hour or a day", () => {
    expect(clockTime(59000)).toBe("00:59");
    expect(clockTime(3600000)).toBe("01:00:00");
    expect(clockTime(27 * 3600000 + 65000)).toBe("27:01:05");
  });
  it("exposes only the current unflushed interval alongside immutable receipts", () => {
    const events: ReadingEvent[] = [],
      wall = Date.now();
    const clock = new ReadingClock("a", (e) => events.push(e), wall, 0);
    clock.tick(true, wall + 1000, 1000);
    expect(clock.pendingInterval).toEqual({
      member: "a",
      startedAt: wall,
      endedAt: wall + 1000,
    });
    clock.flush();
    expect(clock.pendingInterval).toBeNull();
    for (let t = 2000; t <= 6000; t += 1000) clock.tick(true, wall + t, t);
    expect(
      bookReadingMilliseconds([...events, clock.pendingInterval!], "a"),
    ).toBe(6000);
    clock.tick(false, wall + 7000, 7000);
    expect(clock.pendingInterval).toBeNull();
    expect(bookReadingMilliseconds(events, "a")).toBe(6000);
  });
  it("merges overlapping windows/devices and retries without inflating total time", () => {
    const start = new Date(2026, 9, 19, 12).getTime(),
      a = event(start, start + 60000),
      b = event(start + 30000, start + 90000, "b");
    const result = readingSummary([a, a, b], start + 120000);
    expect(result.totalMs).toBe(90000);
    expect(result.readingDays).toBe(1);
    expect(result.streak).toBe(1);
    expect(booksForDay([a, a, b], result.today)).toHaveLength(2);
    expect(booksForDay([a, a, b], result.today)[0].milliseconds).toBe(60000);
  });
  it("splits midnight using local dates and preserves a streak through yesterday", () => {
    const start = new Date(2026, 9, 18, 23, 59, 30).getTime();
    expect(dailyTotals([event(start, start + 60000)])).toEqual({
      "2026-10-18": 30000,
      "2026-10-19": 30000,
    });
    const days = [16, 17, 18].map((d) => {
      const at = new Date(2026, 9, d, 12).getTime();
      return event(at, at + 60000);
    });
    expect(
      readingSummary(days, new Date(2026, 9, 19, 12).getTime()),
    ).toMatchObject({ streak: 3, longest: 3, readingDays: 3 });
    expect(
      readingSummary(days, new Date(2026, 9, 20, 12).getTime()).streak,
    ).toBe(0);
  });
  it("rejects suspended gaps, clock jumps and background time; stops at the idle boundary", () => {
    const events: ReadingEvent[] = [],
      wall = Date.now(),
      clock = new ReadingClock("book", (e) => events.push(e), wall, 0);
    for (let t = 1000; t <= 130000; t += 1000) clock.tick(true, wall + t, t);
    clock.flush();
    expect(events.reduce((n, e) => n + e.endedAt - e.startedAt, 0)).toBe(
      120000,
    );
    clock.tick(false, wall + 131000, 131000);
    clock.interact(132000);
    clock.tick(true, wall + 132000, 132000);
    clock.tick(true, wall + 190000, 190000);
    clock.tick(true, wall + 3600000, 191000);
    clock.flush();
    expect(events.reduce((n, e) => n + e.endedAt - e.startedAt, 0)).toBe(
      121000,
    );
    expect(clock.elapsedMilliseconds).toBe(121000);
    expect(events.every((e) => e.endedAt - e.startedAt <= 20000)).toBe(true);
  });
  it("keeps session time across receipt flushes and excludes the unfocused gap", () => {
    const events: ReadingEvent[] = [],
      wall = Date.now(),
      clock = new ReadingClock("book", (e) => events.push(e), wall, 0);
    for (let t = 1000; t <= 20000; t += 1000) clock.tick(true, wall + t, t);
    expect(clock.elapsedMilliseconds).toBe(20000);
    clock.tick(false, wall + 21000, 21000);
    clock.tick(false, wall + 60000, 60000);
    expect(clock.elapsedMilliseconds).toBe(20000);
    clock.interact(60000);
    for (let t = 61000; t <= 65000; t += 1000) clock.tick(true, wall + t, t);
    clock.flush();
    expect(clock.elapsedMilliseconds).toBe(25000);
    expect(events.reduce((ms, e) => ms + e.endedAt - e.startedAt, 0)).toBe(
      25000,
    );
  });
});
it("uses actual local-midnight boundaries across a 23-hour daylight-saving day", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const start = Date.parse("2026-03-08T00:00:00-05:00"),
      end = Date.parse("2026-03-09T00:00:00-04:00");
    expect(new Date(start).getHours()).toBe(0);
    expect(dailyTotals([event(start, end)])).toEqual({
      "2026-03-08": 23 * 3600000,
    });
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
