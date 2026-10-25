package server

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const mcpMaxText = 1 << 20

type mcpDocument struct {
	DocumentID string `json:"documentId"`
	Title      string `json:"title"`
	Format     string `json:"format"`
	VersionID  string `json:"versionId"`
	Revision   int    `json:"revision"`
	Bytes      int    `json:"bytes"`
}

type mcpListInput struct {
	Query  string `json:"query,omitempty" jsonschema:"optional title search"`
	Cursor string `json:"cursor,omitempty" jsonschema:"nextCursor from the previous page"`
}

type mcpListOutput struct {
	Documents  []mcpDocument `json:"documents"`
	NextCursor string        `json:"nextCursor"`
}

type mcpReadInput struct {
	DocumentID string `json:"documentId" jsonschema:"documentId returned by create_document or list_documents"`
}

type mcpReadOutput struct {
	Document mcpDocument `json:"document"`
	Content  string      `json:"content"`
}

type mcpCreateInput struct {
	Title           string `json:"title" jsonschema:"display title of the document"`
	Content         string `json:"content" jsonschema:"complete UTF-8 document text, at most 1 MiB"`
	Format          string `json:"format,omitempty" jsonschema:"markdown (default) or txt"`
	ClientRequestID string `json:"clientRequestId" jsonschema:"unique ID for this write; reuse unchanged only when retrying it"`
}

type mcpUpdateInput struct {
	DocumentID       string `json:"documentId" jsonschema:"documentId of an MCP-delivered document"`
	ExpectedRevision int    `json:"expectedRevision" jsonschema:"current revision from read_document; protects against lost updates including renames"`
	Content          string `json:"content" jsonschema:"complete replacement UTF-8 document text, at most 1 MiB"`
	Title            string `json:"title,omitempty" jsonschema:"optional new display title; omit to keep it"`
	ClientRequestID  string `json:"clientRequestId" jsonschema:"unique ID for this write; reuse unchanged only when retrying it"`
}

func mcpToolError(err error) *mcp.CallToolResult {
	message := "OPERATION_FAILED: 操作未完成，请在 Open Reading 中检查书库后重试"
	var problem *apiError
	if errors.As(err, &problem) {
		message = problem.Code + ": " + problem.Message
	}
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: message}}}
}

const mcpDocumentQuery = `SELECT wd.id AS member_id,wd.document_id,e.id AS entry_id,e.source_id,e.relative_path,s.root,s.state AS source_state,d.format,v.id AS version_id,v.content_hash,v.blob_ref,v.size,md.revision
FROM mcp_documents md
JOIN workspace_documents wd ON wd.id=md.workspace_document_id
JOIN documents d ON d.id=wd.document_id
JOIN source_entries e ON e.id=md.source_entry_id AND e.document_id=wd.document_id
JOIN document_bindings b ON b.workspace_document_id=wd.id AND b.source_entry_id=e.id
JOIN sources s ON s.id=e.source_id AND s.workspace_id=wd.workspace_id AND s.kind='mcp'
JOIN versions v ON v.id=md.version_id AND v.document_id=wd.document_id
LEFT JOIN library_books lb ON lb.workspace_document_id=wd.id
WHERE wd.workspace_id=? AND s.state<>'removed' AND COALESCE(lb.removed_at,'')=''`

func mcpDocumentView(row M) M {
	return M{"documentId": row["memberId"], "title": row["relativePath"], "format": row["format"], "versionId": row["versionId"], "bytes": row["size"], "revision": row["revision"]}
}

func mcpTypedDocument(view M) mcpDocument {
	return mcpDocument{DocumentID: str(view, "documentId"), Title: str(view, "title"), Format: str(view, "format"), VersionID: str(view, "versionId"), Bytes: num(view, "bytes"), Revision: num(view, "revision")}
}

func (s *Server) mcpListDocuments(ctx context.Context, _ *mcp.CallToolRequest, input mcpListInput) (*mcp.CallToolResult, mcpListOutput, error) {
	if utf8.RuneCountInString(input.Query) > 200 || len(input.Cursor) > 64 {
		return mcpToolError(problem(400, "INVALID_SEARCH", "搜索关键词或分页游标过长", false)), mcpListOutput{}, nil
	}
	rows, err := all(s.db, mcpDocumentQuery+" AND wd.id>? AND instr(lower(e.relative_path),lower(?))>0 ORDER BY wd.id LIMIT 51", ctx.Value(mcpWorkspaceKey{}), input.Cursor, input.Query)
	if err != nil {
		return mcpToolError(err), mcpListOutput{}, nil
	}
	result := mcpListOutput{Documents: []mcpDocument{}}
	if len(rows) > 50 {
		rows = rows[:50]
		result.NextCursor = str(rows[49], "memberId")
	}
	for _, row := range rows {
		result.Documents = append(result.Documents, mcpTypedDocument(mcpDocumentView(row)))
	}
	return nil, result, nil
}

