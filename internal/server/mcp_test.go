package server

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpAuthTransport string

func (token mcpAuthTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	r := request.Clone(request.Context())
	r.Header.Set("Authorization", "Bearer "+string(token))
	return http.DefaultTransport.RoundTrip(r)
}

func mcpFreePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	return port
}

func mcpConnect(t *testing.T, endpoint, token string) *mcp.ClientSession {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "integration-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: endpoint, HTTPClient: &http.Client{Transport: mcpAuthTransport(token)}, DisableStandaloneSSE: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { session.Close() })
	return session
}

func mcpSetup(t *testing.T) (*testClient, M, M, *mcp.ClientSession) {
	t.Helper()
	c := newClient(t, Config{})
	workspace := c.workspace("AI 文档")
	settings := c.ok("PUT", "/api/mcp/settings", M{"enabled": true, "port": mcpFreePort(t), "workspaceId": workspace["id"]})
	return c, workspace, settings, mcpConnect(t, str(settings, "url"), str(settings, "token"))
}

func mcpCall(t *testing.T, session *mcp.ClientSession, name string, args M, wantError string) M {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatal(name, err)
	}
	if wantError != "" {
		if !result.IsError || !strings.Contains(js(result.Content), wantError) {
			t.Fatalf("%s: wanted %s, got %s", name, wantError, js(result))
		}
		return nil
	}
	if result.IsError {
		t.Fatalf("%s: %s", name, js(result.Content))
	}
	data, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var output M
	if err := json.Unmarshal(data, &output); err != nil {
		t.Fatal(err)
	}
	return output
}

