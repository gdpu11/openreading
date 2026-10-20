import { expect, it } from "vitest";
import { readingDuration } from "./BookWordCount";
import { setLanguage } from "../i18n";
it("estimates mixed-text units at the configured speed and rounds up", () => {
  setLanguage("zh");
  expect(readingDuration(1)).toBe("1 分钟");
  expect(readingDuration(300)).toBe("1 分钟");
  expect(readingDuration(301)).toBe("2 分钟");
  expect(readingDuration(18000)).toBe("1 小时 0 分钟");
  expect(readingDuration(18001)).toBe("1 小时 1 分钟");
  expect(readingDuration(600, 600)).toBe("1 分钟");
  expect(readingDuration(600, 0)).toBe("2 分钟");
  setLanguage("en");
  expect(readingDuration(18001)).toBe("1 h 1 min");
});
