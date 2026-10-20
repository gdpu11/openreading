export function hasAssistantMention(body: string): boolean {
  // Ignore Markdown code, including code still being typed without a closing fence.
  const prose = body
    .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, "")
    .replace(/(`+)[^\n]*?(?:\1|$)/g, "");
  return /(^|[^\\])@[\t ]*小阅/.test(prose);
}
