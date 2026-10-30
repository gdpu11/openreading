import { expect, it } from "vitest";
import {
  detectIllustrations,
  lineInsideFigure,
  type OcrLine,
} from "./pdfIllustrations";

function page() {
  const width = 400,
    height = 600,
    data = new Uint8ClampedArray(width * height * 4).fill(255);
  const rect = (
    x: number,
    y: number,
    w: number,
    h: number,
    color = [0, 0, 0],
  ) => {
    for (let row = y; row < y + h; row++)
      for (let col = x; col < x + w; col++) {
        const at = (row * width + col) * 4;
        data.set([...color, 255], at);
      }
  };
  return { width, height, data, rect };
}
const line = (
  x: number,
  y: number,
  width: number,
  height: number,
): OcrLine => ({
  text: "正文",
  confidence: 1,
  alternatives: [],
  box: {
    x: x / 400,
    y: 1 - (y + height) / 600,
    width: width / 400,
    height: height / 600,
  },
});
it("extracts a real illustration without retaining recognized text or the full scanned page", () => {
  const p = page();
  p.rect(40, 40, 300, 12);
  p.rect(40, 65, 300, 12);
  p.rect(100, 200, 180, 140, [20, 100, 200]);
  const figures = detectIllustrations(p, [
    line(40, 40, 300, 12),
    line(40, 65, 300, 12),
  ]);
  expect(figures).toHaveLength(1);
  expect(figures[0].top).toBeGreaterThan(0.3);
  expect(figures[0].width * figures[0].height).toBeLessThan(0.2);
  expect(lineInsideFigure(line(120, 230, 90, 12), figures[0])).toBe(true);
  expect(lineInsideFigure(line(40, 40, 300, 12), figures[0])).toBe(false);
});
it("does not mistake text, page borders or scattered scan noise for illustrations", () => {
  const p = page();
  p.rect(1, 1, 2, 598);
  p.rect(1, 1, 398, 2);
  for (let row = 70; row < 450; row += 30)
    for (let x = 40; x < 340; x += 10) p.rect(x, row, 3, 8);
  expect(detectIllustrations(p, [])).toHaveLength(0);
});
it("retains chart strokes while text annotations remain inside the cropped picture", () => {
  const p = page();
  p.rect(70, 180, 220, 3);
  p.rect(70, 340, 220, 3);
  p.rect(70, 180, 3, 163);
  p.rect(287, 180, 3, 163);
  p.rect(100, 230, 110, 12);
  p.rect(110, 285, 160, 3);
  const figures = detectIllustrations(p, [line(100, 230, 110, 12)]);
  expect(figures).toHaveLength(1);
  expect(lineInsideFigure(line(100, 230, 110, 12), figures[0])).toBe(true);
});
it("never exports a page-sized border as a book illustration", () => {
  const p = page();
  p.rect(12, 14, 376, 3);
  p.rect(12, 583, 376, 3);
  p.rect(12, 14, 3, 572);
  p.rect(385, 14, 3, 572);
  expect(detectIllustrations(p, [])).toHaveLength(0);
});
it("keeps a full-page photograph and its overlaid caption in one picture", () => {
  const p = page();
  p.rect(20, 20, 360, 560, [150, 150, 150]);
  p.rect(60, 50, 90, 150, [255, 255, 255]);
  const caption = line(80, 460, 240, 18);
  const figures = detectIllustrations(p, [caption]);
  expect(figures).toHaveLength(1);
  expect(figures[0].width).toBeGreaterThan(0.9);
  expect(figures[0].height).toBeGreaterThan(0.9);
  expect(lineInsideFigure(caption, figures[0])).toBe(true);
});
