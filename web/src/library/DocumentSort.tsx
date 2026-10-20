import { ArrowDownWideNarrow, Check } from "lucide-react";
import { tr } from "../i18n";
import type { ReaderPreferences } from "../readers/types";
export function DocumentSort({
  value,
  onChange,
}: {
  value: ReaderPreferences["documentSort"];
  onChange: (value: ReaderPreferences["documentSort"]) => void;
}) {
  return (
    <details
      className="file-sort"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          e.currentTarget.open = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.currentTarget.open = false;
          e.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={tr("文件排序")} title={tr("文件排序")}>
        <ArrowDownWideNarrow size={16} />
      </summary>
      <div
        className="file-sort-menu"
        role="menu"
        aria-label={tr("文件排序方式")}
      >
        {(
          [
            ["default", "默认排序"],
            ["recent", "最近阅读"],
            ["added", "添加时间（最新在前）"],
            ["added-oldest", "添加时间（最早在前）"],
            ["name", "文件名（A–Z）"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="menuitemradio"
            aria-checked={(value || "default") === key}
            onClick={(e) => {
              onChange(key);
              e.currentTarget.closest("details")!.open = false;
            }}
          >
            <Check
              size={13}
              style={{
                visibility: (value || "default") === key ? "visible" : "hidden",
              }}
            />
            {tr(label)}
          </button>
        ))}
      </div>
    </details>
  );
}
