import { ArrowDownWideNarrow, Check } from "lucide-react";
import { tr } from "../i18n";
import type { ReaderPreferences } from "../readers/types";
import { HoverDetails } from "./HoverDetails";
export function DocumentSort({
  value,
  onChange,
}: {
  value: ReaderPreferences["documentSort"];
  onChange: (value: ReaderPreferences["documentSort"]) => void;
}) {
  return (
    <HoverDetails className="file-sort">
      <summary
        aria-label={tr("文件排序")}
        title={tr("文件排序")}
        aria-haspopup="menu"
      >
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
              const details = e.currentTarget.closest("details")!;
              details.open = false;
              details.querySelector("summary")?.focus();
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
    </HoverDetails>
  );
}
