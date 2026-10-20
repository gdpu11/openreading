import { Filter } from "lucide-react";
import { tr } from "../i18n";
export type DocumentFormat = "all" | "epub" | "pdf" | "txt" | "markdown";
export function DocumentFormatFilter({
  value,
  onChange,
}: {
  value: DocumentFormat;
  onChange: (value: DocumentFormat) => void;
}) {
  return (
    <label className="document-format-filter" title={tr("文件类型")}>
      <Filter size={15} />
      <select
        aria-label={tr("文件类型")}
        value={value}
        onChange={(e) => onChange(e.target.value as DocumentFormat)}
      >
        {[
          ["all", "全部格式"],
          ["epub", "EPUB"],
          ["pdf", "PDF"],
          ["txt", "TXT"],
          ["markdown", "Markdown"],
        ].map(([key, label]) => (
          <option key={key} value={key}>
            {tr(label)}
          </option>
        ))}
      </select>
    </label>
  );
}
