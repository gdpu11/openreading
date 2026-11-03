import { locale, tr } from "../i18n";
import type { BookWordCount as Count } from "./wordCount";
import { readingPace, type ReadingPace } from "../reading/pace";

export function BookWordCount({
  value,
  pdf,
  pace = readingPace([]),
}: {
  value: Count | null | "unavailable";
  pdf: boolean;
  pace?: ReadingPace;
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
            pace.learned
              ? "根据你的有效阅读速度估算，会随阅读记录持续更新。"
              : "有效文字阅读累计满 1 小时后，自动使用你的实际阅读速度。",
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
              {readingDuration(value.count, pace.speed)}
              {" · "}
              <span aria-label={tr("当前阅读速度")}>
                {pace.speed} {tr("字/词每分钟")}
              </span>
            </>
          )}
        </span>
      )}
    </>
  );
}

export function readingDuration(count: number, speed = 300) {
  const minutes = Math.ceil(count / Math.max(20, Math.min(2000, speed || 300)));
  return minutes >= 60
    ? tr(`${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`)
    : tr(`${minutes} 分钟`);
}
