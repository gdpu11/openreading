import { expect, test } from "vitest";
import { hasAssistantMention } from "./assistantMention";

test.each([
  ["@小阅 作者是谁？", true],
  ["作者是谁？@小阅", true],
  ["请@小阅解释一下", true],
  ["@ 小阅 帮我举个例子", true],
  ["我的普通笔记", false],
  ["作者是谁？@", false],
  ["代码 `@小阅` 不是提问", false],
  ["代码 ``@小阅`` 不是提问", false],
  ["```text\n@小阅\n```", false],
  ["~~~text\n@小阅\n~~~", false],
  ["```text\n@小阅", false],
  ["代码 `@小阅", false],
  ["\\@小阅", false],
  ["代码 `@小阅`。请 @小阅 解释", true],
])("recognizes an assistant mention in %s", (body, expected) => {
  expect(hasAssistantMention(body as string)).toBe(expected);
});
