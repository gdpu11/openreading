import type { ReadingEvent, ReadingInterval } from "./data";
import { countWords } from "../readers/wordCount";

export const DEFAULT_READING_SPEED = 300;
export const PACE_LEARNING_MS = 3600000;
export type ReadingPace = ReturnType<typeof readingPace>;

// Keep the first deterministic receipt for each piece of wall-clock time.
// Retried receipts, simultaneous windows and overlapping phone time cannot
// multiply either measured time or the corresponding word count.
export function readingPace(events: ReadingInterval[]) {
  const samples = [
    ...new Map(
      events
        .filter(
          (e) =>
            Number.isFinite(e.words) &&
            (e.words || 0) > 0 &&
            Number.isFinite(e.startedAt) &&
            Number.isFinite(e.endedAt) &&
            e.endedAt > e.startedAt &&
            ((e.words || 0) * 60000) / (e.endedAt - e.startedAt) >= 20 &&
            ((e.words || 0) * 60000) / (e.endedAt - e.startedAt) <= 2000,
        )
        .map((e, i) => [e.id || `local-${i}`, e]),
    ).values(),
  ].sort(
    (a, b) =>
      a.startedAt - b.startedAt || ((a.id || "") < (b.id || "") ? -1 : 1),
  );
  let end = -Infinity,
    milliseconds = 0,
    words = 0;
  for (const sample of samples) {
    const start = Math.max(end, sample.startedAt);
    if (sample.endedAt <= start) continue;
    const ms = sample.endedAt - start;
    words += (sample.words! * ms) / (sample.endedAt - sample.startedAt);
    milliseconds += ms;
    end = sample.endedAt;
  }
  const learned = milliseconds >= PACE_LEARNING_MS && words > 0;
  return {
    words: Math.round(words),
    milliseconds,
    learned,
    speed: learned
      ? Math.max(20, Math.min(2000, Math.round((words * 60000) / milliseconds)))
      : DEFAULT_READING_SPEED,
  };
}

export function mergeReadingEvents(
  ...groups: ReadingEvent[][]
): ReadingEvent[] {
  const result = new Map<string, ReadingEvent>();
  for (const event of groups.flat()) {
    const previous = result.get(event.id);
    // An old computer can acknowledge the time without understanding words.
    result.set(
      event.id,
      previous?.words && !event.words
        ? { ...event, words: previous.words }
        : event,
    );
  }
  return [...result.values()];
}

export type ReadingView = {
  section: string;
  order: number;
  nextOrder?: number;
  page?: number;
  nextPage?: number;
  layout: string;
  start: number;
  end: number;
  text: string;
};

// This measures text actually advanced past, never a percentage of the book.
// A pause, layout change, seek, reverse turn or implausibly fast jump starts a
// fresh sample. Content stays in memory; only counts and times are persisted.
export class ReadingMeter {
  private previous: { view: ReadingView; wall: number; mono: number } | null =
    null;
  private last: number | null = null;
  reset() {
    this.previous = null;
    this.last = null;
  }
  observe(
    view: ReadingView | null,
    active: boolean,
    wall = Date.now(),
    mono = performance.now(),
  ): ReadingEvent[] {
    if (!active || !view || !view.text.trim()) {
      this.reset();
      return [];
    }
    const previous = this.previous;
    const gap = this.last === null ? 0 : mono - this.last;
    this.last = mono;
    if (
      !previous ||
      gap > 5000 ||
      gap < 0 ||
      previous.view.layout !== view.layout
    ) {
      this.previous = { view, wall, mono };
      return [];
    }
    if (
      previous.view.section === view.section &&
      previous.view.start === view.start &&
      previous.view.page === view.page
    )
      return [];
    const milliseconds = Math.round(mono - previous.mono);
    // Smooth scrolling advances on consecutive timer ticks. Keep the original
    // viewport until there is enough dwell to measure its cumulative movement.
    // Rapid page turns still reset below instead of accumulating skipped pages.
    if (
      milliseconds > 0 &&
      milliseconds < 2000 &&
      previous.view.section === view.section &&
      previous.view.page === view.page &&
      view.start > previous.view.start &&
      view.start <= previous.view.end
    )
      return [];
    this.previous = { view, wall, mono };
    let text = "";
    if (
      previous.view.section === view.section &&
      view.page !== undefined &&
      previous.view.nextPage === view.page
    )
      text = previous.view.text;
    else if (
      previous.view.section === view.section &&
      view.start > previous.view.start &&
      view.start <= previous.view.end
    )
      text = previous.view.text.slice(0, view.start - previous.view.start);
    else if (
      view.order === (previous.view.nextOrder ?? previous.view.order + 1)
    )
      text = previous.view.text;
    const words = countWords(text);
    const speed = (words * 60000) / milliseconds;
    if (
      !words ||
      milliseconds < 2000 ||
      milliseconds > 300000 ||
      Math.abs(wall - previous.wall - milliseconds) > 2000 ||
      speed < 20 ||
      speed > 2000
    )
      return [];
    // The existing durable reading ledger accepts immutable intervals <= 60 s.
    // Divide a longer screen dwell without changing the measured total.
    const result: ReadingEvent[] = [];
    const start = Math.round(wall - milliseconds);
    let counted = 0;
    for (let at = 0; at < milliseconds; at += 60000) {
      const stop = Math.min(milliseconds, at + 60000);
      const cumulative = Math.round((words * stop) / milliseconds);
      if (cumulative > counted)
        result.push({
          id: crypto.randomUUID(),
          member: "",
          startedAt: start + at,
          endedAt: start + stop,
          words: cumulative - counted,
        });
      counted = cumulative;
    }
    return result;
  }
}
