import { locale, tr } from "../i18n";
import type { BookWordCount as Count } from "./wordCount";

export function BookWordCount({
  value,
  pdf,
  speed = 300,
}: {
  value: Count | null | "unavailable";
  pdf: boolean;
  speed?: number;
}) {
  const rules = tr("中文按字、英文按单词统计，忽略空白和标点。");
  const detail = pdf
    ? tr("仅统计 PDF 文字层；扫描图片中的文字不计入。") +
      (value && value !== "unavailable"
        ? " " + tr(`有文字 ${value.textPages} / ${value.pages} 页`)
        : "")
    : tr("统计全书正文，不包含目录、脚本和样式。");
  return (
    <>
      <span
        className="book-word-count"
        title={rules + " " + detail}
        aria-label={tr("全书字数")}
      >
        {value === "unavailable"
          ? tr("字数暂不可用")
          : value === null
            ? tr("字数统计中…")
            : `${tr(pdf ? "可提取文字" : "全书字数")} ${value.count.toLocaleString(locale())} ${tr("字/词")}`}
      </span>
      {value && value !== "unavailable" && (
        <span
          className="estimated-reading-time"
          title={tr(
            `按每分钟 ${Math.max(50, Math.min(2000, speed || 300))} 字/词估算，可在阅读设置中调整。`,
          )}
        >
          {value.count === 0 ? (
            tr("暂无文字，无法估算阅读时间")
          ) : (
            <>
              {tr(
                pdf && (value.textPages || 0) < (value.pages || 0)
                  ? "文字部分预计阅读"
                  : "预计阅读",
              )}{" "}
              {readingDuration(value.count, speed)}
            </>
          )}
        </span>
      )}
    </>
  );
}

export function readingDuration(count: number, speed = 300) {
  const minutes = Math.ceil(count / Math.max(50, Math.min(2000, speed || 300)));
  return minutes >= 60
    ? tr(`${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`)
    : tr(`${minutes} 分钟`);
}
