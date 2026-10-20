// Focus the parent document before writing: an EPUB selection lives in a child
// frame, and preventing mousedown on its toolbar intentionally preserves it.
export async function copyText(text: string, trigger?: HTMLElement) {
  trigger?.focus({ preventScroll: true });
  try {
    if (!navigator.clipboard?.writeText)
      throw Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const active = document.activeElement as HTMLElement | null;
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
    document.body.append(field);
    try {
      field.focus({ preventScroll: true });
      field.select();
      if (!document.execCommand("copy"))
        throw Error("复制失败，请手动复制选中的文字");
    } finally {
      field.remove();
      active?.focus({ preventScroll: true });
    }
  }
}
