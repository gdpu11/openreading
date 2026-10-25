import { useEffect, useRef, type ReactNode } from "react";

export function HoverDetails({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  const hovering = useRef(false);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node))
        root.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  return (
    <details
      ref={root}
      className={className}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") {
          hovering.current = true;
          event.currentTarget.open = true;
        }
      }}
      onPointerLeave={(event) => {
        hovering.current = false;
        if (event.pointerType !== "touch") event.currentTarget.open = false;
      }}
      onPointerDownCapture={(event) => {
        hovering.current = event.pointerType !== "touch";
      }}
      onClickCapture={(event) => {
        const summary = event.currentTarget.querySelector("summary");
        if (
          hovering.current &&
          event.detail > 0 &&
          summary?.contains(event.target as Node)
        ) {
          event.preventDefault();
          event.currentTarget.open = true;
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          event.currentTarget.open = false;
      }}
      onKeyDown={(event) => {
        const details = event.currentTarget;
        const summary = details.querySelector("summary");
        if (event.key === "Escape" && details.open) {
          event.preventDefault();
          event.stopPropagation();
          details.open = false;
          summary?.focus();
        }
        const items = Array.from(
          details.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
        );
        if (!items.length) return;
        const atSummary = summary?.contains(event.target as Node);
        if (
          (atSummary && ["ArrowDown", "ArrowUp"].includes(event.key)) ||
          (!atSummary &&
            ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
        ) {
          event.preventDefault();
          details.open = true;
          const current = items.indexOf(event.target as HTMLButtonElement);
          const index =
            event.key === "Home" || (atSummary && event.key === "ArrowDown")
              ? 0
              : event.key === "End" || (atSummary && event.key === "ArrowUp")
                ? items.length - 1
                : (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    items.length) %
                  items.length;
          items[index].focus();
        }
      }}
    >
      {children}
    </details>
  );
}
