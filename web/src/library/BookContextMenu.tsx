import { isEpubFormat } from "../formats";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Star,
  BookCheck,
  BookOpen,
  Trash2,
  Undo2,
  ArrowLeftRight,
  Smartphone,
  FolderSync,
} from "lucide-react";
import { tr } from "../i18n";
export type BookAction =
  | "favorite"
  | "finished"
  | "delete"
  | "restore"
  | "convert"
  | "sync"
  | "sync-folder";
export type BookFilter = "all" | "favorites" | "finished" | "removed";
type Target = { book: any; x: number; y: number; trigger: HTMLElement };

export function useBookContextMenu(
  onAction: (book: any, action: BookAction) => void,
  allowSync = false,
) {
  const [target, setTarget] = useState<Target | null>(null);
  const activeTarget = useRef(target);
  activeTarget.current = target;
  const close = useCallback((restoreFocus = false) => {
    if (restoreFocus && activeTarget.current?.trigger.isConnected)
      activeTarget.current.trigger.focus();
    setTarget(null);
  }, []);
  const bookMenuProps = (book: any) => ({
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      e.preventDefault();
      setTarget({ book, x: e.clientX, y: e.clientY, trigger: e.currentTarget });
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      setTarget({
        book,
        x: rect.left + 12,
        y: rect.top + 24,
        trigger: e.currentTarget,
      });
    },
  });
  return {
    bookMenuProps,
    menu: target ? (
      <BookContextMenu
        target={target}
        close={close}
        onAction={onAction}
        allowSync={allowSync}
      />
    ) : null,
  };
}
function BookContextMenu({
  target,
  close,
  onAction,
  allowSync,
}: {
  target: Target;
  close: (focus?: boolean) => void;
  onAction: (book: any, action: BookAction) => void;
  allowSync: boolean;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: target.x, top: target.y });
  useLayoutEffect(() => {
    const rect = menu.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8)),
      top: Math.max(
        8,
        Math.min(target.y, window.innerHeight - rect.height - 8),
      ),
    });
    menu.current!.querySelector<HTMLButtonElement>("button")?.focus();
  }, [target]);
  useEffect(() => {
    const outside = (e: globalThis.MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) close();
    };
    const dismiss = () => close();
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    // A pending programmatic scroll into view can arrive after contextmenu.
    // Dismiss for actual user scrolling, not for that delayed layout event.
    window.addEventListener("wheel", dismiss, { capture: true, passive: true });
    window.addEventListener("touchmove", dismiss, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("wheel", dismiss, true);
      window.removeEventListener("touchmove", dismiss, true);
    };
  }, [close]);
  const book = target.book;
  const actions: {
    action: BookAction;
    label: string;
    icon: typeof Star;
    checked?: boolean;
    danger?: boolean;
  }[] = book.removedAt
    ? [{ action: "restore", label: "恢复到书库", icon: Undo2 }]
    : [
        {
          action: "favorite",
          label: book.favorite ? "取消收藏" : "收藏",
          icon: Star,
          checked: !!book.favorite,
        },
        {
          action: "finished",
          label: book.finishedAt ? "标记为未读" : "标记为已读完",
          icon: book.finishedAt ? BookOpen : BookCheck,
          checked: !!book.finishedAt,
        },
        ...(allowSync
          ? [
              {
                action: "sync" as const,
                label: "同步到手机…",
                icon: Smartphone,
              },
              ...(book.bindings[0]?.sourceId
                ? [
                    {
                      action: "sync-folder" as const,
                      label: "同步所在文件夹…",
                      icon: FolderSync,
                    },
                  ]
                : []),
            ]
          : []),
        ...(book.format === "pdf" || isEpubFormat(book.format)
          ? [
              {
                action: "convert" as const,
                label: book.format === "pdf" ? "转换为 EPUB" : "转换为 PDF",
                icon: ArrowLeftRight,
              },
            ]
          : []),
        { action: "delete", label: "删除…", icon: Trash2, danger: true },
      ];
  return createPortal(
    <div
      ref={menu}
      className="book-context-menu"
      role="menu"
      aria-label={tr("书籍操作")}
      style={position}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          close(true);
          return;
        }
        const buttons = Array.from(
          menu.current!.querySelectorAll<HTMLButtonElement>("button"),
        );
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const next =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? buttons.length - 1
              : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                buttons.length;
        buttons[next].focus();
      }}
    >
      {actions.map(({ action, label, icon: Icon, checked, danger }) => (
        <button
          key={action}
          role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={checked}
          className={danger ? "danger" : ""}
          onClick={() => {
            close(true);
            onAction(book, action);
          }}
        >
          <Icon
            size={16}
            fill={action === "favorite" && checked ? "currentColor" : "none"}
          />
          {tr(label)}
        </button>
      ))}
      {!book.removedAt && (
        <small>{tr("保留原文件、笔记和阅读记录，可在已删除中恢复。")}</small>
      )}
    </div>,
    document.body,
  );
}
