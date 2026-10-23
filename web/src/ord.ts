import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

export function ordPath(member: string, version: string, manifest?: string) {
  return `/documents/${encodeURIComponent(member)}/ord?${new URLSearchParams({ versionId: version, ...(manifest ? { manifestId: manifest } : {}) })}`;
}
export function ordForm(file: File) {
  const data = new FormData();
  data.append("file", file);
  data.append("clientRequestId", crypto.randomUUID());
  return data;
}
export async function ordResponse(response: Response) {
  if (!response.ok) {
    const e = await response
      .json()
      .catch(() => ({ message: "学习包导出失败，请重试" }));
    throw Error(e.message);
  }
  return response.blob();
}
export async function saveORD(blob: Blob, title: string) {
  return saveExport(blob, title, "ord");
}
export async function saveExport(
  blob: Blob,
  title: string,
  extension: "ord" | "csv" | "md" | "txt",
) {
  let basename = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-");
  while (new TextEncoder().encode(basename).length > 180)
    basename = Array.from(basename).slice(0, -1).join("");
  const filename = (basename.trim() || "Open Reading") + "." + extension;
  if (Capacitor.isNativePlatform()) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () =>
        reject(Error("无法保存导出文件，请检查手机剩余空间"));
      reader.readAsDataURL(blob);
    });
    const file = await Filesystem.writeFile({
      directory: Directory.Cache,
      path: `openreading-exports/${crypto.randomUUID()}/${filename}`,
      recursive: true,
      data,
    });
    await Share.share({
      title:
        extension === "ord"
          ? "Open Reading 学习包"
          : extension === "csv"
            ? "Open Reading 阅读数据"
            : "Open Reading 笔记",
      dialogTitle:
        extension === "ord"
          ? "保存或分享 ORD 学习包"
          : extension === "csv"
            ? "保存或分享阅读数据"
            : "保存或分享笔记",
      files: [file.uri],
    });
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
