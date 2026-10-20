import { describe, it, expect } from "vitest";
import {
  cpOffset,
  utf16Offset,
  quoteAt,
  resolveQuote,
  projectQuad,
} from "./anchors";
describe("M0 Unicode and conservative relocation", () => {
  it("A08 preserves rare Chinese emoji combining marks and inline code offsets", () => {
    const t = "中文𠮷👩‍💻e\u0301`接口`结束";
    for (let i = 0; i <= Array.from(t).length; i++)
      expect(cpOffset(t, utf16Offset(t, i))).toBe(i);
    expect(quoteAt(t, 2, 8).exact).toBe("𠮷👩‍💻e\u0301");
  });
  it("A11 never silently resolves duplicate quotes or rewritten/deleted text", () => {
    const q = { exact: "幂等", visible: "幂等", prefix: "", suffix: "" };
    expect(resolveQuote("幂等；幂等", q).state).toBe("ambiguous");
    expect(resolveQuote("删除", q).state).toBe("missing");
    expect(resolveQuote("新增段落：幂等", q).start).toBe(5);
  });
  it("requires complete adjacent context on migration", () => {
    const q = quoteAt("前文原句后文", 2, 4);
    expect(resolveQuote("新增前文原句后文", q).state).toBe("resolved");
    expect(resolveQuote("前文原句被改", q).state).toBe("missing");
  });
  it("A04 projects native PDF coordinates through all scales and rotations", () => {
    for (const s of [0.5, 1, 2])
      for (const r of [0, 90, 180, 270]) {
        const rad = (r * Math.PI) / 180;
        const v = {
          convertToViewportPoint: (x: number, y: number) => [
            s * (x * Math.cos(rad) - y * Math.sin(rad)),
            s * (x * Math.sin(rad) + y * Math.cos(rad)),
          ],
        };
        const rect = projectQuad([10, 20, 110, 20, 110, 40, 10, 40], v);
        expect(rect.width).toBeCloseTo((r % 180 ? 20 : 100) * s);
        expect(rect.height).toBeCloseTo((r % 180 ? 100 : 20) * s);
      }
  });
});
