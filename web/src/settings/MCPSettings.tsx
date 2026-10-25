import { useEffect, useState } from "react";
import { api } from "../api";
import { copyText } from "../clipboard";
import { tr } from "../i18n";
import "./mcp.css";

type MCPStatus = {
  available: boolean;
  enabled: boolean;
  running: boolean;
  port: number;
  workspaceId: string;
  hasToken: boolean;
  url: string;
  error: string;
  token?: string;
};

export function mcpClientConfig(
  client: "codex" | "cursor",
  url: string,
  token: string,
) {
  if (client === "codex")
    return `[mcp_servers.openreading]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify("Bearer " + token)} }\n`;
  return JSON.stringify(
    {
      mcpServers: {
        openreading: { url, headers: { Authorization: "Bearer " + token } },
      },
    },
    null,
    2,
  );
}

export function MCPSettings({ workspaceId }: { workspaceId?: string }) {
  const [status, setStatus] = useState<MCPStatus | null>(null),
    [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]),
    [enabled, setEnabled] = useState(false),
    [port, setPort] = useState(7319),
    [target, setTarget] = useState(workspaceId || ""),
    [token, setToken] = useState(""),
    [showToken, setShowToken] = useState(false),
    [client, setClient] = useState<"codex" | "cursor">("codex"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    let alive = true;
    Promise.all([api<MCPStatus>("/mcp/settings"), api("/workspaces")])
      .then(([value, items]) => {
        if (!alive) return;
        setStatus(value);
        setEnabled(value.enabled);
        setPort(value.port);
        setTarget(value.workspaceId || workspaceId || items[0]?.id || "");
        setWorkspaces(items);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  async function save(rotate = false) {
    if (
      rotate &&
      !confirm(tr("生成新密钥后，旧密钥立即失效。请更新所有已接入的客户端。"))
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = rotate
        ? await api<MCPStatus>("/mcp/token", "POST", {})
        : await api<MCPStatus>("/mcp/settings", "PUT", {
            enabled,
            port,
            workspaceId: target,
          });
      setStatus(value);
      if (value.token) {
        setToken(value.token);
        setShowToken(false);
      }
      setNotice(rotate ? "新密钥已生成" : "连接设置已保存");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, trigger: HTMLElement) {
    try {
      await copyText(value, trigger);
      setNotice("已复制");
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <section className="mcp-settings" aria-label={tr("MCP 接入")}>
      <h3>{tr("让 AI 把文档送进书库")}</h3>
      <p className="muted">
        {tr(
          "让 Codex、Cursor 等客户端直接投递 Markdown / TXT，在 Open Reading 中阅读、划线和做笔记。",
        )}
      </p>
      {error && <p role="alert">{tr(error)}</p>}
      {notice && <p role="status">{tr(notice)}</p>}
      {status && !status.available ? (
        <p>{tr("请在本机书库中启用 MCP 接入")}</p>
      ) : (
        status && (
          <>
            <div className="mcp-connection-state">
              <strong>
                {tr(status.running ? "MCP 已开启" : "MCP 已关闭")}
              </strong>
              <code>{status.url}</code>
            </div>
            {status.error && <p role="alert">{tr(status.error)}</p>}
            <div className="settings-grid">
              <label className="mcp-enable">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                {tr("启用 MCP 接入")}
              </label>
              <label>
                {tr("接收文档的工作区")}
                <select
                  value={target}
                  disabled={busy}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">{tr("请选择工作区")}</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {tr("本机 MCP 端口")}
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={port}
                  disabled={busy}
                  onChange={(e) => setPort(Number(e.target.value))}
                />
              </label>
            </div>
            <p className="muted">
              {tr(
                "仅允许本机连接。客户端只能读取和更新通过 MCP 投递到所选工作区的文档。更新保留旧版本和阅读笔记。",
              )}
            </p>
            <div className="settings-actions">
              <button
                className="primary"
                disabled={
                  busy || (enabled && !target) || port < 1024 || port > 65535
                }
                onClick={() => void save()}
              >
                {tr("保存连接设置")}
              </button>
              {status.hasToken && (
                <button disabled={busy} onClick={() => void save(true)}>
                  {tr("生成新连接密钥")}
                </button>
              )}
            </div>
            {token && (
              <div className="mcp-key">
                <label>
                  {tr("连接密钥")}
                  <input
                    type={showToken ? "text" : "password"}
                    readOnly
                    value={token}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <button onClick={() => setShowToken(!showToken)}>
                  {tr(showToken ? "隐藏" : "显示")}
                </button>
                <button onClick={(e) => void copy(token, e.currentTarget)}>
                  {tr("复制密钥")}
                </button>
              </div>
            )}
            {status.hasToken && (
              <>
                <p className="muted">
                  {tr(
                    "密钥仅在生成时显示。关闭设置后，如需重新配置，请生成新密钥，并更新所有客户端。",
                  )}
                </p>
                <div
                  className="mcp-client-tabs"
                  role="group"
                  aria-label={tr("选择 MCP 客户端")}
                >
                  <button
                    className={client === "codex" ? "active" : ""}
                    onClick={() => setClient("codex")}
                  >
                    Codex
                  </button>
                  <button
                    className={client === "cursor" ? "active" : ""}
                    onClick={() => setClient("cursor")}
                  >
                    Cursor
                  </button>
                </div>
                <p>
                  {tr("将配置合并到")}{" "}
                  <code>
                    {client === "codex"
                      ? "~/.codex/config.toml"
                      : "~/.cursor/mcp.json"}
                  </code>
                </p>
                <pre className="mcp-config">
                  {mcpClientConfig(
                    client,
                    status.url,
                    "YOUR_OPENREADING_MCP_TOKEN",
                  )}
                </pre>
                <button
                  disabled={!token || busy}
                  onClick={(e) =>
                    void copy(
                      mcpClientConfig(client, status.url, token),
                      e.currentTarget,
                    )
                  }
                >
                  {tr("复制配置（含密钥）")}
                </button>
                <p className="muted">
                  {tr(
                    "保持 Open Reading 运行，保存配置后重新连接客户端。连接地址在应用重启后保持不变。",
                  )}
                </p>
                <div className="mcp-example">
                  <strong>{tr("试着对 AI 说")}</strong>
                  <p>
                    {tr(
                      "把刚才的方案整理成 Markdown，用 Open Reading 的 create_document 工具保存到书库，标题叫「方案笔记」。",
                    )}
                  </p>
                </div>
              </>
            )}
          </>
        )
      )}
    </section>
  );
}