func TestMCPDeliverySnapshotsConflictsAndScope(t *testing.T) {
	c, workspace, settings, session := mcpSetup(t)
	tools, err := session.ListTools(context.Background(), nil)
	if err != nil || len(tools.Tools) != 4 {
		t.Fatal("discovery", tools, err)
	}
	input := M{"title": "并发方案", "content": "# 并发方案\n\n先读取版本，再保存文档。", "clientRequestId": id()}
	created := mcpCall(t, session, "create_document", input, "")
	if retry := mcpCall(t, session, "create_document", input, ""); js(retry) != js(created) {
		t.Fatal("retry created a duplicate", retry)
	}
	changed := M{"title": input["title"], "content": "另一个请求", "clientRequestId": input["clientRequestId"]}
	mcpCall(t, session, "create_document", changed, "REVISION_CONFLICT")
	listed := mcpCall(t, session, "list_documents", M{}, "")
	if len(arr(listed, "documents")) != 1 {
		t.Fatal(listed)
	}
	read := mcpCall(t, session, "read_document", M{"documentId": created["documentId"]}, "")
	if read["content"] != input["content"] || obj(read, "document")["versionId"] != created["versionId"] {
		t.Fatal(read)
	}

	book := c.documents(workspace)[0]
	prepared := c.prepare(book)
	if obj(prepared, "version")["id"] != created["versionId"] {
		t.Fatal("reader opened a different snapshot", prepared)
	}
	sample := c.extraction(workspace, book, prepared, "", "先读取版本，再保存文档。")
	note := c.annotate(sample, M{"body": "保留我的阅读笔记", "recipient": "note"}, "")
	oldSource, _ := one(c.s.db, "SELECT root FROM sources WHERE id=(SELECT source_id FROM source_entries WHERE id=(SELECT source_entry_id FROM mcp_documents WHERE workspace_document_id=?))", created["documentId"])

	var group sync.WaitGroup
	results := make(chan *mcp.CallToolResult, 2)
	for _, text := range []string{"# 版本二\nAlpha", "# 版本二\nBeta"} {
		group.Add(1)
		go func(content string) {
			defer group.Done()
			result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "update_document", Arguments: M{"documentId": created["documentId"], "expectedRevision": created["revision"], "content": content, "clientRequestId": id()}})
			if err != nil {
				t.Error(err)
				return
			}
			results <- result
		}(text)
	}
	group.Wait()
	close(results)
	successes, conflicts := 0, 0
	for result := range results {
		if result.IsError {
			if !strings.Contains(js(result.Content), "VERSION_CHANGED") {
				t.Fatal(js(result))
			}
			conflicts++
		} else {
			successes++
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal(successes, conflicts)
	}
	if bytes, err := os.ReadFile(filepath.Join(str(oldSource, "root"), str(created, "title"))); err != nil || string(bytes) != input["content"] {
		t.Fatal("old original changed", err)
	}
	if _, err := one(c.s.db, "SELECT id FROM messages WHERE id=? AND body=?", note["messageId"], "保留我的阅读笔记"); err != nil {
		t.Fatal("note lost", note, err)
	}

	current := mcpCall(t, session, "read_document", M{"documentId": created["documentId"]}, "")
	revert := M{"documentId": created["documentId"], "expectedRevision": obj(current, "document")["revision"], "title": "../../回到初稿", "content": input["content"], "clientRequestId": id()}
	reverted := mcpCall(t, session, "update_document", revert, "")
	if reverted["versionId"] != created["versionId"] || strings.ContainsAny(str(reverted, "title"), "/\\") {
		t.Fatal(reverted)
	}
	if retry := mcpCall(t, session, "update_document", revert, ""); js(retry) != js(reverted) {
		t.Fatal("update retry", retry)
	}
	// Reusing an old content hash must not make the initial revision valid again.
	mcpCall(t, session, "update_document", M{"documentId": created["documentId"], "expectedRevision": created["revision"], "content": "stale client", "clientRequestId": id()}, "VERSION_CHANGED")
	search := c.ok("GET", "/api/workspaces/"+str(workspace, "id")+"/search?q=先读取版本", nil)
	if len(arr(search, "items")) != 1 {
		t.Fatal("reverted version is not searchable", search)
	}
	rec := httptest.NewRecorder()
	syncRequest := httptest.NewRequest("GET", "http://127.0.0.1/api/sync/library", nil)
	syncRequest = syncRequest.WithContext(context.WithValue(syncRequest.Context(), deviceContextKey{}, M{"id": id(), "workspaceIds": []any{workspace["id"]}, "expiresAt": time.Now().Add(time.Hour).Unix()}))
	if err := c.s.syncLibrary(rec, syncRequest); err != nil {
		t.Fatal(err)
	}
	var library M
	json.Unmarshal(rec.Body.Bytes(), &library)
	synced := arr(arr(library, "workspaces")[0].(M), "documents")[0].(M)
	if obj(synced, "version")["id"] != created["versionId"] {
		t.Fatal("sync picked a historical revision", synced)
	}

	other := c.workspace("其他工作区")
	privateRoot := t.TempDir()
	os.WriteFile(filepath.Join(privateRoot, "私人资料.md"), []byte("不能通过 MCP 读取"), 0600)
	c.source(workspace, privateRoot)
	for _, document := range c.documents(workspace) {
		if document["id"] != created["documentId"] {
			mcpCall(t, session, "read_document", M{"documentId": document["id"]}, "NOT_FOUND")
			mcpCall(t, session, "update_document", M{"documentId": document["id"], "expectedRevision": created["revision"], "content": "禁止改写原文件", "clientRequestId": id()}, "MCP_DOCUMENT_REQUIRED")
		}
	}
	c.ok("PUT", "/api/mcp/settings", M{"enabled": true, "port": settings["port"], "workspaceId": other["id"]})
	mcpCall(t, session, "read_document", M{"documentId": created["documentId"]}, "NOT_FOUND")
	if got := mcpCall(t, session, "list_documents", M{}, ""); len(arr(got, "documents")) != 0 {
		t.Fatal("workspace leaked", got)
	}
}

