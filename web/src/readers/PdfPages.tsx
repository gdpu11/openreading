import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import * as pdfjs from "pdfjs-dist";
import { tr } from "../i18n";
import type { ZoomPoint } from "./pdfZoom";

type Size = { width: number; height: number; rotation: number };
export type PdfView = {
  index: number;
  element: HTMLDivElement;
  textLayer: HTMLDivElement;
  viewport: any;
  hasText: boolean;
};
export type PdfPagesHandle = {
  get: (index: number) => PdfView | undefined;
  goTo: (index: number, offset?: number) => void;
  step: () => number;
  anchorZoom: (point: ZoomPoint) => void;
};
type Props = {
  document: any;
  host: RefObject<HTMLDivElement | null>;
  scale: number;
  rotation: number;
  spread?: boolean;
  initialPage: number;
  initialOffset: number;
  onPosition: (index: number, offset: number) => void;
  onReady: () => void;
  onError: (message: string) => void;
};
const sizeOf = (page: any): Size => ({
  width: (page.view[2] - page.view[0]) * page.userUnit,
  height: (page.view[3] - page.view[1]) * page.userUnit,
  rotation: page.rotate,
});

export const PdfPages = forwardRef<PdfPagesHandle, Props>(
  function PdfPages(props, ref) {
    const { document: doc, host, scale, rotation } = props;
    const container = useRef<HTMLDivElement>(null);
    const views = useRef(new Map<number, PdfView>());
    const latest = useRef(props);
    latest.current = props;
    const [sizes, setSizes] = useState<Map<number, Size>>(new Map());
    const [viewport, setViewport] = useState({ width: 0, height: 0 });
    const layoutViewport = useRef(viewport);
    layoutViewport.current = viewport;
    const columns = props.spread && viewport.width >= 840 ? 2 : 1;
    const [range, setRange] = useState({ start: 0, end: -1 });
    const position = useRef({
      index: Math.max(0, Math.min(doc.numPages - 1, props.initialPage)),
      offset: props.initialOffset || 0,
    });
    const zoomAnchor = useRef<{
      index: number;
      x: number;
      y: number;
      screenX: number;
      screenY: number;
    } | null>(null);
    const previousScale = useRef(scale);
    const layout = useMemo(() => {
      const first = sizes.get(0);
      if (!first) return [];
      let top = 0;
      const pages: {
        top: number;
        row: number;
        left?: number;
        width: number;
        height: number;
        scale: number;
        bottom: number;
      }[] = [];
      for (let index = 0; index < doc.numPages; index += columns) {
        const row = Array.from(
          { length: Math.min(columns, doc.numPages - index) },
          (_, i) => {
            const size = sizes.get(index + i) || first;
            const sideways = (size.rotation + rotation) % 180 !== 0;
            return {
              width: sideways ? size.height : size.width,
              height: sideways ? size.width : size.height,
            };
          },
        );
        const gap = 24;
        const width = row.reduce((sum, page) => sum + page.width, 0);
        const height = Math.max(...row.map((page) => page.height));
        const fitted =
          props.spread && viewport.width
            ? Math.min(
                (viewport.width - gap * (columns - 1)) /
                  (columns === 2 && row.length === 1 ? width * 2 : width),
                Math.max(160, viewport.height - 32) / height,
              )
            : 1;
        const factor = fitted * scale;
        const rowWidth = width * factor + gap * (row.length - 1);
        const rowHeight = height * factor;
        const pitch = props.spread
          ? Math.max(rowHeight, viewport.height - 24)
          : rowHeight;
        let left = Math.max(0, (viewport.width - rowWidth) / 2);
        row.forEach((page) => {
          pages.push({
            top,
            row: index,
            left: props.spread ? left : undefined,
            width: page.width * factor,
            height: page.height * factor,
            scale: factor,
            bottom: top + pitch,
          });
          left += page.width * factor + gap;
        });
        top += pitch + gap;
      }
      return pages;
    }, [sizes, doc, scale, rotation, props.spread, columns, viewport]);
    const total = layout.length ? layout.at(-1)!.bottom : 0;
    const currentLayout = useRef(layout);
    currentLayout.current = layout;
    const pageAt = (y: number) => {
      const pages = currentLayout.current;
      let lo = 0,
        hi = pages.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        // Firefox quantizes scrollTop and client rects differently at row boundaries.
        if (pages[mid].top <= y + 1) lo = mid;
        else hi = mid - 1;
      }
      return pages[lo]?.row ?? 0;
    };
    const geometry = () => {
      const root = host.current!,
        stack = container.current!;
      const box = root.getBoundingClientRect();
      const tools = root.querySelector<HTMLElement>(".page-tools");
      return {
        root,
        start: stack.getBoundingClientRect().top - box.top + root.scrollTop,
        inset: tools
          ? (parseFloat(getComputedStyle(tools).top) || 0) +
            tools.offsetHeight +
            8
          : 8,
      };
    };
    const update = () => {
      if (!currentLayout.current.length || !host.current || !container.current)
        return;
      const { root, start, inset } = geometry();
      // A resize can dispatch scroll before ResizeObserver commits the new
      // layout. Keep the reading position until that layout restores it.
      const style = getComputedStyle(root);
      const width =
        root.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      if (
        width !== layoutViewport.current.width ||
        root.clientHeight !== layoutViewport.current.height
      )
        return;
      const y = root.scrollTop - start;
      const overscan = root.clientHeight * 0.6;
      const begin = pageAt(Math.max(0, y - overscan));
      const end = Math.min(
        doc.numPages - 1,
        pageAt(y + root.clientHeight + overscan) + columns - 1,
      );
      setRange((old) =>
        old.start === begin && old.end === end ? old : { start: begin, end },
      );
      let index =
        root.scrollTop >= root.scrollHeight - root.clientHeight - 2
          ? doc.numPages - 1
          : pageAt(y + inset);
      const previous = position.current.index;
      if (columns === 2 && currentLayout.current[previous]?.row === index)
        index = previous;
      const row = currentLayout.current[index];
      const offset = Math.max(
        0,
        Math.min(1, (y + inset - row.top) / row.height),
      );
      position.current = { index, offset };
      latest.current.onPosition(index, offset);
    };
    const goTo = (index: number, offset = 0) => {
      const pages = currentLayout.current;
      index = Math.floor(Math.max(0, Math.min(doc.numPages - 1, index)));
      position.current = { index, offset };
      if (!pages.length || !host.current || !container.current) return;
      const { root, start, inset } = geometry();
      root.scrollTo({
        top: Math.ceil(
          Math.max(
            0,
            start + pages[index].top + offset * pages[index].height - inset,
          ),
        ),
        behavior: "instant",
      });
      update();
    };
    const pageLeft = (index: number) => {
      const page = currentLayout.current[index];
      return (
        page.left ??
        Math.max(0, (container.current!.clientWidth - page.width) / 2)
      );
    };
    const anchorZoom = (point: ZoomPoint) => {
      if (!currentLayout.current.length || !host.current || !container.current)
        return;
      const { root, start } = geometry();
      const box = root.getBoundingClientRect();
      const stack = container.current.getBoundingClientRect();
      const y = root.scrollTop - start + point.clientY - box.top;
      let index = pageAt(y);
      if (columns === 2 && index + 1 < doc.numPages) {
        const right = stack.left + pageLeft(index + 1);
        if (point.clientX >= right - 12) index++;
      }
      const page = currentLayout.current[index];
      zoomAnchor.current = {
        index,
        x: Math.max(
          0,
          Math.min(
            1,
            (point.clientX - stack.left - pageLeft(index)) / page.width,
          ),
        ),
        y: Math.max(0, Math.min(1, (y - page.top) / page.height)),
        screenX: point.clientX - box.left,
        screenY: point.clientY - box.top,
      };
    };
    useImperativeHandle(ref, () => ({
      get: (index) => views.current.get(index),
      goTo,
      step: () => columns,
      anchorZoom,
    }));
    useEffect(() => {
      let dead = false;
      void doc
        .getPage(1)
        .then((page: any) => {
          if (!dead) setSizes(new Map([[0, sizeOf(page)]]));
        })
        .catch((e: Error) => {
          if (!dead) latest.current.onError(e.message);
        });
      return () => {
        dead = true;
      };
    }, [doc]);
    useLayoutEffect(() => {
      if (!layout.length) return;
      const anchor = zoomAnchor.current;
      if (anchor && previousScale.current !== scale) {
        const { root, start } = geometry();
        const page = layout[anchor.index];
        const stackLeft =
          container.current!.getBoundingClientRect().left -
          root.getBoundingClientRect().left +
          root.scrollLeft;
        root.scrollTo({
          left: Math.max(
            0,
            stackLeft +
              pageLeft(anchor.index) +
              anchor.x * page.width -
              anchor.screenX,
          ),
          top: Math.max(
            0,
            start + page.top + anchor.y * page.height - anchor.screenY,
          ),
          behavior: "instant",
        });
        zoomAnchor.current = null;
        update();
      } else goTo(position.current.index, position.current.offset);
      previousScale.current = scale;
    }, [layout]);
    useEffect(() => {
      const root = host.current;
      if (!root) return;
      let frame = 0;
      const schedule = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(update);
      };
      const observer = new ResizeObserver(() => {
        const style = getComputedStyle(root);
        const width =
          root.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight);
        const height = root.clientHeight;
        setViewport((old) =>
          old.width === width && old.height === height
            ? old
            : { width, height },
        );
        schedule();
      });
      observer.observe(root);
      root.addEventListener("scroll", schedule, { passive: true });
      return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        root.removeEventListener("scroll", schedule);
      };
    }, [doc, columns]);
    const ready = (view: PdfView, size: Size) => {
      views.current.set(view.index, view);
      setSizes((old) => {
        const previous = old.get(view.index) || old.get(0);
        if (
          previous &&
          previous.width === size.width &&
          previous.height === size.height &&
          previous.rotation === size.rotation
        )
          return old;
        return new Map(old).set(view.index, size);
      });
      latest.current.onReady();
    };
    return (
      <div
        className="pdf-pages"
        ref={container}
        style={{
          height: total,
          minWidth: layout.length
            ? layout.reduce(
                (width, page) => Math.max(width, (page.left || 0) + page.width),
                viewport.width,
              )
            : undefined,
        }}
      >
        {layout.slice(range.start, range.end + 1).map((row, i) => {
          const index = range.start + i;
          return (
            <PdfPage
              key={`${index}:${row.scale}:${rotation}`}
              document={doc}
              index={index}
              scale={row.scale}
              rotation={rotation}
              top={row.top}
              left={row.left}
              width={row.width}
              height={row.height}
              onReady={ready}
              onRemove={(view) => {
                if (views.current.get(index) === view) {
                  views.current.delete(index);
                  latest.current.onReady();
                }
              }}
              onError={(message) => latest.current.onError(message)}
            />
          );
        })}
      </div>
    );
  },
);

