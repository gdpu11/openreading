import { readingDisplayAvailable } from "./readingDisplay";
import type { ReaderPreferences } from "../readers/types";
import { tr } from "../i18n";
import { MobileSheet } from "./MobileSheet";
import { Minus, Plus } from "lucide-react";
export function ReaderSettings({
  preferences: p,
  onChange,
  onClose,
  epub,
  pdf,
}: {
  preferences: ReaderPreferences;
  onChange: (p: ReaderPreferences) => void;
  onClose: () => void;
  epub: boolean;
  pdf: boolean;
}) {
  return (
    <MobileSheet
      title="阅读设置"
      closeLabel="关闭阅读设置"
      onClose={onClose}
      className="mobile-reading-settings"
    >
      <div
        className="mobile-theme-swatches"
        role="group"
        aria-label={tr("阅读背景")}
      >
        {[
          ["light", "白天"],
          ["sepia", "纸张"],
          ["green", "浅绿"],
          ["dark", "夜间"],
        ].map(([theme, label]) => (
          <button
            key={theme}
            data-reading-theme={theme}
            aria-pressed={p.theme === theme}
            onClick={() => onChange({ ...p, theme })}
          >
            <span />
            <small>{tr(label)}</small>
          </button>
        ))}
      </div>
      {!pdf && (
        <>
          <div className="mobile-font-stepper">
            <span>{tr("字号")}</span>
            <button
              aria-label={tr("缩小字号")}
              disabled={p.fontSize <= 14}
              onClick={() =>
                onChange({ ...p, fontSize: Math.max(14, p.fontSize - 1) })
              }
            >
              <Minus size={20} />
            </button>
            <output>{p.fontSize}</output>
            <button
              aria-label={tr("放大字号")}
              disabled={p.fontSize >= 32}
              onClick={() =>
                onChange({ ...p, fontSize: Math.min(32, p.fontSize + 1) })
              }
            >
              <Plus size={20} />
            </button>
          </div>
          <input
            className="mobile-font-slider"
            aria-label={tr("手机阅读字号")}
            type="range"
            min="14"
            max="32"
            value={p.fontSize}
            onChange={(e) =>
              onChange({ ...p, fontSize: Number(e.target.value) })
            }
          />
          <div className="mobile-setting-options">
            <span>{tr("字体")}</span>
            <div>
              {[
                ["system-ui", "系统字体"],
                ["serif", "衬线字体"],
              ].map(([fontFamily, label]) => (
                <button
                  key={fontFamily}
                  style={{ fontFamily }}
                  aria-pressed={p.fontFamily === fontFamily}
                  onClick={() => onChange({ ...p, fontFamily })}
                >
                  {tr(label)}
                </button>
              ))}
            </div>
          </div>
          <div className="mobile-setting-options">
            <span>{tr("行距")}</span>
            <div>
              {[
                [1.6, "紧凑"],
                [1.9, "标准"],
                [2.2, "宽松"],
              ].map(([lineHeight, label]) => (
                <button
                  key={lineHeight}
                  aria-pressed={p.lineHeight === lineHeight}
                  onClick={() =>
                    onChange({ ...p, lineHeight: Number(lineHeight) })
                  }
                >
                  {tr(String(label))}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {epub && (
        <div className="mobile-setting-options">
          <span>{tr("翻页")}</span>
          <div>
            {[
              ["paginated", "左右翻页"],
              ["scrolled-doc", "上下滚动"],
            ].map(([epubFlow, label]) => (
              <button
                key={epubFlow}
                aria-pressed={p.epubFlow === epubFlow}
                onClick={() => onChange({ ...p, epubFlow })}
              >
                {tr(label)}
              </button>
            ))}
          </div>
        </div>
      )}
      {pdf && (
        <div className="mobile-setting-options">
          <span>{tr("缩放")}</span>
          <div>
            <button
              onClick={() => onChange({ ...p, pdfScale: 1, pdfRotation: 0 })}
            >
              {tr("适合屏幕")}
            </button>
            <button
              onClick={() =>
                onChange({ ...p, pdfRotation: (p.pdfRotation + 90) % 360 })
              }
            >
              {tr("旋转页面")}
            </button>
          </div>
        </div>
      )}
      {readingDisplayAvailable() && (
        <>
          <label className="mobile-reading-toggle">
            <span>{tr("阅读时保持亮屏")}</span>
            <input
              type="checkbox"
              checked={p.keepAwake !== false}
              onChange={(e) => onChange({ ...p, keepAwake: e.target.checked })}
            />
          </label>
          <label className="mobile-reading-toggle">
            <span>{tr("亮度跟随系统")}</span>
            <input
              type="checkbox"
              checked={p.brightness == null || p.brightness < 0}
              onChange={(e) =>
                onChange({ ...p, brightness: e.target.checked ? -1 : 0.5 })
              }
            />
          </label>
          {p.brightness != null && p.brightness >= 0 && (
            <input
              className="mobile-font-slider"
              aria-label={tr("阅读亮度")}
              type="range"
              min="0.05"
              max="1"
              step="0.05"
              value={p.brightness}
              onChange={(e) =>
                onChange({ ...p, brightness: Number(e.target.value) })
              }
            />
          )}
        </>
      )}
      <label className="mobile-reading-toggle">
        <span>{tr("点击左右两侧翻页")}</span>
        <input
          type="checkbox"
          checked={p.tapToTurn !== false}
          onChange={(e) => onChange({ ...p, tapToTurn: e.target.checked })}
        />
      </label>
      <small>
        {tr(
          "左侧上一页，右侧下一页；轻点中间显示菜单。长按文字可复制或记笔记。",
        )}
      </small>
    </MobileSheet>
  );
}
