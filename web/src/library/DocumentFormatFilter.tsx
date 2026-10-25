import { Check, ChevronDown, Filter } from "lucide-react";
import { tr } from "../i18n";
import { HoverDetails } from "./HoverDetails";
export type DocumentFormat = "all" | "epub" | "pdf" | "txt" | "markdown";
const formats = [
  ["all", "全部格式"],
  ["epub", "EPUB"],
  ["pdf", "PDF"],
  ["txt", "TXT"],
  ["markdown", "Markdown"],
] as const;
export function DocumentFormatFilter({
  value,
  onChange,
}: {
  value: DocumentFormat;
  onChange: (value: DocumentFormat) => void;
}) {
  return (
    <HoverDetails className="document-format-filter file-sort">
      <summary
        aria-label={tr("文件类型")}
        title={tr("文件类型")}
        aria-haspopup="menu"
      >
        <Filter size={15} />
        <span>{tr(formats.find(([key]) => key === value)![1])}</span>
        <ChevronDown size={14} />
      </summary>
      <div
        className="file-sort-menu"
        role="menu"
        aria-label={tr("筛选文件类型")}
      >
        {formats.map(([key, label]) => (
          <button
            key={key}
            role="menuitemradio"
            aria-checked={value === key}
            onClick={(event) => {
              onChange(key);
              const details = event.currentTarget.closest("details")!;
              details.open = false;
              details.querySelector("summary")?.focus();
            }}
          >
            <Check
              size={13}
              style={{ visibility: value === key ? "visible" : "hidden" }}
            />
            {tr(label)}
          </button>
        ))}
      </div>
    </HoverDetails>
  );
}
