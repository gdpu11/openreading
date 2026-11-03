import { describe, expect, it } from "vitest";
import {
  ReadingMeter,
  readingPace,
  mergeReadingEvents,
  type ReadingView,
} from "./pace";
import type { ReadingEvent } from "./data";
const base = 1700000000000;
const event = (
  id: string,
  start: number,
  end: number,
  words?: number,
): ReadingEvent => ({
  id,
  member: "book",
  startedAt: base + start,
  endedAt: base + end,
  ...(words === undefined ? {} : { words }),
});
const view = (
  start = 0,
  end = 600,
  section = "body",
  order = 0,
): ReadingView => ({
  section,
  order,
  start,
  end,
  layout: "normal",
  text: "读".repeat(end - start),
});
function dwell(meter: ReadingMeter, v: ReadingView, seconds: number) {
  for (let t = 0; t < seconds; t++)
    meter.observe(v, true, base + t * 1000, t * 1000);
}
describe("personal reading pace", () => {
  it("uses 300 for everyone until exactly one hour of measured text, across books", () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({
      ...event(`sample-${i}`, i * 60000, (i + 1) * 60000, 500),
      member: `book-${i % 3}`,
    }));
    expect(readingPace(samples.slice(0, 59))).toMatchObject({
      speed: 300,
      learned: false,
      words: 29500,
    });
    expect(readingPace(samples)).toMatchObject({
      speed: 500,
      learned: true,
      words: 30000,
      milliseconds: 3600000,
    });
  });
  it("does not invent word counts from earlier time-only records", () => {
    expect(readingPace([event("legacy", 0, 8 * 3600000)])).toMatchObject({
      words: 0,
      speed: 300,
      learned: false,
      milliseconds: 0,
    });
  });
  it("deduplicates retries and overlapping windows/phones in deterministic order", () => {
    const a = event("a", 0, 60000, 300),
      b = event("b", 30000, 90000, 300);
    expect(readingPace([b, a, a])).toMatchObject({
      words: 450,
      milliseconds: 90000,
    });
    expect(readingPace([a, b])).toEqual(readingPace([b, a]));
    expect(readingPace([event("bad", 0, 1000, 5000)])).toMatchObject({
      words: 0,
    });
  });
  it("preserves measured words when a legacy computer returns a time-only receipt", () => {
    expect(
      mergeReadingEvents([event("a", 0, 60000, 300)], [event("a", 0, 60000)])[0]
        .words,
    ).toBe(300);
  });
});
describe("measuring effective reading", () => {
  it("counts only the text advanced past, including partial scrolling", () => {
    const meter = new ReadingMeter();
    dwell(meter, view(), 20);
    const samples = meter.observe(view(100, 700), true, base + 20000, 20000);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      words: 100,
      startedAt: base,
      endedAt: base + 20000,
    });
  });
  it("splits a long page dwell into immutable receipts without losing words or time", () => {
    const meter = new ReadingMeter();
    dwell(meter, view(), 90);
    const samples = meter.observe(view(600, 1200), true, base + 90000, 90000);
    expect(samples.map((s) => s.words)).toEqual([400, 200]);
    expect(samples.every((s) => s.endedAt - s.startedAt <= 60000)).toBe(true);
    expect(readingPace(samples)).toMatchObject({
      words: 600,
      milliseconds: 90000,
    });
  });
  it("combines consecutive smooth scroll ticks instead of discarding every short movement", () => {
    const meter = new ReadingMeter();
    meter.observe(view(), true, base, 0);
    expect(meter.observe(view(5, 605), true, base + 1000, 1000)).toEqual([]);
    expect(
      meter.observe(view(10, 610), true, base + 2000, 2000)[0],
    ).toMatchObject({
      words: 10,
      startedAt: base,
      endedAt: base + 2000,
    });
    expect(meter.observe(view(15, 615), true, base + 3000, 3000)).toEqual([]);
    expect(meter.observe(view(20, 620), true, base + 4000, 4000)[0].words).toBe(
      10,
    );
  });
  it("counts a read chapter boundary and rejects skipped sections and rapid page flips", () => {
    const meter = new ReadingMeter();
    dwell(meter, view(), 60);
    expect(
      meter.observe(view(0, 600, "chapter-2", 1), true, base + 60000, 60000)[0]
        .words,
    ).toBe(600);
    expect(
      meter.observe(view(0, 600, "chapter-9", 8), true, base + 61000, 61000),
    ).toEqual([]);
    expect(
      meter.observe(view(0, 600, "chapter-10", 9), true, base + 62000, 62000),
    ).toEqual([]);
  });
  it("does not count seek, reflow, reverse scrolling, background or throttling gaps", () => {
    for (const kind of ["seek", "back", "pause", "gap", "layout"]) {
      const meter = new ReadingMeter();
      dwell(meter, view(100, 700), 20);
      if (kind === "pause") meter.observe(null, false, base + 20000, 20000);
      const next =
        kind === "seek"
          ? view(1000, 1600)
          : kind === "back"
            ? view(0, 600)
            : view(200, 800);
      if (kind === "layout") next.layout = "new-font";
      const time = kind === "gap" ? 60000 : 20000;
      expect(meter.observe(next, true, base + time, time), kind).toEqual([]);
    }
  });
  it("does not count blank or image-only pages", () => {
    const meter = new ReadingMeter();
    dwell(meter, view(), 60);
    expect(meter.observe(null, true, base + 60000, 60000)).toEqual([]);
  });
  it("rejects a throttling gap immediately after a zero-based clock starts", () => {
    const meter = new ReadingMeter();
    meter.observe(view(), true, base, 0);
    expect(meter.observe(view(100, 700), true, base + 10000, 10000)).toEqual(
      [],
    );
  });
  it("counts adjacent paginated screens even when column padding leaves a small text gap", () => {
    const meter = new ReadingMeter();
    const first = { ...view(), page: 1, nextPage: 2 };
    dwell(meter, first, 60);
    const next = { ...view(620, 1220), page: 2, nextPage: 3 };
    expect(meter.observe(next, true, base + 60000, 60000)[0].words).toBe(600);
    expect(
      meter.observe(
        { ...view(1900, 2500), page: 4, nextPage: 5 },
        true,
        base + 61000,
        61000,
      ),
    ).toEqual([]);
  });
});