func (s *Server) mcpReadDocument(ctx context.Context, _ *mcp.CallToolRequest, input mcpReadInput) (*mcp.CallToolResult, mcpReadOutput, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock() // Keep the snapshot alive against cache collection.
	row, err := one(s.db, mcpDocumentQuery+" AND wd.id=?", ctx.Value(mcpWorkspaceKey{}), input.DocumentID)
	if err != nil {
		return mcpToolError(err), mcpReadOutput{}, nil
	}
	if !validBlobReference(str(row, "contentHash"), str(row, "blobRef")) {
		return mcpToolError(problem(400, "INVALID_SNAPSHOT", "文档快照引用无效", false)), mcpReadOutput{}, nil
	}
	file, err := os.Open(filepath.Join(s.cfg.DataDir, "blobs", str(row, "blobRef")))
	if err != nil {
		return mcpToolError(problem(404, "SOURCE_UNAVAILABLE", "文档快照不可用，请检查或恢复书库", false)), mcpReadOutput{}, nil
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, mcpMaxText+1))
	if err != nil || len(data) > mcpMaxText || digest(data) != str(row, "contentHash") {
		return mcpToolError(problem(400, "INVALID_SNAPSHOT", "文档快照校验失败", false)), mcpReadOutput{}, nil
	}
	return nil, mcpReadOutput{Document: mcpTypedDocument(mcpDocumentView(row)), Content: string(data)}, nil
}

func validateMCPText(title, content, kind string) error {
	if title == "" || utf8.RuneCountInString(title) > 200 {
		return problem(400, "INVALID_TITLE", "文档标题须为 1 至 200 字", false)
	}
	if kind != "markdown" && kind != "txt" {
		return problem(400, "UNSUPPORTED_FORMAT", "MCP 投递支持 Markdown 和 TXT", false)
	}
	if strings.TrimSpace(content) == "" || !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return problem(400, "INVALID_CONTENT", "请输入有效的非空 UTF-8 文本", false)
	}
	if len(content) > mcpMaxText {
		return problem(http.StatusRequestEntityTooLarge, "DOCUMENT_TOO_LARGE", "MCP 文档最多 1 MiB", false)
	}
	return nil
}

func (s *Server) mcpCreateDocument(ctx context.Context, _ *mcp.CallToolRequest, input mcpCreateInput) (*mcp.CallToolResult, mcpDocument, error) {
	kind := input.Format
	if kind == "" {
		kind = "markdown"
	}
	if err := validateMCPText(strings.TrimSpace(input.Title), input.Content, kind); err != nil {
		return mcpToolError(err), mcpDocument{}, nil
	}
	workspace, _ := ctx.Value(mcpWorkspaceKey{}).(string)
	result, err := s.mcpWriteDocument(workspace, "", 0, input.Title, input.Content, kind, input.ClientRequestID, input)
	if err != nil {
		return mcpToolError(err), mcpDocument{}, nil
	}
	return nil, mcpTypedDocument(result), nil
}

func (s *Server) mcpUpdateDocument(ctx context.Context, _ *mcp.CallToolRequest, input mcpUpdateInput) (*mcp.CallToolResult, mcpDocument, error) {
	if input.DocumentID == "" || input.ExpectedRevision < 1 {
		return mcpToolError(problem(400, "VERSION_REQUIRED", "请先读取文档并提供当前版本编号", false)), mcpDocument{}, nil
	}
	workspace, _ := ctx.Value(mcpWorkspaceKey{}).(string)
	result, err := s.mcpWriteDocument(workspace, input.DocumentID, input.ExpectedRevision, input.Title, input.Content, "", input.ClientRequestID, input)
	if err != nil {
		return mcpToolError(err), mcpDocument{}, nil
	}
	return nil, mcpTypedDocument(result), nil
}

