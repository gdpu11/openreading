import { describe, expect, it } from "vitest";
import { localReadingVoice } from "./BookTools";
const voice = (lang: string, localService: boolean) =>
  ({ lang, localService }) as SpeechSynthesisVoice;
describe("private read aloud", () => {
  it("never selects an online voice for private book text", () => {
    expect(
      localReadingVoice([voice("zh-CN", false), voice("en-US", true)], "zh-CN"),
    ).toBeUndefined();
  });
  it("prefers the requested local language and accepts another local regional voice", () => {
    const regional = voice("zh-HK", true),
      exact = voice("zh-CN", true);
    expect(localReadingVoice([regional, exact], "zh-CN")).toBe(exact);
    expect(localReadingVoice([regional], "zh-CN")).toBe(regional);
  });
});
