export type GuideSource = {
  id: string;
  position: number;
  label: string;
  text: string;
  locator: Record<string, any>;
};
export type GuideSlide = {
  title: string;
  narration: string;
  layout: "concept" | "steps" | "comparison";
  items: { label: string; detail: string }[];
  sourceIds: string[];
};
export type GuidePlan = {
  fingerprint: string;
  versionId: string;
  mode: "overview" | "section";
  goal: string;
  provider: string;
  modelId: string;
  mock: boolean;
  sources: GuideSource[];
  estimatedInputTokens: number;
  coverage: {
    totalSections: number;
    sentSections: number;
    totalCharacters: number;
    sentCharacters: number;
    partial: boolean;
  };
};
export type VideoGuide = {
  requestId: string;
  createdAt: string;
  plan: GuidePlan;
  script: { title: string; slides: GuideSlide[] };
};
export type GuideCue = {
  slide: number;
  text: string;
  duration: number;
  start: number;
};

export function guideDocumentSections(
  text: string,
  title: string,
  outline: OutlineItem[],
): TextSection[] {
  const headings: {
    at: number;
    label: string;
    locator: Record<string, any>;
  }[] = [];
  let from = 0;
  for (const item of outline) {
    if (item.locator.heading === undefined || !item.label.trim()) continue;
    const at = text.indexOf(item.label, from);
    if (at < 0) continue;
    headings.push({ at, label: item.label, locator: item.locator });
    from = at + item.label.length;
  }
  if (!headings.length)
    return [
      {
        position: 0,
        label: title.slice(0, 250),
        locator: { scrollTop: 0 },
        text,
      },
    ];
  if (headings[0].at > 0)
    headings.unshift({ at: 0, label: title, locator: { scrollTop: 0 } });
  return headings.map((heading, index) => ({
    position: index,
    label: heading.label.slice(0, 250),
    locator: heading.locator,
    text: text.slice(heading.at, headings[index + 1]?.at ?? text.length),
  }));
}

// Keep each utterance short: sentence boundaries are also subtitle and seek
// boundaries, including on devices that do not emit speech boundary events.
export function narrationCues(slides: GuideSlide[]): GuideCue[] {
  let start = 0;
  return slides.flatMap((slide, index) => {
    const sentences =
      slide.narration.match(/[^。！？.!?\n]+[。！？.!?\n]*|[。！？.!?]+/gu) ||
      [];
    return sentences.flatMap((sentence) => {
      const points = Array.from(sentence.trim());
      const chunks: GuideCue[] = [];
      for (let at = 0; at < points.length; at += 70) {
        const text = points.slice(at, at + 70).join("");
        if (!text.trim()) continue;
        const cjk = text.match(/[\u3400-\u9fff]/gu)?.length || 0;
        const words =
          text.replace(/[\u3400-\u9fff]/gu, " ").match(/[\p{L}\p{N}]+/gu)
            ?.length || 0;
        const duration = Math.max(1.6, cjk / 4.2 + words / 2.5);
        chunks.push({ slide: index, text, duration, start });
        start += duration;
      }
      return chunks;
    });
  });
}
export function guideTime(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

// Extraction adds layout whitespace (PDF lines / EPUB blocks) that the visible
// text map may omit. Retain offsets into the real text instead of inventing an
// anchor from the extracted string. Ambiguous matches are not auto-selected.
export function findGuideExcerpt(text: string, excerpt: string) {
  const positions: number[] = [];
  let flat = "";
  for (let i = 0; i < text.length;) {
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    if (!/\s/u.test(cp)) {
      flat += cp;
      for (let j = 0; j < cp.length; j++) positions.push(i + j);
    }
    i += cp.length;
  }
  const needle = Array.from(excerpt).slice(0, 240).join("").replace(/\s/gu, "");
  if (needle.length < 4) return null;
  const at = flat.indexOf(needle);
  if (at < 0 || flat.indexOf(needle, at + 1) >= 0) return null;
  return { start: positions[at], end: positions[at + needle.length - 1] + 1 };
}
import type { OutlineItem } from "../readers/types";
import type { TextSection } from "../readers/bookText";
