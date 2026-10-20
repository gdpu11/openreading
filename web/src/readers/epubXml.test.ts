import { describe, expect, it } from "vitest";
import { repairEpubEntities } from "./epubXml";
const decode = (entity: string) =>
  ({ "&nbsp;": "\u00a0", "&copy;": "©", "&LT;": "<", "&AMP;": "&" })[entity] ||
  entity;
describe("legacy EPUB XML entities", () => {
  it("repairs raw ampersands in NCX text and link attributes without double escaping", () => {
    expect(
      repairEpubEntities(
        '<text>A&P &amp; B</text><content src="chapter.xhtml?a=1&b=2"/>',
        decode,
      ),
    ).toBe(
      '<text>A&amp;P &amp; B</text><content src="chapter.xhtml?a=1&amp;b=2"/>',
    );
  });
  it("encodes recognized HTML entities as XML-safe Unicode references", () => {
    expect(
      repairEpubEntities("<p>&nbsp;&copy;&LT;&AMP; &#160; &#xA0;</p>", decode),
    ).toBe("<p>&#160;&#169;&#60;&#38; &#160; &#xA0;</p>");
  });
  it("does not rewrite CDATA/comments or turn entities into active markup", () => {
    const value =
      "<!-- A&B --><![CDATA[A&B &nbsp;]]><p>&LT;script>Text&LT;/script></p>";
    expect(repairEpubEntities(value, decode)).toBe(
      "<!-- A&B --><![CDATA[A&B &nbsp;]]><p>&#60;script>Text&#60;/script></p>",
    );
    expect(repairEpubEntities("<p>&undefined;</p>", decode)).toBe(
      "<p>&undefined;</p>",
    );
  });
});
