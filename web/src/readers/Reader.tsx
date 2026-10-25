import { readingFormat } from "../formats";
import { clearEpubHighlights } from "./epubHighlights";
import { tr } from "../i18n";
import { BookWordCount } from "./BookWordCount";
import {
  bodyText,
  countTextWords,
  bookWordCount,
  pdfWordCount,
  type BookWordCount as Count,
} from "./wordCount";
import { PdfPages, type PdfPagesHandle } from "./PdfPages";
import { usePdfZoom } from "./pdfZoom";
import { createPortal } from "react-dom";
import { SessionTimer } from "../reading/SessionTimer";
import { ReadingProgress } from "../reading/ReadingProgress";
import { findGuideExcerpt } from "../video/types";
import type { ReadingEvent } from "../reading/data";
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  useCallback,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import * as pdfjs from "./pdf";
import { openEpub, epubCSP } from "./epub";
import { api, readContent, pdfSource, imageSource } from "../api";
import {
  NORMALIZATION,
  captureRange,
  rangeAt,
  resolveQuote,
  textMap,
  pdfQuads,
  projectQuad,
  quoteAt,
  cpOffset,
} from "./anchors";
import type { Anchor, Selector } from "./anchors";
import type {
  Captured,
  Prepared,
  ReaderAdapter,
  ReaderPreferences,
  OutlineItem,
} from "./types";
import "katex/dist/katex.min.css";
import "pdfjs-dist/web/pdf_viewer.css";
const PARSERS = {
  markdown: "react-markdown-10-map-v1",
  txt: "txt-map-v1",
  pdf: "pdfjs-6.4.299-map-v1",
  epub: "epubjs-0.3.93-map-v1",
};
type Props = {
  progressContainer?: HTMLElement | null;
  timerContainer?: HTMLElement | null;
  wordCountContainer?: HTMLElement | null;
  pageNumberContainer?: HTMLElement | null;
  pdfControlsContainer?: HTMLElement | null;
  activityEnabled?: boolean;
  onReading?: (event: ReadingEvent) => void;
  onPdfScaleChange?: (scale: number, persist: boolean) => void;
  doc: Prepared;
  preferences: ReaderPreferences;
  annotations: any[];
  onSelect: (s: Captured | null) => void;
  onSelectionPosition?: (rect: Captured["rect"]) => void;
  onPickThread: (ids: string[]) => void;
  onProgress: (locator: any) => void;
  onOutline: (outline: OutlineItem[]) => void;
  onError: (s: string) => void;
  onResolved?: () => void;
  onReady?: () => void;
};
export const Reader = forwardRef<ReaderAdapter, Props>(
  function Reader(props, ref) {
    const { doc: sourceDoc, preferences: p } = props;
    const doc = { ...sourceDoc, format: readingFormat(sourceDoc.format) };
    const parserVersion = (sourceDoc.format === doc.format ? "" : `normalized-${sourceDoc.format}-v1:`) + PARSERS[doc.format as keyof typeof PARSERS];
    const host = useRef<HTMLDivElement>(null);
    const textRoot = useRef<HTMLElement | null>(null);
    const pendingTextCount = useRef<(() => void) | null>(null);
    const [text, setText] = useState("");
    const [wordCount, setWordCount] = useState<Count | null | "unavailable">(
      null,
    );
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [percentage, setPercentage] = useState<number | null>(null);
    const [indexing, setIndexing] = useState(false);
    const epubIndexReady = useRef(false);
    const [page, setPage] = useState<number>(
      doc.initialAnchor?.displayLocation?.pageIndex ??
        doc.readingState?.locator?.pageIndex ??
        0,
    );
    const [pages, setPages] = useState(0);
    const [epubPagination, setEpubPagination] = useState<{
      first: number;
      last: number;
      total: number;
    } | null>(null);
    const [pageText, setPageText] = useState(true);
    const [password, setPassword] = useState("");
    const [needsPassword, setNeedsPassword] = useState(false);
    const [marks, setMarks] = useState<any[]>([]);
    const [manifest, setManifest] = useState(doc.resourceManifestId);
    const [resources, setResources] = useState<any[]>([]);
    const pdf = useRef<any>(null),
      passwordCallback = useRef<any>(null),
      book = useRef<any>(null),
      rendition = useRef<any>(null);
    const epubHighlights = useRef(new Set<string>());
    const latest = useRef(props);
    latest.current = props;
    const outlineRef = useRef<OutlineItem[]>([]);
    const captured = useRef<Captured | null>(null);
    const capturedRange = useRef<Range | null>(null);
    const positionFrame = useRef<number | undefined>(undefined);
    const positionReporter = useRef<() => void>(() => {});
    const schedulePosition = () => {
      if (positionFrame.current !== undefined)
        cancelAnimationFrame(positionFrame.current);
      positionFrame.current = requestAnimationFrame(() => {
        positionFrame.current = undefined;
        positionReporter.current();
      });
    };
    const updateEpubPagination = (location: any) => {
      const start = location?.start?.displayed;
      if (!Number.isInteger(start?.total) || start.total < 1) return;
      const total = start.total;
      const first = Math.max(1, Math.min(total, start.page || 1));
      const end = location.end;
      const last =
        end?.index === location.start.index
          ? Math.max(first, Math.min(total, end.displayed?.page || first))
          : first;
      setEpubPagination((previous) =>
        previous?.first === first &&
        previous.last === last &&
        previous.total === total
          ? previous
          : { first, last, total },
      );
    };
    const currentLocator = useRef<any>({});
    const navigationHistory = useRef<any[]>([]);
    const publishPosition = (locator: any, fraction?: number | null) => {
      currentLocator.current = locator;
      const value =
        fraction == null || !Number.isFinite(fraction)
          ? null
          : Math.round(Math.max(0, Math.min(1, fraction)) * 1000) / 10;
      setPercentage(value);
      latest.current.onProgress({
        ...locator,
        ...(value == null ? {} : { percentage: value }),
      });
    };
    positionReporter.current = () => {
      const el = host.current;
      if (!el || loading || error || needsPassword) return;
      if (doc.format === "markdown" || doc.format === "txt") {
        const maximum = el.scrollHeight - el.clientHeight;
        publishPosition(
          { scrollTop: el.scrollTop },
          maximum > 0 ? el.scrollTop / maximum : 1,
        );
      } else if (doc.format === "epub") {
        const r = rendition.current,
          b = book.current;
        const location = r?.currentLocation();
        updateEpubPagination(location);
        const contents = r?.getContents()[0];
        if (!location?.start?.cfi || !contents) return;
        let cfi = location.start.cfi;
        const scrolling = latest.current.preferences.epubFlow !== "paginated";
        if (scrolling) {
          const frame = el.querySelector("iframe");
          if (frame) {
            const bounds = frame.getBoundingClientRect();
            const body = contents.document.body;
            const bodyBounds = body.getBoundingClientRect();
            const padding =
              parseFloat(contents.window.getComputedStyle(body).paddingLeft) ||
              0;
            const bar = el
              .querySelector(".reader-progress")
              ?.getBoundingClientRect();
            const x = Math.min(
              bounds.width - 2,
              Math.max(1, bodyBounds.left + padding + 2),
            );
            const y = Math.min(
              bounds.height - 2,
              Math.max(
                1,
                Math.max(
                  bar?.bottom || el.getBoundingClientRect().top,
                  r.manager.container.getBoundingClientRect().top,
                ) +
                  4 -
                  bounds.top,
              ),
            );
            const inner = contents.document;
            let range = inner.caretRangeFromPoint?.(x, y);
            if (!range && inner.caretPositionFromPoint) {
              const caret = inner.caretPositionFromPoint(x, y);
              if (caret) {
                range = inner.createRange();
                range.setStart(caret.offsetNode, caret.offset);
                range.collapse(true);
              }
            }
            if (range && body.contains(range.startContainer))
              cfi = contents.cfiFromRange(range);
          }
        }
        let fraction =
          epubIndexReady.current && b.locations.length()
            ? b.locations.percentageFromCfi(cfi)
            : epubIndexReady.current
              ? (() => {
                  const sections = b.spine.spineItems.filter(
                    (section: any) => section.linear,
                  );
                  const index = sections.findIndex(
                    (section: any) => section.index === location.start.index,
                  );
                  return Math.max(0, index) / Math.max(1, sections.length);
                })()
              : null;
        const last = b.spine.spineItems
          .filter((section: any) => section.linear)
          .at(-1);
        const chapterScroll = r.manager.container as HTMLElement;
        const atBottom =
          chapterScroll.scrollHeight > chapterScroll.clientHeight + 2
            ? chapterScroll.scrollTop >=
              chapterScroll.scrollHeight - chapterScroll.clientHeight - 2
            : el.scrollTop >= el.scrollHeight - el.clientHeight - 2;
        if (
          fraction != null &&
          (scrolling
            ? location.start.index === last?.index && atBottom
            : location.atEnd)
        )
          fraction = 1;
        publishPosition(
          {
            cfi,
            href: location.start.href,
            spineIndex: location.start.index,
            ...(scrolling ? { scrollTop: el.scrollTop } : {}),
          },
          fraction,
        );
      }
    };
    useEffect(
      () => () => {
        if (positionFrame.current !== undefined)
          cancelAnimationFrame(positionFrame.current);
      },
      [],
    );
    useEffect(() => {
      if (!loading) schedulePosition();
    }, [loading, text]);
    const generation = useRef(0);
    const pdfPages = useRef<PdfPagesHandle>(null);
    usePdfZoom(
      host,
      p.pdfScale,
      doc.format === "pdf" && props.activityEnabled !== false,
      props.onPdfScaleChange,
      (point) => pdfPages.current?.anchorZoom(point),
    );
    const pdfCurrentPage = useRef(page);
    const initialPdfNavigation = useRef(false);
    const goToPdfPage = (index: number) => {
      setPage(index);
      pdfCurrentPage.current = index;
      pdfPages.current?.goTo(index);
      setSelectionCleared();
    };
    const selectionRequest = useRef(0);
    const setSelectionCleared = () => {
      selectionRequest.current++;
      captured.current = null;
      capturedRange.current = null;
      latest.current.onSelect(null);
    };
    const displayEpubAt = async (r: any, target?: string) => {
      await r.display(target);
      if (!target || rendition.current !== r) return;
      // Theme/font layout can finish after the first display positioned the
      // CFI, especially when entering a chapter for the first time.
      await r.getContents()[0]?.document.fonts?.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (rendition.current === r) await r.display(target);
    };
    const seekProgress = async (percentage: number) => {
      const fraction = Math.max(0, Math.min(1, percentage / 100));
      const r = rendition.current;
      try {
        setSelectionCleared();
        if (doc.format === "pdf") {
          const index = Math.max(
            0,
            Math.min(pages - 1, Math.ceil(fraction * pages) - 1),
          );
          goToPdfPage(index);
          publishPosition(
            { pageIndex: index, pageOffset: 0 },
            (index + 1) / pages,
          );
        } else if (doc.format === "epub") {
          if (!r || !epubIndexReady.current) return;
          const b = book.current;
          const sections = b.spine.spineItems.filter(
            (section: any) => section.linear,
          );
          const target =
            fraction === 0
              ? sections[0]?.href
              : fraction === 1
                ? sections.at(-1)?.href
                : b.locations.length()
                  ? b.locations.cfiFromPercentage(fraction)
                  : sections[
                      Math.min(
                        sections.length - 1,
                        Math.floor(fraction * sections.length),
                      )
                    ]?.href;
          if (!target) return;
          await displayEpubAt(r, target);
          if (rendition.current !== r) return;
          // Text locations omit image-only covers and trailing illustrations.
          // The endpoints must include the actual first/last rendered page.
          if (fraction === 1) {
            const manager = r.manager,
              stage = manager.container;
            if (manager.settings.axis === "vertical")
              manager.scrollTo(0, stage.scrollHeight, true);
            else {
              let left = Math.max(0, stage.scrollWidth - manager.layout.delta);
              if (manager.settings.direction === "rtl")
                left = manager.settings.rtlScrollType === "default" ? 0 : -left;
              manager.scrollTo(left, 0, true);
            }
          }
          if (host.current) host.current.scrollTop = 0;
          positionReporter.current();
        } else if (host.current) {
          const el = host.current;
          el.scrollTo({
            top: fraction * (el.scrollHeight - el.clientHeight),
            behavior: "instant",
          });
          positionReporter.current();
        }
      } catch {
        if (doc.format !== "epub" || rendition.current === r)
          latest.current.onError("无法跳转到阅读位置，请重试。");
      }
    };
    const turningEpub = useRef<any>(null);
    const turnPage = (direction: -1 | 1) => {
      if (loading || error || needsPassword) return;
      if (doc.format === "pdf") {
        goToPdfPage(
          Math.max(
            0,
            Math.min(
              pages - 1,
              pdfCurrentPage.current +
                direction * (pdfPages.current?.step() || 1),
            ),
          ),
        );
      } else if (doc.format === "epub") {
        const r = rendition.current;
        if (!r || turningEpub.current === r) return;
        turningEpub.current = r;
        void (direction < 0 ? r.prev() : r.next())
          .catch((e: any) => {
            if (rendition.current === r) latest.current.onError(e.message);
          })
          .finally(() => {
            if (turningEpub.current === r) turningEpub.current = null;
          });
      } else {
        const el = host.current;
        if (el) el.scrollBy({ top: direction * el.clientHeight * 0.9 });
      }
    };
    const keyboardTurn = useRef(turnPage);
    keyboardTurn.current = turnPage;
    const handlePageKey = useCallback((event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
        latest.current.activityEnabled === false
      )
        return;
      // EPUB events originate in another window; instanceof Element would
      // reject those targets. Keep text editing and native controls intact.
      const target = event.target as Element | null;
      if (
        target?.nodeType !== 1 ||
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="menu"], [role="listbox"]',
        )
      )
        return;
      const selection = target.ownerDocument.defaultView?.getSelection();
      if (selection && !selection.isCollapsed) return;
      event.preventDefault();
      keyboardTurn.current(event.key === "ArrowLeft" ? -1 : 1);
    }, []);
    useEffect(() => {
      document.addEventListener("keydown", handlePageKey);
      return () => document.removeEventListener("keydown", handlePageKey);
    }, [handlePageKey]);
    const scrollPdfTo = (anchor: Anchor) => {
      const selector = anchor.selectors.find((s) => s.type === "pdf");
      const container = host.current;
      const index =
        selector?.type === "pdf"
          ? selector.pageIndex
          : anchor.displayLocation.pageIndex || 0;
      const view = pdfPages.current?.get(index);
      if (!container || !view) return;
      const pageElement = view.element;
      const position =
        selector?.type === "pdf" && selector.quads[0]
          ? projectQuad(selector.quads[0], view.viewport)
          : { left: 0, top: 0 };
      const box = pageElement.getBoundingClientRect(),
        hostBox = container.getBoundingClientRect();
      container.scrollTo({
        top: Math.max(
          0,
          box.top -
            hostBox.top +
            container.scrollTop +
            position.top -
            container.clientHeight * 0.3,
        ),
        left: Math.max(
          0,
          box.left -
            hostBox.left +
            container.scrollLeft +
            position.left -
            container.clientWidth * 0.3,
        ),
        behavior: "smooth",
      });
    };
    const outline = (items: OutlineItem[]) => {
      outlineRef.current = items;
      latest.current.onOutline(items);
    };
    const root = () =>
      doc.format === "pdf"
        ? pdfPages.current?.get(pdfCurrentPage.current)?.textLayer || null
        : doc.format === "epub"
          ? host.current?.querySelector<HTMLIFrameElement>("iframe")
              ?.contentDocument?.body || textRoot.current
          : textRoot.current;
    const selectionRect = (range: Range): Captured["rect"] => {
      if (!host.current || !range.startContainer.isConnected)
        return { left: 0, top: 0, visible: false };
      const box = range.getBoundingClientRect();
      const frame = range.startContainer.ownerDocument?.defaultView
        ?.frameElement as HTMLElement | null;
      const frameBox = frame?.getBoundingClientRect();
      const scaleX =
        frame && frameBox ? frameBox.width / Math.max(1, frame.offsetWidth) : 1;
      const scaleY =
        frame && frameBox
          ? frameBox.height / Math.max(1, frame.offsetHeight)
          : 1;
      const container = host.current!.getBoundingClientRect();
      const left =
        box.left * scaleX +
        (frameBox?.left || 0) +
        (frame?.clientLeft || 0) * scaleX -
        container.left;
      const top =
        box.top * scaleY +
        (frameBox?.top || 0) +
        (frame?.clientTop || 0) * scaleY -
        container.top;
      const bottom = top + box.height * scaleY;
      return {
        left,
        top,
        bottom,
        visible:
          bottom > 0 &&
          top < container.height &&
          left + box.width * scaleX > 0 &&
          left < container.width,
      };
    };
    const refreshSelectionPosition = () => {
      if (capturedRange.current?.startContainer.isConnected)
        latest.current.onSelectionPosition?.(
          selectionRect(capturedRange.current),
        );
      else if (capturedRange.current)
        latest.current.onSelectionPosition?.({
          left: 0,
          top: 0,
          visible: false,
        });
    };
    const epubHeight = () => {
      if (!host.current) return 1;
      const container = host.current.querySelector<HTMLElement>(
        ":scope > .epub-container",
      );
      if (
        latest.current.preferences.epubFlow === "paginated" &&
        container?.clientHeight
      )
        return container.clientHeight;
      const rootStyle = getComputedStyle(host.current);
      let used =
        parseFloat(rootStyle.paddingTop) + parseFloat(rootStyle.paddingBottom);
      for (const el of host.current.querySelectorAll<HTMLElement>(
        ":scope > .page-tools, :scope > .reader-progress",
      )) {
        const style = getComputedStyle(el);
        used +=
          el.offsetHeight +
          parseFloat(style.marginTop) +
          parseFloat(style.marginBottom);
      }
      return Math.max(1, host.current.clientHeight - used);
    };
    const fitEpubCover = (contents: any) => {
      // A standalone cover is a page, not a 1400x2100 scrolling illustration.
      const cover = contents.document.body.querySelector(
        ":scope > svg:only-child, :scope > img:only-child, :scope > div:only-child > svg:only-child, :scope > div:only-child > img:only-child",
      ) as HTMLElement | null;
      if (!cover || !host.current) return;
      if (cover.tagName.toLowerCase() === "svg") {
        // Calibre covers may opt out of aspect preservation. CSS object-fit
        // does not control an inline SVG's viewBox or its embedded raster.
        cover.setAttribute("preserveAspectRatio", "xMidYMid meet");
        cover.querySelectorAll("image").forEach((image) => {
          image.setAttribute("preserveAspectRatio", "xMidYMid meet");
        });
      }
      const column = rendition.current?._layout?.columnWidth;
      cover.style.width =
        latest.current.preferences.epubFlow === "paginated" && column
          ? column + "px"
          : "100%";
      cover.style.height = Math.max(1, epubHeight() - 40) + "px";
      cover.style.objectFit = "contain";
      cover.style.display = "block";
    };
    const artifact = async (
      element: HTMLElement,
      blockId: string,
      locator: any,
    ) => {
      const block = { id: blockId, text: textMap(element).text, locator };
      const response = await api("/artifacts", "POST", {
        workspaceDocumentId: doc.workspaceDocumentId,
        versionId: doc.version.id,
        parserVersion: parserVersion,
        normalizationVersion: NORMALIZATION,
        blocks: [block],
      });
      return { id: response.id, blocks: [block] };
    };
    const makeSelection = useCallback(
      async (
        override?: Range,
        element?: HTMLElement,
        requireNativeSelection = true,
      ): Promise<Captured | null> => {
        let el =
          element || root() || (doc.format === "pdf" ? host.current : null);
        if (!el) return null;
        let selection = el.ownerDocument.defaultView?.getSelection();
        if (!override && (!selection?.rangeCount || selection.isCollapsed))
          return null;
        const range = (override || selection!.getRangeAt(0)).cloneRange();
        let selectedPage = page;
        if (doc.format === "pdf") {
          const start =
            range.startContainer.nodeType === Node.ELEMENT_NODE
              ? (range.startContainer as Element)
              : range.startContainer.parentElement;
          const row = start?.closest<HTMLElement>(".pdf-page");
          if (!row) return null;
          selectedPage = Number(row.dataset.pageIndex);
          el = pdfPages.current?.get(selectedPage)?.textLayer || null;
          if (!el) return null;
        }
        if (!el.contains(range.commonAncestorContainer))
          throw Error("请在同一页或章节选择，跨页内容请分段批注");
        const snap = captureRange(el, range);
        if (!snap.quote.exact.trim()) return null;
        if (Array.from(snap.quote.exact).length > 20000)
          throw Error("选段过长，请缩小选区");
        const location: any = {
          label: doc.format === "pdf" ? `第 ${selectedPage + 1} 页` : doc.title,
        };
        const block =
          doc.format === "pdf"
            ? `page-${selectedPage}`
            : doc.format === "epub"
              ? `spine-${rendition.current?.currentLocation()?.start?.index || 0}`
              : "body";
        let selectors: Selector[] = [
          { type: "text", start: snap.start, end: snap.end, block },
        ];
        if (doc.format === "pdf") {
          location.pageIndex = selectedPage;
          const pageBox = el.getBoundingClientRect();
          selectors.push({
            type: "pdf",
            pageIndex: selectedPage,
            quads: pdfQuads(
              Array.from(range.getClientRects()),
              pageBox,
              pdfPages.current!.get(selectedPage)!.viewport,
            ),
          });
        }
        if (doc.format === "epub") {
          const c = rendition.current
            ?.getContents()
            .find((v: any) => v.document === el.ownerDocument);
          if (!c) throw Error("章节尚未准备好");
          const href =
            c.section?.href ||
            book.current.spine.get(c.sectionIndex)?.href ||
            "";
          selectors.push({ type: "epub", cfi: c.cfiFromRange(range), href });
          location.label = href;
        }
        const snapshot = range.cloneRange();
        const data = await artifact(el, block, location);
        if (
          !host.current?.isConnected ||
          latest.current.doc.version.id !== doc.version.id ||
          latest.current.doc.workspaceDocumentId !== doc.workspaceDocumentId
        )
          throw Error("文档已切换，请重新选择");
        const anchor: Anchor = {
          schemaVersion: 1,
          workspaceDocumentId: doc.workspaceDocumentId,
          documentVersionId: doc.version.id,
          extractionArtifactId: data.id,
          resourceManifestId: manifest,
          targetKind: "text",
          quote: snap.quote,
          selectors,
          displayLocation: location,
          normalizationVersion: NORMALIZATION,
          parserVersion: parserVersion,
        };
        const result: Captured = {
          anchor,
          artifact: data,
          context: {
            blockId: block,
            quote: snap.quote,
            text: data.blocks[0].text,
            locator: location,
          },
          rect: selectionRect(snapshot),
        };
        if (snapshot.toString() !== snap.quote.visible)
          throw Error("选区已变化，请重新选择");
        // Capturing the artifact can outlive the native selection. Explicit
        // source excerpts instead rely on the immutable version and range above.
        const current = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (
          requireNativeSelection &&
          (!current ||
            selection!.isCollapsed ||
            current.compareBoundaryPoints(Range.START_TO_START, snapshot) !== 0 ||
            current.compareBoundaryPoints(Range.END_TO_END, snapshot) !== 0)
        )
          return null;
        captured.current = result;
        capturedRange.current = snapshot;
        return result;
      },
      [doc.version.id, doc.workspaceDocumentId, page, manifest],
    );
    const publishSelection = (range?: Range, element?: HTMLElement) => {
      const request = ++selectionRequest.current;
      void makeSelection(range, element)
        .then((selection) => {
          if (request === selectionRequest.current)
            latest.current.onSelect(selection);
        })
        .catch((e) => {
          if (request === selectionRequest.current)
            latest.current.onError(e.message);
        });
    };
    const resolve = async (
      anchor: Anchor,
    ): Promise<{ state: string; range?: Range | null }> => {
      const pdfSelector = anchor.selectors.find((s) => s.type === "pdf");
      const el =
        doc.format === "pdf"
          ? pdfPages.current?.get(
              pdfSelector?.type === "pdf"
                ? pdfSelector.pageIndex
                : anchor.displayLocation.pageIndex || 0,
            )?.textLayer
          : root();
      if (!el) return { state: "unsupported" };
      if (anchor.targetKind === "page") return { state: "resolved" };
      const epub = anchor.selectors.find((x) => x.type === "epub");
      if (epub && epub.type === "epub" && book.current) {
        try {
          const range = await book.current.getRange(epub.cfi);
          if (range?.toString() === anchor.quote.visible)
            return { state: "resolved", range };
        } catch {
          return { state: "missing" };
        }
      }
      const sel = anchor.selectors.find((x) => x.type === "text");
      if (!sel || sel.type !== "text") return { state: "unsupported" };
      const resolved = resolveQuote(
        textMap(el).text,
        anchor.quote,
        sel,
        anchor.documentVersionId === doc.version.id,
      );
      return {
        ...resolved,
        range:
          resolved.start !== undefined
            ? rangeAt(el, resolved.start, resolved.end!)
            : undefined,
      };
    };
    const paint = useCallback(async () => {
      const el = root();
      if ((!el && doc.format !== "pdf") || !host.current) return;
      const hostBox = host.current.getBoundingClientRect();
      const list: any[] = [];
      // EPUB highlights live in the rendition's own registry, unlike the
      // React overlay. Remove the previous set before painting current data.
      if (doc.format === "epub" && rendition.current) {
        clearEpubHighlights(rendition.current, epubHighlights.current);
      }
      for (const a of latest.current.annotations) {
        let anchor: Anchor = a.anchor;
        let state = "resolved";
        const mapped = a.resolutions?.find(
          (r: any) =>
            r.targetVersionId === doc.version.id && r.state === "resolved",
        );
        if (mapped?.selector?.anchor) anchor = mapped.selector.anchor;
        if (anchor.documentVersionId !== doc.version.id) {
          const resolution = a.resolutions?.find(
            (r: any) => r.targetVersionId === doc.version.id,
          );
          if (!resolution || resolution.state !== "resolved") continue;
          anchor = resolution.selector?.anchor || anchor;
          state = resolution.state;
        }
        if (state !== "resolved" || anchor.targetKind === "page") continue;
        const pdfSel = anchor.selectors.find((x) => x.type === "pdf");
        if (pdfSel && pdfSel.type === "pdf" && doc.format === "pdf") {
          const view = pdfPages.current?.get(pdfSel.pageIndex);
          if (!view) continue;
          const b = view.textLayer.getBoundingClientRect();
          for (const quad of pdfSel.quads) {
            const r = projectQuad(quad, view.viewport);
            list.push({
              ...r,
              left: r.left + b.left - hostBox.left + host.current.scrollLeft,
              top: r.top + b.top - hostBox.top + host.current.scrollTop,
              threadId: a.threadId,
              color: a.style?.color,
              underline: a.style?.underline,
            });
          }
        } else if (doc.format === "epub") {
          const sel = anchor.selectors.find((x) => x.type === "epub");
          if (sel?.type === "epub" && rendition.current) {
            try {
              epubHighlights.current.add(sel.cfi);
              rendition.current.annotations.remove(sel.cfi, "highlight");
              rendition.current.annotations.highlight(
                sel.cfi,
                { threadId: a.threadId },
                () => latest.current.onPickThread([a.threadId]),
                "epub-highlight",
                {
                  fill: a.style?.color || "#d8bd65",
                  "fill-opacity": ".3",
                  "mix-blend-mode": "multiply",
                },
              );
            } catch {
              /* Another chapter: repaint when displayed. */
            }
          }
        } else {
          const r = await resolve(anchor);
          if (r.state !== "resolved" || !r.range) continue;
          for (const rect of Array.from(r.range.getClientRects()) as DOMRect[])
            if (rect.width > 0)
              list.push({
                left: rect.left - hostBox.left + host.current.scrollLeft,
                top: rect.top - hostBox.top + host.current.scrollTop,
                width: rect.width,
                height: rect.height,
                threadId: a.threadId,
                color: a.style?.color,
                underline: a.style?.underline,
              });
        }
      }
      setMarks(list);
    }, [
      page,
      doc.version.id,
      p.pdfScale,
      p.pdfRotation,
      p.fontSize,
      p.lineHeight,
    ]);
    useImperativeHandle(ref, () => ({
      getOutline: () => outlineRef.current,
      captureSelection: makeSelection,
      clearNativeSelection() {
        root()?.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
        window.getSelection()?.removeAllRanges();
      },
      resolveAnchor: resolve,
      async navigateTo(anchor) {
        if (Object.keys(currentLocator.current).length)
          navigationHistory.current = [
            ...navigationHistory.current.slice(-49),
            { ...currentLocator.current },
          ];
        const sel = anchor.selectors.find((x) => x.type === "pdf");
        if (doc.format === "pdf") {
          const index =
            sel?.type === "pdf"
              ? sel.pageIndex
              : anchor.displayLocation.pageIndex || 0;
          goToPdfPage(index);
          for (let i = 0; i < 80 && !pdfPages.current?.get(index); i++)
            await new Promise((r) => setTimeout(r, 50));
          if (!pdfPages.current?.get(index))
            throw Error("此页仍在渲染，请稍后重试");
          scrollPdfTo(anchor);
          return;
        }
        const epub = anchor.selectors.find((x) => x.type === "epub");
        if (epub?.type === "epub" && rendition.current) {
          await rendition.current.display(epub.cfi);
          return;
        }
        if (doc.format !== "pdf") {
          const resolution = await resolve(anchor);
          if (resolution.state !== "resolved" || !resolution.range)
            throw Error("原句待重新定位，请查看原版本");
          const el = resolution.range.startContainer.parentElement;
          el?.scrollIntoView({ block: "center", behavior: "smooth" });
          el?.animate(
            [{ background: "#efe0a0" }, { background: "transparent" }],
            { duration: 1800 },
          );
        } else scrollPdfTo(anchor);
      },
      async extractContext(anchor, policy) {
        const a = await api(
          "/artifacts/" +
            anchor.extractionArtifactId +
            "?workspaceDocumentId=" +
            doc.workspaceDocumentId,
        );
        const sel = anchor.selectors.find((x) => x.type === "text");
        const block =
          a.blocks.find(
            (b: any) => b.id === (sel?.type === "text" ? sel.block : "body"),
          ) || a.blocks[0];
        return {
          workspaceDocumentId: doc.workspaceDocumentId,
          documentVersionId: anchor.documentVersionId,
          extractionArtifactId: anchor.extractionArtifactId,
          resourceManifestId: anchor.resourceManifestId,
          normalizationVersion: NORMALIZATION,
          artifactHash: a.artifactHash,
          fragments:
            anchor.targetKind === "page"
              ? []
              : [
                  {
                    blockId: block.id,
                    start: sel?.type === "text" ? sel.start : 0,
                    end:
                      sel?.type === "text"
                        ? sel.end
                        : Array.from(anchor.quote.exact).length,
                    text: anchor.quote.exact,
                    locator: anchor.displayLocation,
                  },
                ],
          policy,
        };
      },
      isReady: () =>
        !loading &&
        !error &&
        !needsPassword &&
        (doc.format === "pdf" ? !!pdf.current : !!root()),
      getLocation: () =>
        doc.format === "pdf"
          ? { pageIndex: pdfCurrentPage.current }
          : doc.format === "epub"
            ? { ...currentLocator.current }
            : { scrollTop: host.current?.scrollTop || 0 },
      getHistory: () => [...navigationHistory.current],
      turnPage: (direction) => {
        if (doc.format === "pdf")
          goToPdfPage(pdfCurrentPage.current + direction);
        else turnPage(direction < 0 ? -1 : 1);
      },
      addPageNote: () => {
        pageNote();
      },
      sectionText: () => (root() ? textMap(root()!).text : ""),
      async captureSection() {
        const el = root();
        if (!el) throw Error("当前页没有可选文字");
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        return makeSelection(range, el);
      },
      async captureExcerpt(excerpt) {
        for (let i = 0; i < 40; i++) {
          const el = root();
          if (el) {
            const text = textMap(el).text;
            const span = findGuideExcerpt(text, excerpt);
            if (span) {
              const range = rangeAt(
                el,
                cpOffset(text, span.start),
                cpOffset(text, span.end),
              );
              if (range) return makeSelection(range, el, false);
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw Error("未能唯一定位讲解引用，请在原文中选择一段后提问或记笔记");
      },
      async pageImage() {
        if (doc.format !== "pdf" || !pdf.current)
          throw Error("请打开 PDF 页面后使用 OCR");
        const page = await pdf.current.getPage(pdfCurrentPage.current + 1);
        const natural = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(2, 2200 / Math.max(natural.width, natural.height)),
        });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport }).promise;
        try {
          return canvas.toDataURL("image/png");
        } finally {
          canvas.width = canvas.height = 0;
        }
      },
      async navigateLocation(locator) {
        if (Object.keys(currentLocator.current).length)
          navigationHistory.current = [
            ...navigationHistory.current.slice(-49),
            { ...currentLocator.current },
          ];
        if (doc.format === "pdf") {
          goToPdfPage(locator.pageIndex || 0);
        } else if (doc.format === "epub" && rendition.current) {
          await rendition.current.display(locator.cfi || locator.href);
        } else if (locator.heading !== undefined) {
          textRoot.current
            ?.querySelectorAll("h1,h2,h3,h4")
            [locator.heading]?.scrollIntoView({ block: "start" });
        } else if (host.current)
          host.current.scrollTop = locator.scrollTop || 0;
        if (locator.search) {
          for (let i = 0; i < 40; i++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            const el = root();
            if (!el) continue;
            const map = textMap(el).text;
            let at = -1;
            for (
              let occurrence = 0;
              occurrence <= (locator.occurrence || 0);
              occurrence++
            ) {
              at = map
                .toLocaleLowerCase()
                .indexOf(locator.search.toLocaleLowerCase(), at + 1);
              if (at < 0) break;
            }
            if (at < 0) continue;
            const range = rangeAt(
              el,
              cpOffset(map, at),
              cpOffset(map, at + locator.search.length),
            );
            range?.startContainer.parentElement?.scrollIntoView({
              block: "center",
            });
            if (range && (window as any).Highlight && (CSS as any).highlights)
              (CSS as any).highlights.set(
                "search",
                new (window as any).Highlight(range),
              );
            break;
          }
        }
      },
      async search(term) {
        if (!term) return 0;
        if (doc.format === "epub" && book.current) {
          const contents = rendition.current.getContents()[0];
          const t = textMap(contents.document.body).text;
          const at = t.indexOf(term);
          if (at < 0) return 0;
          const range = rangeAt(
            contents.document.body,
            cpOffset(t, at),
            cpOffset(t, at + term.length),
          );
          range?.startContainer.parentElement?.scrollIntoView({
            block: "center",
          });
          return t.split(term).length - 1;
        }
        const el = root();
        if (!el) return 0;
        const text = textMap(el).text;
        const at = text.indexOf(term);
        if (at >= 0) {
          const range = rangeAt(
            el,
            cpOffset(text, at),
            cpOffset(text, at + term.length),
          );
          range?.startContainer.parentElement?.scrollIntoView({
            block: "center",
          });
          const highlight = (window as any).Highlight;
          if (highlight && (CSS as any).highlights && range)
            (CSS as any).highlights.set("search", new highlight(range));
        }
        return text.split(term).length - 1;
      },
    }));
    useEffect(() => {
      const gen = ++generation.current;
      setLoading(true);
      navigationHistory.current = [];
      setWordCount(null);
      pendingTextCount.current = null;
      setPercentage(null);
      epubIndexReady.current = false;
      setError("");
      setMarks([]);
      epubHighlights.current.clear();
      setManifest(doc.resourceManifestId);
      setResources([]);
      captured.current = null;
      capturedRange.current = null;
      let disposed = false;
      let loadingTask: any;
      let ownedBook: any,
        ownedRendition: any,
        disposeEpub: (() => void) | undefined,
        ownedIndex: Promise<unknown> | undefined;
      let selectionPoll: ReturnType<typeof setInterval> | undefined;
      const abort = new AbortController();
      const statistics = (calculate: () => Promise<Count>) => {
        void bookWordCount(doc, p.encoding, abort.signal, calculate)
          .then((value) => {
            if (!disposed) setWordCount(value);
          })
          .catch(() => {
            if (!disposed) setWordCount("unavailable");
          });
      };
      const initialization = (async () => {
        try {
          if (doc.resourceManifestId) {
            const m = await api(
              "/manifests/" +
                doc.resourceManifestId +
                "?workspaceDocumentId=" +
                doc.workspaceDocumentId,
            );
            if (!disposed) setResources(m.resources || []);
          }
          if (doc.format === "pdf") {
            loadingTask = pdfjs.getDocument({
              ...(await pdfSource(
                doc.version.id,
                doc.workspaceDocumentId,
                abort.signal,
              )),
              cMapUrl: "/pdf-assets/cmaps/",
              standardFontDataUrl: "/pdf-assets/standard_fonts/",
              wasmUrl: "/pdf-assets/wasm/",
              enableXfa: false,
            });
            loadingTask.onPassword = (cb: any) => {
              passwordCallback.current = cb;
              setNeedsPassword(true);
            };
            pdf.current = await loadingTask.promise;
            if (disposed) return;
            setPages(pdf.current.numPages);
            const pdfDocument = pdf.current;
            statistics(() => pdfWordCount(pdfDocument, abort.signal));
            outline(
              Array.from({ length: pdf.current.numPages }, (_, i) => ({
                label: `第 ${i + 1} 页`,
                locator: { pageIndex: i },
              })),
            );
            setLoading(false);
          } else if (doc.format === "epub") {
            const raw = await readContent(
              doc.version.id,
              doc.workspaceDocumentId,
              abort.signal,
            );
            const opened = await openEpub(raw, sourceDoc.format);
            if (disposed) {
              opened.dispose();
              opened.book.destroy();
              return;
            }
            const b = opened.book;
            disposeEpub = opened.dispose;
            ownedBook = b;
            book.current = b;
            await b.opened;
            if (disposed) return;
            if (b.packaging?.metadata?.layout === "pre-paginated")
              throw Error(
                "固定版式 EPUB 不属于完整支持范围，请转换为可重排 EPUB",
              );
            const el = host.current!.querySelector(
              ".epub-container",
            ) as HTMLElement;
            const r = b.renderTo(el, {
              width: el.clientWidth,
              height: epubHeight(),
              flow: p.epubFlow as any,
              spread: p.epubSpread ? "auto" : "none",
              minSpreadWidth: 840,
              allowScriptedContent: false,
              allowPopups: false,
            });
            ownedRendition = r;
            // epub.js schedules location reporting in a later animation frame
            // but destroy() does not cancel it. Do not resolve a disposed book.
            const located = r.located.bind(r);
            r.located = (...args: any[]) =>
              disposed ? undefined : located(...args);
            rendition.current = r;
            await r.started;
            if (disposed) return;
            const format = r._layout.format.bind(r._layout);
            r._layout.format = (...args: any[]) =>
              disposed ? undefined : format(...args);
            r.hooks.content.register((c: any) => {
              // epub.js forwards keys through a passive listener, which cannot
              // cancel the browser's native arrow-key scrolling.
              c.document.addEventListener("keydown", handlePageKey);
              const meta = c.document.createElement("meta");
              meta.httpEquiv = "Content-Security-Policy";
              meta.content = epubCSP;
              c.document.head.prepend(meta);
              textRoot.current = c.document.body;
              if (latest.current.preferences.epubFlow !== "paginated")
                c.document.body.style.padding = "24px";
              fitEpubCover(c);
              c.document.addEventListener("click", (ev: MouseEvent) => {
                const a = (ev.target as Element).closest("a");
                if (
                  a &&
                  /^(https?:|javascript:|data:|file:)/i.test(
                    a.getAttribute("href") || "",
                  )
                ) {
                  ev.preventDefault();
                  latest.current.onError("书内外部链接已阻断");
                }
              });
            });
            let previousSpine: number | undefined;
            r.on("relocated", (loc: any) => {
              if (disposed) return;
              updateEpubPagination(loc);
              if (
                previousSpine !== undefined &&
                previousSpine !== loc.start.index &&
                host.current
              )
                host.current.scrollTop = 0;
              previousSpine = loc.start.index;
              currentLocator.current = {
                cfi: loc.start.cfi,
                href: loc.start.href,
                spineIndex: loc.start.index,
              };
              latest.current.onProgress(currentLocator.current);
              schedulePosition();
              void paint();
            });
            r.on("rendered", () => {
              if (disposed) return;
              const body = r.getContents()[0]?.document.body;
              if (body) textRoot.current = body;
              schedulePosition();
              void paint();
            });
            void b.loaded.navigation.then((nav: any) => {
              if (!disposed)
                outline(
                  nav.toc.flatMap(function flatten(x: any): OutlineItem[] {
                    return [
                      { label: x.label, locator: { href: x.href } },
                      ...(x.subitems || []).flatMap(flatten),
                    ];
                  }),
                );
            });
            r.themes.fontSize(p.fontSize + "px");
            r.themes.font(p.fontFamily);
            r.themes.override("line-height", String(p.lineHeight));
            r.themes.default({
              body: {
                color:
                  p.theme === "dark"
                    ? "#eeeeee !important"
                    : "#202020 !important",
                background:
                  p.theme === "dark"
                    ? "#000000 !important"
                    : "#ffffff !important",
              },
              "p, span, div, h1, h2, h3, h4, li": {
                color: "inherit !important",
              },
            });
            const savedCFI = doc.readingState?.locator?.cfi;
            await displayEpubAt(r, savedCFI || undefined);
            if (disposed) return;
            if (host.current && p.epubFlow !== "paginated")
              host.current.scrollTop =
                doc.readingState?.locator?.scrollTop || 0;
            // WebKit suppresses child event listeners in a script-disabled
            // iframe. Observe its same-origin Selection from the parent; never
            // weaken the EPUB sandbox. Publish only a stable, changed CFI.
            let candidate = "",
              published = "";
            selectionPoll = setInterval(() => {
              if (disposed) return;
              const c = r.getContents()[0];
              const selection = c?.document.defaultView?.getSelection();
              if (!selection?.rangeCount || selection.isCollapsed) {
                candidate = "";
                published = "";
                if (captured.current) setSelectionCleared();
                return;
              }
              const range = selection.getRangeAt(0);
              const cfi = c.cfiFromRange(range);
              if (cfi === published) {
                capturedRange.current = range.cloneRange();
                refreshSelectionPosition();
                return;
              }
              if (cfi !== candidate) {
                candidate = cfi;
                return;
              }
              published = cfi;
              publishSelection(range.cloneRange(), c.document.body);
            }, 150);
            if (savedCFI && p.epubFlow !== "paginated") {
              const c = r.getContents()[0];
              const range = c?.range(savedCFI);
              const frame = el.querySelector("iframe");
              const stage = r.manager.container;
              if (range && frame)
                stage.scrollTop +=
                  range.getBoundingClientRect().top +
                  frame.getBoundingClientRect().top -
                  stage.getBoundingClientRect().top;
            }
            setLoading(false);
            statistics(() => opened.wordCount(abort.signal));
            // Index logical text positions, independent of font size and viewport.
            // Keep opening the chapter responsive while the book is indexed.
            setIndexing(true);
            // epub.js Queue.generate swallows an individual chapter rejection,
            // leaving its outer promise pending forever. Index sequentially
            // with cancellation so a bad chapter cannot hang progress/cleanup.
            ownedIndex = opened
              .indexLocations(abort.signal)
              .then(() => {
                if (!disposed) {
                  epubIndexReady.current = true;
                  schedulePosition();
                }
              })
              .catch(() => {
                if (!disposed) setPercentage(null);
              })
              .finally(() => {
                if (!disposed) setIndexing(false);
              });
          } else {
            const data = await readContent(
              doc.version.id,
              doc.workspaceDocumentId,
              abort.signal,
            );
            const value = new TextDecoder(
              doc.format === "txt" ? p.encoding : "utf-8",
            ).decode(data);
            if (disposed) return;
            setText(value);
            setLoading(false);
            pendingTextCount.current = () =>
              statistics(async () => {
                abort.signal.throwIfAborted();
                const prose = host.current?.querySelector(".prose");
                if (doc.format === "markdown" && !prose)
                  throw Error("Text unavailable");
                return {
                  count: await countTextWords(
                    doc.format === "markdown" ? bodyText(prose!) : value,
                    abort.signal,
                  ),
                };
              });
            outline(
              value
                .split("\n")
                .filter((x) => /^#{1,6} /.test(x))
                .map((x, i) => ({
                  label: x.replace(/^#+ /, ""),
                  locator: { heading: i },
                })),
            );
          }
        } catch (e: any) {
          if (!disposed && e.name !== "AbortError") {
            setError(e.message);
            setWordCount("unavailable");
            setLoading(false);
          }
        }
      })();
      return () => {
        disposed = true;
        selectionRequest.current++;
        clearInterval(selectionPoll);
        abort.abort();
        if (gen === generation.current) textRoot.current = null;
        void loadingTask?.destroy();
        pdf.current = null;
        // Complete in-flight attachment before destroying its manager. Book
        // owns the rendition, so it must be destroyed exactly once.
        ownedBook?.locations?.q.clear();
        void initialization.then(async () => {
          const rendering = ownedRendition?.q.defered?.promise;
          ownedRendition?.q.clear();
          ownedBook?.locations?.q.clear();
          // Clear queued work, but let the active chapter finish before its
          // spine/hooks are destroyed (Firefox can still be resolving it).
          // Opening the first chapter does not wait for the navigation file.
          // epub.js still dereferences book.loading when that file resolves.
          await Promise.allSettled([
            rendering,
            ownedIndex,
            ownedBook?.loaded?.navigation,
          ]);
          ownedRendition?.q.stop();
          if (ownedRendition?.manager && !ownedRendition.manager.rendered)
            ownedRendition.manager = undefined;
          ownedBook?.locations?.q.stop();
          clearTimeout(ownedBook?.locations?.processingTimeout);
          ownedBook?.destroy();
          disposeEpub?.();
        });
        rendition.current = null;
        book.current = null;
      };
    }, [doc.version.id, doc.workspaceDocumentId, p.encoding]);
    useEffect(() => {
      if (doc.format === "epub" && rendition.current) {
        const r = rendition.current;
        r.themes.fontSize(p.fontSize + "px");
        r.themes.font(p.fontFamily);
        r.themes.override("line-height", String(p.lineHeight));
        r.themes.default({
          body: {
            color:
              p.theme === "dark" ? "#eeeeee !important" : "#202020 !important",
            background:
              p.theme === "dark" ? "#000000 !important" : "#ffffff !important",
          },
          "p, span, div, h1, h2, h3, h4, li": { color: "inherit !important" },
        });
        if (r.settings.flow !== p.epubFlow) r.flow(p.epubFlow);
        r.spread(p.epubSpread ? "auto" : "none", 840);
        const container =
          host.current?.querySelector<HTMLElement>(".epub-container");
        if (container?.clientWidth && host.current)
          r.resize(container.clientWidth, epubHeight());
        void paint();
      } else {
        void paint();
      }
    }, [
      p.fontSize,
      p.lineHeight,
      p.fontFamily,
      p.epubFlow,
      p.epubSpread,
      p.theme,
    ]);
    useEffect(() => {
      void paint();
    }, [props.annotations, paint, text]);
    useEffect(() => {
      if (!loading && pendingTextCount.current) {
        const calculate = pendingTextCount.current;
        pendingTextCount.current = null;
        calculate();
      }
    }, [text, loading, p.encoding]);
    useEffect(() => {
      if (doc.format === "txt" || doc.format === "markdown") {
        textRoot.current = host.current?.querySelector(".prose") as HTMLElement;
        const top = doc.readingState?.locator?.scrollTop;
        let restoring = true;
        const restore = () => {
          if (!restoring) return;
          if (top && host.current)
            host.current.scrollTo({ top, behavior: "instant" });
          if (doc.initialAnchor && textRoot.current) {
            const sel = doc.initialAnchor.selectors.find(
              (x) => x.type === "text",
            );
            if (sel?.type === "text") {
              const range = rangeAt(textRoot.current, sel.start, sel.end);
              range?.startContainer.parentElement?.scrollIntoView({
                block: "center",
                behavior: "instant",
              });
            }
          }
        };
        // Images and math fonts can increase the document height after the
        // first paint. Restore again as they settle, until the user interacts.
        const observer = new ResizeObserver(() => {
          restore();
          // scrollTop may be unchanged while the total height increases.
          schedulePosition();
        });
        const stop = () => {
          restoring = false;
          for (const event of ["pointerdown", "keydown", "wheel", "touchstart"])
            document.removeEventListener(event, stop, true);
        };
        restore();
        if (textRoot.current) observer.observe(textRoot.current);
        void document.fonts.ready.then(restore);
        for (const event of ["pointerdown", "keydown", "wheel", "touchstart"])
          document.addEventListener(event, stop, {
            capture: true,
            passive: true,
          });
        void paint();
        if (textRoot.current && !doc.historical)
          artifact(textRoot.current, "body", { label: doc.title })
            .then((a) =>
              api(
                "/documents/" + doc.workspaceDocumentId + "/resolve",
                "POST",
                { artifactId: a.id },
              ),
            )
            .then(() => latest.current.onResolved?.())
            .catch((e) => latest.current.onError(e.message));
        return () => {
          stop();
          observer.disconnect();
        };
      }
    }, [text, doc.version.id]);
    useEffect(() => {
      if (!loading && !error && !needsPassword) latest.current.onReady?.();
    }, [
      loading,
      error,
      needsPassword,
      doc.workspaceDocumentId,
      doc.version.id,
    ]);

    useEffect(() => {
      if (!host.current) return;
      const observer = new ResizeObserver(() => {
        void paint();
        refreshSelectionPosition();
        schedulePosition();
        // epub.js listens to window resize, but side panels only resize the
        // reader. Reflow before the next interaction can capture a selection.
        if (doc.format === "epub") {
          const container =
            host.current?.querySelector<HTMLElement>(".epub-container");
          const r = rendition.current;
          if (!container?.clientWidth || !host.current || !r?.manager?.rendered)
            return;
          r.resize(container.clientWidth, epubHeight());
          r.getContents().forEach(fitEpubCover);
        }
      });
      observer.observe(host.current);
      return () => {
        observer.disconnect();
      };
    }, [paint, doc.format]);
    const select = () => {
      if (doc.format === "epub") return;
      publishSelection();
    };
    const pageNote = async () => {
      const el = root() || host.current!;
      const loc = doc.format === "epub" ? rendition.current?.currentLocation()?.start : null;
      if (doc.format === "epub" && !loc?.cfi) return;
      const block = doc.format === "pdf" ? `page-${page}` : doc.format === "epub" ? `spine-${loc.index}` : "body";
      const location = loc ? { href: loc.href, label: `第 ${loc.index + 1} 节`, cfi: loc.cfi } : { pageIndex: page, label: `第 ${page + 1} 页` };
      const a = await artifact(el, block, location);
      const anchor: Anchor = {
        schemaVersion: 1,
        workspaceDocumentId: doc.workspaceDocumentId,
        documentVersionId: doc.version.id,
        extractionArtifactId: a.id,
        resourceManifestId: manifest,
        targetKind: "page",
        quote: { exact: "", visible: "", prefix: "", suffix: "" },
        selectors: loc ? [{ type: "epub", cfi: loc.cfi, href: loc.href }] : [],
        displayLocation: location,
        normalizationVersion: NORMALIZATION,
        parserVersion: parserVersion,
      };
      props.onSelect({
        anchor,
        artifact: a,
        context: {
          blockId: block,
          quote: anchor.quote,
          text: "",
          locator: anchor.displayLocation,
        },
        rect: { left: 24, top: 80 },
      });
    };
    const resource = async (path: string) => {
      if (doc.historical) throw Error("历史资源未捕获");
      const m = await api("/manifests/" + manifest + "/capture", "POST", {
        workspaceDocumentId: doc.workspaceDocumentId,
        path,
      });
      setManifest(m.id);
      setResources(m.resources);
      return m.id;
    };
    const pdfControls =
      doc.format === "pdf" ? (
        <div className="page-tools" data-no-text>
          <button
            disabled={page === 0}
            onClick={() => goToPdfPage(page - (pdfPages.current?.step() || 1))}
          >
            {tr("上一页")}
          </button>
          <span>
            {tr("第")}{" "}
            <input
              aria-label={tr("PDF 页码")}
              type="number"
              disabled={loading}
              min={1}
              max={pages}
              value={page + 1}
              onChange={(e) =>
                goToPdfPage(
                  Math.max(0, Math.min(pages - 1, Number(e.target.value) - 1)),
                )
              }
            />{" "}
            / {pages}
            {tr("页")}
          </span>
          <button
            disabled={page >= pages - 1}
            onClick={() => goToPdfPage(page + (pdfPages.current?.step() || 1))}
          >
            {tr("下一页")}
          </button>
          <button onClick={pageNote}>{tr("页级笔记")}</button>
          <small>{tr("单页选区；跨页请分段批注")}</small>
          {!pageText && !loading && (
            <span className="scan-notice">
              {tr(
                "此页没有可选文字。可添加页级笔记，小阅仅能讨论你输入的文字。",
              )}
            </span>
          )}
        </div>
      ) : null;
    const progress =
      !error && !needsPassword ? (
        <ReadingProgress
          value={percentage}
          disabled={
            loading || (doc.format === "epub" && !epubIndexReady.current)
          }
          pendingLabel={
            percentage == null
              ? doc.format === "epub" && !indexing
                ? tr("进度暂不可用")
                : tr("计算中…")
              : ""
          }
          onSeek={seekProgress}
        />
      ) : null;
    const sessionTimer = (
      <SessionTimer
        host={host}
        member={doc.workspaceDocumentId}
        enabled={
          !loading &&
          !error &&
          !needsPassword &&
          props.activityEnabled !== false
        }
        record={props.onReading}
        show={!!props.timerContainer}
      />
    );
    const pageNumber =
      !loading &&
      !error &&
      !needsPassword &&
      (doc.format === "epub" && epubPagination ? (
        <output
          className="reader-page-number reader-page-number-epub"
          aria-label={tr("阅读页码")}
          aria-live="off"
          title={tr("EPUB 页码按当前窗口和字号计算，以本章为范围。")}
        >
          {tr("本章")} {epubPagination.first}
          {epubPagination.last > epubPagination.first
            ? `–${epubPagination.last}`
            : ""}
          {` / ${epubPagination.total} `}
          {tr("页")}
        </output>
      ) : doc.format === "pdf" && pages > 0 ? (
        <output
          className="reader-page-number reader-page-number-pdf"
          aria-label={tr("阅读页码")}
          aria-live="off"
        >
          {page + 1} / {pages} {tr("页")}
        </output>
      ) : null);
    return (
      <div
        className={
          "reader reader-" +
          doc.format +
          (doc.format === "epub" && p.epubFlow === "paginated"
            ? " reader-paginated"
            : "") +
          (props.progressContainer !== undefined
            ? " reader-header-progress"
            : "")
        }
        ref={host}
        onMouseUp={select}
        onKeyUp={(e) => {
          if (e.shiftKey) select();
        }}
        onScrollCapture={() => {
          refreshSelectionPosition();
          schedulePosition();
        }}
        style={{
          fontSize: p.fontSize,
          lineHeight: p.lineHeight,
          fontFamily: p.fontFamily,
        }}
      >
        {loading && (
          <div className="reader-status">{tr("正在打开不可变快照…")}</div>
        )}
        {error && <div className="empty error">{tr(error)}</div>}
        {props.wordCountContainer ? (
          createPortal(
            <BookWordCount
              value={wordCount}
              pdf={doc.format === "pdf"}
              speed={p.readingSpeed}
            />,
            props.wordCountContainer,
          )
        ) : props.wordCountContainer === undefined ? (
          <BookWordCount
            value={wordCount}
            pdf={doc.format === "pdf"}
            speed={p.readingSpeed}
          />
        ) : null}
        {props.pageNumberContainer &&
          createPortal(pageNumber, props.pageNumberContainer)}
        {props.timerContainer
          ? createPortal(sessionTimer, props.timerContainer)
          : sessionTimer}
        {props.progressContainer
          ? createPortal(progress, props.progressContainer)
          : props.progressContainer === undefined
            ? progress
            : null}
        {needsPassword && (
          <form
            className="password-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              passwordCallback.current?.(password);
              setPassword("");
              setNeedsPassword(false);
            }}
          >
            <label>
              {tr("此 PDF 需要密码")}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
            </label>
            <button>{tr("本次打开")}</button>
          </form>
        )}
        {doc.format === "pdf" && (
          <>
            {props.pdfControlsContainer
              ? createPortal(pdfControls, props.pdfControlsContainer)
              : props.pdfControlsContainer === undefined
                ? pdfControls
                : null}
            {!loading && pdf.current && (
              <PdfPages
                ref={pdfPages}
                document={pdf.current}
                host={host}
                scale={p.pdfScale}
                rotation={p.pdfRotation}
                spread={p.pdfSpread}
                initialPage={page}
                initialOffset={
                  doc.initialAnchor
                    ? 0
                    : doc.readingState?.locator?.pageOffset || 0
                }
                onPosition={(index, offset) => {
                  pdfCurrentPage.current = index;
                  setPage(index);
                  setPageText(pdfPages.current?.get(index)?.hasText ?? true);
                  publishPosition(
                    { pageIndex: index, pageOffset: offset },
                    (index + 1) / pages,
                  );
                }}
                onReady={() => {
                  refreshSelectionPosition();
                  setPageText(
                    pdfPages.current?.get(pdfCurrentPage.current)?.hasText ??
                      true,
                  );
                  void paint();
                  if (doc.initialAnchor && !initialPdfNavigation.current) {
                    const selector = doc.initialAnchor.selectors.find(
                      (s) => s.type === "pdf",
                    );
                    const index =
                      selector?.type === "pdf"
                        ? selector.pageIndex
                        : doc.initialAnchor.displayLocation.pageIndex || 0;
                    if (pdfPages.current?.get(index)) {
                      initialPdfNavigation.current = true;
                      scrollPdfTo(doc.initialAnchor);
                    }
                  }
                }}
                onError={setError}
              />
            )}
          </>
        )}
        {doc.format === "epub" && (
          <>
            <div className="page-tools" data-no-text>
              <button disabled={loading} onClick={() => turnPage(-1)}>
                {tr(p.epubFlow === "paginated" ? "上一页" : "上一节")}
              </button>
              <button disabled={loading} onClick={() => turnPage(1)}>
                {tr(p.epubFlow === "paginated" ? "下一页" : "下一节")}
              </button>
              <small>{tr("单章选区 · EPUB CFI 定位")}</small>
            </div>
            <div
              className="epub-container"
              style={{ minHeight: p.epubFlow === "paginated" ? 0 : 500 }}
            />
          </>
        )}
        {doc.format === "markdown" && (
          <article className="prose">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[[rehypeKatex, { trust: false }]]}
              skipHtml
              components={{
                a: ({ children, href }) => (
                  <a
                    href={/^https?:\/\//.test(href || "") ? href : undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {children}
                  </a>
                ),
                img: ({ src, alt }) => (
                  <LocalImage
                    path={typeof src === "string" ? src : ""}
                    alt={alt || ""}
                    resources={resources}
                    manifest={manifest}
                    member={doc.workspaceDocumentId}
                    capture={resource}
                  />
                ),
              }}
            >
              {text}
            </ReactMarkdown>
          </article>
        )}
        {doc.format === "txt" && (
          <article className="prose plain-text">{text}</article>
        )}
        <div className="annotation-overlay" data-no-text>
          {marks.map((m, i) => (
            <button
              key={i}
              className={"annotation-mark " + (m.underline ? "underline" : "")}
              aria-label={tr("打开原文批注")}
              style={{
                left: m.left,
                top: m.top,
                width: m.width,
                height: m.height,
                background: m.underline ? "transparent" : m.color || "#e8cb76",
                borderBottomColor: m.color || "#c5a64a",
              }}
              onClick={(e) => {
                e.stopPropagation();
                const overlapping = marks.filter(
                  (x) =>
                    m.left < x.left + x.width &&
                    m.left + m.width > x.left &&
                    m.top < x.top + x.height &&
                    m.top + m.height > x.top,
                );
                props.onPickThread([
                  ...new Set(overlapping.map((x) => x.threadId)),
                ]);
              }}
            />
          ))}
        </div>
      </div>
    );
  },
);
function LocalImage({
  path,
  alt,
  resources,
  manifest,
  member,
  capture,
}: {
  path: string;
  alt: string;
  resources: any[];
  manifest?: string;
  member: string;
  capture: (p: string) => Promise<string>;
}) {
  const [state, setState] = useState("");
  const [src, setSrc] = useState("");
  useEffect(() => {
    let alive = true,
      owned = "";
    setSrc("");
    if (manifest && resources.some((x) => x.path === path))
      void imageSource(manifest, member, path)
        .then((v) => {
          owned = v;
          if (alive) setSrc(v);
          else if (v.startsWith("blob:")) URL.revokeObjectURL(v);
        })
        .catch(() => {
          if (alive) setState("图片尚未下载");
        });
    return () => {
      alive = false;
      if (owned.startsWith("blob:")) URL.revokeObjectURL(owned);
    };
  }, [manifest, member, path, resources]);
  useEffect(() => {
    let gone = false;
    const external = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path);
    if (external) {
      setState("远程图片已阻断");
      return;
    }
    if (resources.some((x) => x.path === path)) return;
    capture(path).catch(() => {
      if (!gone) setState("资源未捕获或越出授权范围");
    });
    return () => {
      gone = true;
    };
  }, [path, manifest]);
  if (state)
    return (
      <span className="image-placeholder">
        {alt} · {tr(state)}
      </span>
    );
  if (!resources.some((x) => x.path === path))
    return <span className="image-placeholder">{tr("正在捕获本机图片…")}</span>;
  return <img alt={alt} src={src || undefined} />;
}
