import { useLanguage, type Language } from "./index";
export function LanguageSelect({ compact = false }: { compact?: boolean }) {
  const [language, change] = useLanguage();
  return (
    <label className={compact ? "language-select compact" : "language-select"}>
      {!compact && <span>Language / 语言</span>}
      <select
        aria-label="Language / 语言"
        value={language}
        onChange={(e) => change(e.target.value as Language)}
      >
        <option value="en">English</option>
        <option value="zh">中文</option>
      </select>
    </label>
  );
}
