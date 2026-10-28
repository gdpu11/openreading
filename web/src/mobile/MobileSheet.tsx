import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { tr } from "../i18n";

// Keep a sheet inside the mobile root so it inherits the current book's theme.
export function MobileSheet({
  title,
  closeLabel = "关闭",
  onClose,
  children,
  className = "",
}: {
  title: string;
  closeLabel?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const panel = useRef<HTMLElement>(null),
    startY = useRef<number | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first =
      panel.current?.querySelector<HTMLElement>(
        "textarea,input:not([type=range]):not([type=checkbox])",
      ) || panel.current?.querySelector<HTMLElement>("button");
    first?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <>
      <button
        className="mobile-sheet-scrim"
        aria-label={tr("收起") + tr(title)}
        onClick={onClose}
        tabIndex={-1}
      />
      <section
        ref={panel}
        className={"mobile-sheet " + className}
        role="dialog"
        aria-modal="true"
        aria-label={tr(title)}
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          const targets = Array.from(
            panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),textarea,select,[tabindex="0"]',
            ) || [],
          );
          const first = targets[0],
            last = targets.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }}
      >
        <header
          className="mobile-sheet-heading"
          onPointerDown={(e) => {
            if (!(e.target as Element).closest("button")) {
              startY.current = e.clientY;
              e.currentTarget.setPointerCapture(e.pointerId);
            }
          }}
          onPointerUp={(e) => {
            if (startY.current != null && e.clientY - startY.current > 70)
              onClose();
            startY.current = null;
          }}
          onPointerCancel={() => {
            startY.current = null;
          }}
        >
          <span className="mobile-sheet-handle" aria-hidden="true" />
          <h3>{tr(title)}</h3>
          <button aria-label={tr(closeLabel)} onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </>
  );
}
