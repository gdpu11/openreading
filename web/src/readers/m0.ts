import ePub from "epubjs";
import * as pdfjs from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { projectQuad } from "./anchors";
pdfjs.GlobalWorkerOptions.workerSrc = worker;
(window as any).m0 = {
  async pdf() {
    const d = await pdfjs.getDocument({ url: "/fixtures/双栏与扫描混合.pdf" })
      .promise;
    const p = await d.getPage(1);
    let maxError = 0;
    for (const scale of [0.5, 1, 2])
      for (const rotation of [0, 90, 180, 270]) {
        const v = p.getViewport({ scale, rotation });
        const q = [45, 695, 250, 695, 250, 710, 45, 710];
        const rect = projectQuad(q, v);
        for (let i = 0; i < 8; i += 2) {
          const xy = v.convertToViewportPoint(q[i], q[i + 1]);
          const back = v.convertToPdfPoint(...(xy as [number, number]));
          maxError = Math.max(
            maxError,
            Math.abs(back[0] - q[i]),
            Math.abs(back[1] - q[i + 1]),
          );
        }
        if (rect.width <= 0 || rect.height <= 0) throw Error("bad quad");
      }
    const scanned = await (await d.getPage(2)).getTextContent();
    const text = await p.getTextContent();
    await d.cleanup();
    return {
      maxError,
      scannedItems: scanned.items.length,
      textItems: text.items.length,
    };
  },
  async epub() {
    const bytes = await (await fetch("/fixtures/可靠接口.epub")).arrayBuffer();
    const b = ePub(bytes);
    const r: any = b.renderTo("epub", {
      width: 750,
      height: 600,
      flow: "scrolled-doc",
      allowScriptedContent: false,
    });
    await r.display();
    const c = r.getContents()[0];
    const text = c.document.querySelector("p")!.firstChild!;
    const range = c.document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 12);
    const expected = range.toString();
    const cfi = c.cfiFromRange(range);
    r.themes.fontSize("24px");
    r.themes.override("line-height", "2");
    r.resize(550, 650);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const after = await b.getRange(cfi);
    const result = { cfi, expected, actual: after.toString() };
    b.destroy();
    return result;
  },
};
