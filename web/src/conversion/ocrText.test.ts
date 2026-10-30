import { expect, it } from "vitest";
import { ocrParagraphs } from "./ocrText";

it("merges wrapped Chinese body lines without changing their text", () => {
  const lines = [
    "为什么世间的管理者很多，而真能发挥他人长处者却不",
    "多？以林肯为例，为什么他要在指派了三位总司令之后，才",
    "能学会用人所长的道理？",
  ];
  const result = ocrParagraphs(lines.join("\n"));
  expect(result).toEqual([lines.join("")]);
});
it("preserves paragraph endings, blank boundaries, short titles and numbered lists", () => {
  const lines = [
    "第一章 卓有成效的管理者为什么需要系统地学习如何进行有效决策",
    "管理者需要将自己的时间安排与工作目标结合起来，",
    "并不断地检查实际工作中的效果。",
    "第二节",
    "这是一段完整的正文，不应因为后续出现标题而被合并",
    "1. 第一项工作",
    "管理者需要将自己的时间安排与工作目标结合起来，",
    "",
    "另起一段的正文也应当保留独立的段落边界，不应误合并。",
  ];
  const result = ocrParagraphs(lines.join("\n"));
  expect(result).toEqual([
    lines[0],
    lines[1] + lines[2],
    lines[3],
    lines[4],
    lines[5],
    lines[6],
    lines[8],
  ]);
  expect(result.join("")).toBe(lines.join(""));
});
it("keeps English titles and tables separate", () => {
  expect(
    ocrParagraphs(
      "德鲁克重要作品出版年表\n英文书名\nThe Future of Industrial Man\nConcept of the Corporation",
    ),
  ).toEqual([
    "德鲁克重要作品出版年表",
    "英文书名",
    "The Future of Industrial Man",
    "Concept of the Corporation",
  ]);
});
it("keeps a short final fragment with its preceding body line, while separating page numbers", () => {
  const first = "要知道职位应该根据客观需要而设定，并不应因为个人安排";
  expect(ocrParagraphs(first + "\n而定。\n77")).toEqual([
    first + "而定。",
    "77",
  ]);
});
