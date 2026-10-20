export function clearEpubHighlights(rendition: any, previous: Set<string>) {
  for (const cfi of previous) rendition.annotations.remove(cfi, "highlight");
  previous.clear();
  // epub.js can attach the same CFI during both rendering and annotation
  // injection. Its view registry retains only the last mark, so remove any
  // orphaned marks from our layer before the current annotations are repainted.
  rendition.views().forEach((view: any) => {
    for (const mark of [...(view.pane?.marks || [])]) {
      if (mark.element?.classList.contains("epub-highlight"))
        view.pane.removeMark(mark);
    }
  });
}