func (s *Server) mcpWriteDocument(workspace, member string, expected int, title, content, kind, requestID string, input any) (M, error) {
	s.importMu.Lock()
	defer s.importMu.Unlock()
	root := ""
	scope := "mcp-create:" + workspace
	if member != "" {
		scope = "mcp-update:" + workspace + ":" + member
	}
	result, err := s.idem(scope, requestID, input, func(tx *sql.Tx) (M, error) {
		if _, err := one(tx, "SELECT id FROM workspaces WHERE id=?", workspace); err != nil {
			return nil, err
		}
		var previous M
		document, source, entry := id(), id(), id()
		if member != "" {
			var err error
			previous, err = one(tx, mcpDocumentQuery+" AND wd.id=?", workspace, member)
			if err != nil {
				return nil, problem(404, "MCP_DOCUMENT_REQUIRED", "仅可更新当前工作区中由 MCP 投递且未删除的文档", false)
			}
			if num(previous, "revision") != expected {
				return nil, problem(409, "VERSION_CHANGED", "文档已被更新，请重新读取并合并后再提交", false)
			}
			document, source, entry, kind = str(previous, "documentId"), str(previous, "sourceId"), str(previous, "entryId"), str(previous, "format")
			if strings.TrimSpace(title) == "" {
				title = str(previous, "relativePath")
			}
		} else {
			member = id()
		}
		title = strings.TrimSpace(title)
		if err := validateMCPText(title, content, kind); err != nil {
			return nil, err
		}
		name := ordName(title, kind)
		if previous != nil && str(previous, "contentHash") == digest([]byte(content)) && str(previous, "relativePath") == name && str(previous, "sourceState") == "active" {
			return mcpDocumentView(previous), nil
		}
		manifest := id()
		// Each revision gets an immutable source directory. The transaction
		// publishes its new root; a failed commit never changes the old file.
		if !ordHex(source, 32) {
			return nil, problem(400, "INVALID_SOURCE", "文档来源编号无效", false)
		}
		root = filepath.Join(s.cfg.DataDir, "imports", "mcp-"+source, manifest)
		if err := os.MkdirAll(root, 0700); err != nil {
			return nil, err
		}
		file, err := os.OpenFile(filepath.Join(root, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return nil, err
		}
		_, err = io.WriteString(file, content)
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return nil, err
		}
		for _, directory := range []string{root, filepath.Dir(root), filepath.Dir(filepath.Dir(root))} {
			if err := syncDirectory(directory); err != nil {
				return nil, err
			}
		}
		hash, size, err := s.capture(root, name)
		if err != nil {
			return nil, err
		}
		created := now()
		if previous == nil {
			for _, statement := range []struct {
				query string
				args  []any
			}{
				{"INSERT INTO documents VALUES(?,?,?)", []any{document, kind, created}},
				{"INSERT INTO sources(id,workspace_id,kind,root,label,created_at) VALUES(?,?,'mcp',?,'MCP',?)", []any{source, workspace, root, created}},
				{"INSERT INTO workspace_documents(id,workspace_id,document_id) VALUES(?,?,?)", []any{member, workspace, document}},
				{"INSERT INTO source_entries VALUES(?,?,?,?,?,?,?,'active')", []any{entry, source, document, name, "", size, 0}},
				{"INSERT INTO document_bindings VALUES(?,?,'active')", []any{member, entry}},
			} {
				if err := exec(tx, statement.query, statement.args...); err != nil {
					return nil, err
				}
			}
		} else {
			if err := exec(tx, "UPDATE sources SET root=?,state='active' WHERE id=?", root, source); err != nil {
				return nil, err
			}
			if err := exec(tx, "UPDATE source_entries SET relative_path=?,size=?,state='active' WHERE id=?", name, size, entry); err != nil {
				return nil, err
			}
			if err := exec(tx, "UPDATE document_bindings SET state='active' WHERE workspace_document_id=? AND source_entry_id=?", member, entry); err != nil {
				return nil, err
			}
			if err := exec(tx, "UPDATE workspace_documents SET state='active' WHERE id=?", member); err != nil {
				return nil, err
			}
		}
		version, err := one(tx, "SELECT id FROM versions WHERE document_id=? AND content_hash=?", document, hash)
		if isNotFound(err) {
			version = M{"id": id()}
			err = exec(tx, "INSERT INTO versions VALUES(?,?,?,?,?,?)", version["id"], document, hash, hash, size, created)
		}
		if err != nil {
			return nil, err
		}
		if err := exec(tx, "INSERT INTO manifests VALUES(?,?,?,'[]',?)", manifest, version["id"], entry, created); err != nil {
			return nil, err
		}
		if err := exec(tx, "INSERT INTO mcp_documents(workspace_document_id,source_entry_id,version_id) VALUES(?,?,?) ON CONFLICT(workspace_document_id) DO UPDATE SET version_id=excluded.version_id,revision=mcp_documents.revision+1", member, entry, version["id"]); err != nil {
			return nil, err
		}
		if err := exec(tx, "DELETE FROM search_sections WHERE version_id=?", version["id"]); err != nil {
			return nil, err
		}
		if err := exec(tx, "INSERT INTO search_sections VALUES(?,0,?,'{}',?) ON CONFLICT(version_id,position) DO UPDATE SET label=excluded.label,text=excluded.text", version["id"], name, content); err != nil {
			return nil, err
		}
		if err := exec(tx, "INSERT INTO search_indexes VALUES(?,1) ON CONFLICT(version_id) DO UPDATE SET complete=1", version["id"]); err != nil {
			return nil, err
		}
		revision := 1
		if previous != nil {
			revision = num(previous, "revision") + 1
		}
		return M{"documentId": member, "title": name, "format": kind, "versionId": version["id"], "bytes": size, "revision": revision}, nil
	})
	if err != nil && root != "" {
		_ = os.RemoveAll(root)
	}
	return result, err
}
