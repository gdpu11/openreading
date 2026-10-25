# MCP document delivery

[中文](#中文)

Open Reading includes a local **Streamable HTTP MCP server**. Codex, Cursor and other MCP clients can deliver finished Markdown or TXT documents straight into your library for reading, highlighting and notes.

## Connect

1. Open your **local** Open Reading library and go to **Settings → MCP connections**.
2. Select the workspace that should receive documents, enable MCP and save the connection settings. The default address is `http://127.0.0.1:7319/mcp`. Choose a different port if it is occupied.
3. Select Codex or Cursor and click **Copy configuration (includes key)**. Merge the configuration into the indicated file, keeping your existing servers. The key is shown only when generated; keep it private. Generating another key immediately revokes the previous one.
4. Reconnect the MCP server in your AI client. Keep Open Reading running. The MCP port and key survive app restarts, even though the desktop reader itself uses a different port on each launch.

Codex configuration (`~/.codex/config.toml`):

```toml
[mcp_servers.openreading]
url = "http://127.0.0.1:7319/mcp"
http_headers = { Authorization = "Bearer YOUR_OPENREADING_MCP_TOKEN" }
```

Cursor configuration (`~/.cursor/mcp.json`, or project-specific `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "openreading": {
      "url": "http://127.0.0.1:7319/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_OPENREADING_MCP_TOKEN"
      }
    }
  }
}
```

These configurations use the clients' documented HTTP header support: [Codex MCP configuration](https://developers.openai.com/codex/mcp), [Cursor MCP configuration](https://cursor.com/docs/mcp). The server uses the [official Go MCP SDK](https://github.com/modelcontextprotocol/go-sdk).

## Ask your AI

> Turn our discussion into a Markdown design document titled “Cache design”. Save it to Open Reading with `create_document`. Include the tradeoffs and next steps.

> Read “Cache design” from Open Reading, add the failure scenarios we just discussed, and save the revised document with `update_document`.

Return to the selected workspace to read the delivered document. The desktop shelf refreshes when its window regains focus; you can also click Refresh. An already-open reader keeps its current snapshot until you reopen the document.

## Tools

| Tool | Inputs | Behavior |
| --- | --- | --- |
| `list_documents` | Optional `query`, `cursor` | Lists delivered documents in the configured workspace, 50 per page. Follow `nextCursor` until empty. |
| `read_document` | `documentId` | Returns complete text and document metadata, including the current `revision` and snapshot `versionId`. |
| `create_document` | `title`, `content`, `clientRequestId`; optional `format` | Creates a library document. Format defaults to `markdown`; `txt` is also supported. |
| `update_document` | `documentId`, `expectedRevision`, `content`, `clientRequestId`; optional `title` | Replaces the complete text and optionally renames the document. Keeps the document identity, previous snapshots and reading notes. |

Use the `documentId` returned by these tools. Each write needs a unique `clientRequestId`; retry an uncertain write with the **same ID and arguments** to avoid duplicates. Read a document before updating it and pass its `revision` as `expectedRevision`. If another client has already edited it, the server returns `VERSION_CHANGED`; read again and merge instead of overwriting. Each document is limited to 1 MiB of nonempty UTF-8 text.

## Access and storage

- Disabled by default. The listener binds only to `127.0.0.1`, validates Host and Origin, and requires a dedicated bearer key. Reading UI sessions and mobile pairing credentials do not grant MCP access.
- One connection targets the workspace selected in settings. Clients can only list, read and update documents delivered through MCP in that workspace. Imported books, connected folders, model credentials and personal notes are not exposed through these tools. There are no delete or arbitrary-file tools.
- MCP is available in the local desktop / local Go service. The self-hosted public mode does not enable it. This loopback endpoint is for AI clients running on the same computer, not hosted cloud agents.
- Text is stored in application-owned files and versioned snapshots. An update publishes a new file and database revision together; it does not modify an external original. Reader annotations retain their original version and use the existing version-matching workflow.
- Delivered documents, their version history and reading notes are included in normal backups and workspace sync. Restored documents get new IDs; `list_documents` discovers them, and the first update recreates their local source file. Keys and MCP settings are excluded from backups and sync. Enable MCP and choose the restored workspace separately.
- Disabling MCP closes the listener. Generating a new key rejects the old key on subsequent requests. A request already accepted can finish. The listener is closed when the app exits.

## 中文

在本机 Open Reading 中打开 **设置 → MCP 接入**，选择接收工作区，勾选启用并保存。默认地址为 `http://127.0.0.1:7319/mcp`；端口被占用时可在这里修改。

选择 Codex 或 Cursor，点击 **复制配置（含密钥）**，合并到上面的配置文件中，然后重新连接客户端。密钥仅在生成时提供；之后如果需要重新配置，请生成新密钥，并更新所有客户端。保持 Open Reading 运行，重启应用后地址和密钥不变。

可以直接对 AI 说：

> 把刚才讨论的方案整理成 Markdown，用 Open Reading 的 `create_document` 工具存进书库，标题叫「缓存设计」。补齐背景、取舍和后续事项。

> 读取 Open Reading 里的「缓存设计」，补充我们刚讨论的故障场景，再用 `update_document` 更新。

回到所选工作区即可阅读；桌面书架在重新获得焦点时刷新，也可以点刷新按钮。已经打开的阅读窗口保持当前快照，重新打开文档后读取新版本。

支持 Markdown 和 TXT，单篇最多 1 MiB。每次写入携带独立 `clientRequestId`，重试沿用相同编号和参数。更新前先读取，再把 `revision` 作为 `expectedRevision` 提交；版本冲突时重新读取并合并。旧版本和原有阅读笔记会保留。

连接只在本机开放，默认关闭，并限制在设置中指定的工作区。客户端只能读取和更新经 MCP 投递的文档，不能读取其他书籍或笔记、操作任意文件、删除书籍。文档可正常备份和同步，连接密钥和设置不会随备份或同步传出。云端自托管模式和远程云端 AI 客户端不使用这个本机入口。
