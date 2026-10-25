import { describe, expect, it } from "vitest";
import {
  findGuideExcerpt,
  guideDocumentSections,
  guideTime,
  narrationCues,
  type GuideSlide,
} from "./types";

const slide = (narration: string): GuideSlide => ({
  title: "片段",
  narration,
  layout: "concept",
  items: [{ label: "要点", detail: "解释" }],
  sourceIds: ["S1"],
});
describe("video narration timeline", () => {
  it("keeps all text when splitting rendered Markdown into chapters", () => {
    const text = "开头第一章正文一第二章正文二";
    const sections = guideDocumentSections(text, "文档", [
      { label: "第一章", locator: { heading: 0 } },
      { label: "第二章", locator: { heading: 1 } },
    ]);
    expect(sections.map((v) => v.text).join("")).toBe(text);
    expect(sections.map((v) => v.label)).toEqual(["文档", "第一章", "第二章"]);
    expect(sections[2].locator).toEqual({ heading: 1 });
    expect(guideDocumentSections("没有标题", "纯文本", [])[0].text).toBe(
      "没有标题",
    );
  });
  it("keeps sentence subtitles and seek positions attached to the right chapter", () => {
    const cues = narrationCues([
      slide("先看问题。再看例子！"),
      slide("What changes? The result."),
    ]);
    expect(cues.map((v) => v.text)).toEqual([
      "先看问题。",
      "再看例子！",
      "What changes?",
      "The result.",
    ]);
    expect(cues.map((v) => v.slide)).toEqual([0, 0, 1, 1]);
    expect(cues[0].start).toBe(0);
    for (let i = 1; i < cues.length; i++)
      expect(cues[i].start).toBeCloseTo(
        cues[i - 1].start + cues[i - 1].duration,
      );
  });
  it("bounds subtitles by Unicode code points without losing narration", () => {
    const text = "😀中文".repeat(110);
    const cues = narrationCues([slide(text)]);
    expect(cues.map((v) => v.text).join("")).toBe(text);
    expect(cues.every((v) => Array.from(v.text).length <= 70)).toBe(true);
    expect(narrationCues([slide("   \n")])).toEqual([]);
    expect(guideTime(185.9)).toBe("3:05");
    expect(guideTime(-4)).toBe("0:00");
  });
});
describe("guide excerpt anchoring", () => {
  it("maps extraction whitespace back onto actual original text offsets", () => {
    const text = "标题😀原文中的事务边界。结尾";
    const found = findGuideExcerpt(text, "😀 原文中的\n事务边界。");
    expect(found).not.toBeNull();
    expect(text.slice(found!.start, found!.end)).toBe("😀原文中的事务边界。");
  });
  it("refuses invented and ambiguous quotes instead of attaching the wrong source", () => {
    expect(findGuideExcerpt("真实来源文字", "模型编造文字")).toBeNull();
    expect(
      findGuideExcerpt("同一个来源。另一个。同一个来源。", "同一个来源。"),
    ).toBeNull();
    expect(findGuideExcerpt("短", "短")).toBeNull();
  });
});
