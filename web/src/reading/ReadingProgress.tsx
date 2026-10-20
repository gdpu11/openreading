import { useRef, useState, type CSSProperties } from "react";
import { tr } from "../i18n";

export function ReadingProgress({
  value,
  disabled,
  pendingLabel,
  onSeek,
}: {
  value: number | null;
  disabled: boolean;
  pendingLabel: string;
  onSeek: (percentage: number) => Promise<void>;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const dragging = useRef(false),
    committing = useRef(false);
  const shown = preview ?? value;
  const pointerValue = (input: HTMLInputElement, clientX: number) => {
    const bounds = input.getBoundingClientRect();
    // Match the 9px thumb so the pointer reaches both ends of the track.
    let fraction = Math.max(
      0,
      Math.min(
        1,
        (clientX - bounds.left - 4.5) / Math.max(1, bounds.width - 9),
      ),
    );
    if (getComputedStyle(input).direction === "rtl") fraction = 1 - fraction;
    return Math.round(fraction * 1000) / 10;
  };
  const commit = async (percentage: number) => {
    if (committing.current || disabled || value == null) return;
    committing.current = true;
    setBusy(true);
    try {
      await onSeek(percentage);
    } finally {
      committing.current = false;
      setBusy(false);
      setPreview(null);
    }
  };
  return (
    <div className="reader-progress" data-no-text>
      <span>{tr("阅读进度")}</span>
      <input
        type="range"
        min="0"
        max="100"
        step="0.1"
        aria-label={tr("整本阅读进度")}
        aria-valuetext={shown == null ? pendingLabel : `${shown}%`}
        aria-busy={busy}
        title={tr("拖动或点击跳转阅读位置")}
        value={shown ?? 0}
        disabled={disabled || value == null}
        style={{ "--reader-progress": `${shown ?? 0}%` } as CSSProperties}
        onPointerDown={(event) => {
          if (committing.current) {
            event.preventDefault();
            return;
          }
          if (event.button !== 0) return;
          event.preventDefault();
          dragging.current = true;
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          setPreview(pointerValue(event.currentTarget, event.clientX));
        }}
        onPointerMove={(event) => {
          if (dragging.current)
            setPreview(pointerValue(event.currentTarget, event.clientX));
        }}
        onChange={(event) => {
          if (committing.current) {
            event.currentTarget.value = String(shown ?? 0);
            return;
          }
          const next = Number(event.currentTarget.value);
          setPreview(next);
          // Native keyboard and accessibility actions commit immediately.
          if (!dragging.current) void commit(next);
        }}
        onKeyDown={(event) => {
          // Keep focus on the slider while navigating instead of disabling a
          // focused input, which would send subsequent arrow keys to the book.
          if (
            committing.current &&
            [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
              "PageUp",
              "PageDown",
            ].includes(event.key)
          )
            event.preventDefault();
        }}
        onPointerUp={(event) => {
          if (!dragging.current) return;
          dragging.current = false;
          void commit(pointerValue(event.currentTarget, event.clientX));
        }}
        onPointerCancel={() => {
          dragging.current = false;
          setPreview(null);
        }}
        onBlur={() => {
          if (dragging.current) {
            dragging.current = false;
            setPreview(null);
          }
        }}
      />
      <output aria-label={tr("阅读进度百分比")}>
        {shown == null ? pendingLabel : `${shown}%`}
      </output>
    </div>
  );
}