func TestMCPAuthenticationRotationPortAndRestart(t *testing.T) {
	c, workspace, settings, session := mcpSetup(t)
	endpoint, token := str(settings, "url"), str(settings, "token")
	// Exercise the initialize-era wire protocol used by older Codex/Cursor
	// clients as well as the current SDK client used elsewhere in these tests.
	for _, version := range []string{"2025-06-18", "2025-11-25"} {
		for _, message := range []M{
			{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": M{"protocolVersion": version, "capabilities": M{}, "clientInfo": M{"name": "legacy-client", "version": "1"}}},
			{"jsonrpc": "2.0", "method": "notifications/initialized"},
			{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": M{}},
		} {
			request, _ := http.NewRequest("POST", endpoint, strings.NewReader(js(message)))
			request.Header.Set("Authorization", "Bearer "+token)
			request.Header.Set("Accept", "application/json, text/event-stream")
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("MCP-Protocol-Version", version)
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			data, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if str(message, "method") == "notifications/initialized" {
				if response.StatusCode != 202 {
					t.Fatal(version, response.StatusCode, string(data))
				}
				continue
			}
			var result M
			if err := json.Unmarshal(data, &result); err != nil || response.StatusCode != 200 || result["error"] != nil {
				t.Fatal(version, response.StatusCode, string(data), err)
			}
			if str(message, "method") == "tools/list" && len(arr(obj(result, "result"), "tools")) != 4 {
				t.Fatal("legacy discovery", result)
			}
		}
	}
	for _, test := range []struct {
		token, origin, host string
		want                int
	}{
		{"", "", "", 401}, {"wrong", "", "", 401}, {token, "https://evil.invalid", "", 403}, {token, "", "evil.invalid:7319", 403},
	} {
		r, _ := http.NewRequest("POST", endpoint, strings.NewReader(`{"jsonrpc":"2.0","method":"ping","id":1}`))
		r.AddCookie(c.cookie)
		r.Header.Set("Authorization", "Bearer "+test.token)
		r.Header.Set("Origin", test.origin)
		if test.host != "" {
			r.Host = test.host
		}
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != test.want {
			t.Fatal(test, response.StatusCode)
		}
	}
	configData, err := os.ReadFile(filepath.Join(c.s.cfg.DataDir, ".mcp.json"))
	if err != nil || strings.Contains(string(configData), token) || !strings.Contains(string(configData), digest([]byte(token))) {
		t.Fatal("invalid credential storage", err)
	}
	public := c.ok("GET", "/api/mcp/settings", nil)
	if strings.Contains(js(public), token) || strings.Contains(js(public), digest([]byte(token))) {
		t.Fatal("GET leaked key", public)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	status, _ := c.req("PUT", "/api/mcp/settings", M{"enabled": true, "port": listener.Addr().(*net.TCPAddr).Port, "workspaceId": workspace["id"]})
	if status != 409 {
		t.Fatal("occupied port accepted", status)
	}
	mcpCall(t, session, "list_documents", M{}, "")
	rotated := c.ok("POST", "/api/mcp/token", M{})
	oldKeyRequest, _ := http.NewRequest("POST", endpoint, strings.NewReader("{}"))
	oldKeyRequest.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(oldKeyRequest)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("old key still valid", response.StatusCode)
	}
	session.Close()
	dir := c.s.cfg.DataDir
	c.s.Close()
	restarted, err := New(Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { restarted.Close() })
	if restarted.mcpStatus()["url"] != endpoint || restarted.mcpStatus()["running"] != true {
		t.Fatal(restarted.mcpStatus())
	}
	reconnected := mcpConnect(t, endpoint, str(rotated, "token"))
	mcpCall(t, reconnected, "list_documents", M{}, "")
	reconnected.Close()
	restarted.Close()
	if _, err := net.DialTimeout("tcp4", strings.TrimSuffix(strings.TrimPrefix(endpoint, "http://"), "/mcp"), time.Second); err == nil {
		t.Fatal("listener survived shutdown")
	}
}

func TestMCPBackupRestoreValidationAndFailedCommit(t *testing.T) {
	c, workspace, settings, session := mcpSetup(t)
	for _, input := range []M{
		{"title": "空白", "content": " ", "clientRequestId": id()},
		{"title": "超长", "content": strings.Repeat("a", mcpMaxText+1), "clientRequestId": id()},
		{"title": "格式", "content": "文档", "format": "pdf", "clientRequestId": id()},
		{"title": "编号", "content": "文档", "clientRequestId": ""},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "create_document", Arguments: input})
		cancel()
		if err != nil || !result.IsError {
			t.Fatal("invalid input accepted", err, result)
		}
	}
	created := mcpCall(t, session, "create_document", M{"title": "备份测试", "format": "txt", "content": "从 MCP 投递且从未打开的文档", "clientRequestId": id()}, "")
	if err := exec(c.s.db, "CREATE TRIGGER fail_mcp_update BEFORE UPDATE ON mcp_documents BEGIN SELECT RAISE(ABORT,'injected failure'); END"); err != nil {
		t.Fatal(err)
	}
	mcpCall(t, session, "update_document", M{"documentId": created["documentId"], "expectedRevision": created["revision"], "content": "提交失败不能替换原文", "clientRequestId": id()}, "OPERATION_FAILED")
	exec(c.s.db, "DROP TRIGGER fail_mcp_update")
	if read := mcpCall(t, session, "read_document", M{"documentId": created["documentId"]}, ""); read["content"] != "从 MCP 投递且从未打开的文档" {
		t.Fatal(read)
	}
	if len(c.documents(workspace)) != 1 {
		t.Fatal("failed writes left members")
	}
	backup := c.ok("POST", "/api/backups", M{})
	archive := filepath.Join(c.s.cfg.DataDir, "backups", str(backup, "id")+".zip")
	zipfile, err := zip.OpenReader(archive)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range zipfile.File {
		if strings.Contains(entry.Name, "mcp.json") {
			t.Fatal("connection configuration entered backup")
		}
		file, _ := entry.Open()
		data, _ := io.ReadAll(file)
		file.Close()
		if strings.Contains(string(data), str(settings, "token")) || strings.Contains(string(data), digest([]byte(str(settings, "token")))) {
			t.Fatal("credential entered backup")
		}
	}
	zipfile.Close()
	other := newClient(t, Config{})
	preview, err := other.s.restorePreview(archive)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := other.s.restoreCommit(str(preview, "id"))
	if err != nil {
		t.Fatal(err)
	}
	ws := restored["workspaceIds"].([]string)[0]
	connection := other.ok("PUT", "/api/mcp/settings", M{"enabled": true, "port": mcpFreePort(t), "workspaceId": ws})
	client := mcpConnect(t, str(connection, "url"), str(connection, "token"))
	document := arr(mcpCall(t, client, "list_documents", M{}, ""), "documents")[0].(M)
	read := mcpCall(t, client, "read_document", M{"documentId": document["documentId"]}, "")
	if read["content"] != "从 MCP 投递且从未打开的文档" {
		t.Fatal(read)
	}
	updated := mcpCall(t, client, "update_document", M{"documentId": document["documentId"], "expectedRevision": document["revision"], "content": "恢复后继续编辑", "clientRequestId": id()}, "")
	book := other.documents(M{"id": ws})[0]
	prepared := other.prepare(book)
	if obj(prepared, "version")["id"] != updated["versionId"] {
		t.Fatal("restored source not rehydrated", prepared)
	}
}

func TestMCPSettingsRequireSessionAndCSRF(t *testing.T) {
	c := newClient(t, Config{})
	for _, csrf := range []string{"", "wrong"} {
		r := httptest.NewRequest("PUT", "http://127.0.0.1:7318/api/mcp/settings", strings.NewReader(`{"enabled":true,"port":7319}`))
		r.AddCookie(c.cookie)
		r.Header.Set("X-CSRF-Token", csrf)
		w := httptest.NewRecorder()
		c.s.Handler().ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal(w.Code)
		}
	}
	remote := newClient(t, Config{PublicOrigin: "https://reader.example.invalid", AccessCode: strings.Repeat("a", 32)})
	if status, _ := remote.req("PUT", "/api/mcp/settings", M{"enabled": true, "port": 7319}); status != 403 {
		t.Fatal("cloud exposed local MCP", status)
	}
}
