import { tr } from "../i18n";
import type { BookFilter } from "./BookContextMenu";
const filters = [
  ["all", "全部书籍"],
  ["favorites", "收藏"],
  ["finished", "已读完"],
  ["removed", "已删除"],
] as const;
export function BookFilters({
  value,
  onChange,
  compact = false,
}: {
  value: BookFilter;
  onChange: (value: BookFilter) => void;
  compact?: boolean;
}) {
  if (compact)
    return (
      <select
        className="file-collection"
        aria-label={tr("书库筛选")}
        value={value}
        onChange={(e) => onChange(e.target.value as BookFilter)}
      >
        {filters.map(([key, label]) => (
          <option key={key} value={key}>
            {tr(label)}
          </option>
        ))}
      </select>
    );
  return (
    <div className="library-filters" role="group" aria-label={tr("书库筛选")}>
      {filters.map(([key, label]) => (
        <button
          key={key}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {tr(label)}
        </button>
      ))}
    </div>
  );
}
