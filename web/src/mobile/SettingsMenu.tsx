import {
  ArrowUpCircle,
  BookOpen,
  ChevronRight,
  Info,
  Laptop,
  Moon,
  NotebookPen,
  Upload,
} from "lucide-react";
import { tr } from "../i18n";
export type SettingsPage =
  "home" | "sync" | "catalog" | "appearance" | "import" | "about" | "update";
export const settingsTitle = (page: SettingsPage) =>
  ({
    home: "设置",
    sync: "电脑与同步",
    catalog: "电脑书库",
    appearance: "通用设置",
    import: "导入与分享",
    about: "关于 Open Reading",
    update: "检查更新",
  })[page];
export function SettingsMenu({
  paired,
  count,
  pending,
  open,
  onStats,
  onLibrary,
}: {
  paired: boolean;
  count: number;
  pending: number;
  open: (page: SettingsPage) => void;
  onStats: () => void;
  onLibrary: () => void;
}) {
  const row = (
    Icon: typeof Laptop,
    title: string,
    description: string,
    action: () => void,
  ) => (
    <button className="mobile-menu-row" aria-label={tr(title)} onClick={action}>
      <span className="mobile-menu-icon">
        <Icon size={21} />
      </span>
      <span>{tr(title)}</span>
      <small>{tr(description)}</small>
      <ChevronRight size={16} />
    </button>
  );
  return (
    <div className="mobile-settings-menu">
      <div className="mobile-menu-profile">
        <span>
          <BookOpen size={26} />
        </span>
        <div>
          <strong>Open Reading</strong>
          <small>{tr("自己的书库，随身的阅读")}</small>
        </div>
      </div>
      <section className="mobile-menu-group" aria-label={tr("阅读与书库")}>
        {row(Laptop, "电脑与同步", paired ? "已配对" : "未连接", () =>
          open("sync"),
        )}
        {row(BookOpen, "阅读数据", "阅读时间与日历", onStats)}
        {row(
          NotebookPen,
          "本机阅读资料",
          `${count} ${tr("本已下载")}`,
          onLibrary,
        )}
      </section>
      <section className="mobile-menu-group" aria-label={tr("工具与偏好")}>
        {row(
          Upload,
          "导入与分享",
          pending ? tr("等待同步") + ` ${pending}` : "ORD 学习包",
          () => open("import"),
        )}
        {row(Moon, "通用设置", "外观与语言", () => open("appearance"))}
      </section>
      <section className="mobile-menu-group">
        {row(ArrowUpCircle, "检查更新", "手机应用升级", () => open("update"))}
        {row(Info, "关于 Open Reading", "", () => open("about"))}
      </section>
    </div>
  );
}