function PdfPage({
  document: doc,
  index,
  scale,
  rotation,
  top,
  left,
  width,
  height,
  onReady,
  onRemove,
  onError,
}: {
  document: any;
  index: number;
  scale: number;
  rotation: number;
  top: number;
  left?: number;
  width: number;
  height: number;
  onReady: (view: PdfView, size: Size) => void;
  onRemove: (view: PdfView) => void;
  onError: (message: string) => void;
}) {
  const element = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onRemove, onError });
  callbacks.current = { onReady, onRemove, onError };
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let dead = false,
      page: any,
      task: any,
      layer: any,
      view: PdfView | undefined;
    const paint = (async () => {
      try {
        page = await doc.getPage(index + 1);
        if (dead) return;
        const viewport = page.getViewport({
          scale,
          rotation: (page.rotate + rotation) % 360,
        });
        const el = element.current!,
          bitmap = canvas.current!,
          textLayer = text.current!;
        el.style.width = viewport.width + "px";
        el.style.height = viewport.height + "px";
        // Bound retina backing stores while leaving selectable text at full precision.
        const ratio = Math.min(
          window.devicePixelRatio || 1,
          Math.sqrt(8_000_000 / (viewport.width * viewport.height)),
        );
        bitmap.width = Math.floor(viewport.width * ratio);
        bitmap.height = Math.floor(viewport.height * ratio);
        bitmap.style.width = viewport.width + "px";
        bitmap.style.height = viewport.height + "px";
        for (const node of [el, textLayer]) {
          node.style.setProperty("--scale-factor", String(viewport.scale));
          node.style.setProperty("--user-unit", String(viewport.userUnit));
          node.style.setProperty(
            "--total-scale-factor",
            String(viewport.scale * viewport.userUnit),
          );
        }
        task = page.render({
          canvasContext: bitmap.getContext("2d"),
          canvas: bitmap,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        let renderingError: any;
        const rendered = task.promise.catch((e: any) => {
          renderingError = e;
        });
        const content = await page.getTextContent();
        if (dead) return;
        layer = new pdfjs.TextLayer({
          textContentSource: content,
          container: textLayer,
          viewport,
        });
        await Promise.all([rendered, layer.render()]);
        if (dead) return;
        if (renderingError) throw renderingError;
        view = {
          index,
          element: el,
          textLayer,
          viewport,
          hasText: content.items.some((item: any) => item.str?.trim()),
        };
        setLoaded(true);
        callbacks.current.onReady(view, sizeOf(page));
      } catch (e: any) {
        if (
          !dead &&
          e.name !== "RenderingCancelledException" &&
          e.name !== "AbortException"
        )
          callbacks.current.onError(e.message);
      }
    })();
    const bitmap = canvas.current;
    return () => {
      dead = true;
      task?.cancel();
      layer?.cancel();
      if (view) callbacks.current.onRemove(view);
      if (bitmap) {
        bitmap.width = 0;
        bitmap.height = 0;
      }
      void paint.finally(() => page?.cleanup());
    };
  }, [doc, index, scale, rotation]);
  return (
    <div
      className="pdf-slot"
      style={{
        top,
        height,
        width,
        ...(left !== undefined ? { left, right: "auto", margin: 0 } : {}),
      }}
    >
      <div
        className="pdf-page"
        data-page-index={index}
        ref={element}
        style={{ width, height }}
        aria-label={tr(`第 ${index + 1} 页`)}
      >
        <canvas ref={canvas} />
        <div className="textLayer" ref={text} />
        {!loaded && (
          <span className="pdf-page-loading">{tr("正在加载页面…")}</span>
        )}
      </div>
    </div>
  );
}
