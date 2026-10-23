import { useRef, useState } from "react";
import { api } from "../api";
import { tr } from "../i18n";
import { X, Link } from "lucide-react";

export function articleText(html: string, url: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title =
    doc.querySelector("meta[property='og:title']")?.getAttribute("content") ||
    doc.title ||
    "Article";
  doc
    .querySelectorAll(
      "script,style,nav,header,footer,aside,form,noscript,iframe,object,embed,svg,[hidden],[aria-hidden=true]",
    )
    .forEach((el) => el.remove());
  const root =
    doc.querySelector("article") || doc.querySelector("main") || doc.body;
  const lines: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      lines.push(node.textContent || "");
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.localName;
    if (/^h[1-6]$/.test(tag))
      lines.push("\n\n" + "#".repeat(Number(tag[1])) + " ");
    else if (/^(p|div|section|article|blockquote|ul|ol|pre|tr)$/.test(tag))
      lines.push("\n\n");
    else if (tag === "br") lines.push("\n");
    else if (tag === "li") lines.push("\n- ");
    node.childNodes.forEach(walk);
    if (/^(p|div|section|article|blockquote|pre|h[1-6])$/.test(tag))
      lines.push("\n\n");
  };
  walk(root);
  return {
    title: title.trim(),
    text: `# ${title.trim()}\n\n来源：${url}\n\n${lines
      .join("")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()}`,
  };
}
export function ArticleImport({
  workspace,
  onDone,
  onClose,
}: {
  workspace: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const [url, setURL] = useState(""),
    [title, setTitle] = useState(""),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  return (
    <section
      className="book-tools-panel"
      role="dialog"
      aria-label={tr("导入网页文章")}
    >
      <header>
        <h3>
          <Link size={18} /> {tr("导入网页文章")}
        </h3>
        <button aria-label={tr("关闭阅读工具")} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <p>{tr("输入公开网页地址，预览并编辑正文后保存到书库。")}</p>
      <input
        aria-label={tr("网页地址")}
        type="url"
        value={url}
        onChange={(e) => {
          generation.current++;
          setURL(e.target.value);
          setText("");
        }}
        placeholder="https://…"
      />
      <button
        disabled={busy || !url}
        onClick={async () => {
          const run = ++generation.current;
          setBusy(true);
          setError("");
          try {
            const data = await api("/articles/preview", "POST", { url });
            if (run === generation.current) {
              const article = articleText(data.html, data.url);
              setTitle(article.title);
              setText(article.text);
            }
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {tr(busy ? "正在读取…" : "预览正文")}
      </button>
      {error && <p role="alert">{tr(error)}</p>}
      {text && (
        <>
          <input
            aria-label={tr("文章标题")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            aria-label={tr("文章正文")}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            className="primary"
            disabled={busy || !text.trim()}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const form = new FormData();
                form.append(
                  "files",
                  new File(
                    [text],
                    title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 100) + ".md",
                    { type: "text/markdown" },
                  ),
                );
                await api(`/workspaces/${workspace}/imports`, "POST", form);
                onDone();
                onClose();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {tr("保存到书库")}
          </button>
        </>
      )}
    </section>
  );
}
