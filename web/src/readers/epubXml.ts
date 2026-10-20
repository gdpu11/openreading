// Repair legacy EPUB entity spelling without treating malformed XML as HTML.
// That preserves XML namespaces, SVG and the document structure used by CFIs.
export function repairEpubEntities(
  source: string,
  decode: (entity: string) => string = (entity) =>
    new DOMParser().parseFromString(entity, "text/html").body.textContent ||
    entity,
): string {
  return source
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(/&(?!(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);)/gi, "&amp;")
            .replace(/&([a-z][a-z\d]*);/gi, (entity, name: string) => {
              if (["amp", "lt", "gt", "quot", "apos"].includes(name))
                return entity;
              const value = decode(entity);
              // Leave undefined entities as errors instead of guessing their meaning.
              if (value === entity) return entity;
              return Array.from(
                value,
                (char) => `&#${char.codePointAt(0)};`,
              ).join("");
            }),
    )
    .join("");
}
