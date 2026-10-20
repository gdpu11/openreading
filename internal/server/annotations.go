package server

import (
	"database/sql"
	"math"
	"net/http"
	"strings"
	"unicode/utf8"
)

func (s *Server) manifestMember(q querier, manifest, member, version string) error {
	if manifest == "" {
		return nil
	}
	_, e := one(q, "SELECT m.id FROM manifests m JOIN document_bindings b ON b.source_entry_id=m.source_entry_id JOIN workspace_documents wd ON wd.id=b.workspace_document_id JOIN sources s ON s.id=(SELECT source_id FROM source_entries WHERE id=m.source_entry_id) WHERE m.id=? AND wd.id=? AND m.version_id=? AND s.workspace_id=wd.workspace_id", manifest, member, version)
	if e != nil {
		return problem(403, "PATH_NOT_ALLOWED", "资源清单不属于当前工作区绑定", false)
	}
	return nil
}
func (s *Server) validateAnchor(q querier, member, version string, a M) error {
	v, e := s.memberVersion(q, member, version)
	if e != nil {
		return e
	}
	if num(a, "schemaVersion") != 1 || str(a, "workspaceDocumentId") != member || str(a, "documentVersionId") != version {
		return problem(400, "INVALID_ANCHOR", "选区身份不一致", false)
	}
	artifact, e := one(q, "SELECT * FROM artifacts WHERE id=? AND version_id=?", a["extractionArtifactId"], version)
	if e != nil {
		return problem(400, "INVALID_ANCHOR", "选区提取产物不存在或版本不匹配", false)
	}
	if artifact["parserVersion"] != a["parserVersion"] || artifact["normalizationVersion"] != a["normalizationVersion"] {
		return problem(400, "INVALID_ANCHOR", "选区解析版本不匹配", false)
	}
	if e = s.manifestMember(q, str(a, "resourceManifestId"), member, version); e != nil {
		return e
	}
	kind := str(a, "targetKind")
	if kind == "page" {
		if str(v, "format") != "pdf" || str(obj(a, "quote"), "exact") != "" || num(obj(a, "displayLocation"), "pageIndex") < 0 {
			return problem(400, "INVALID_ANCHOR", "页级笔记定位不合法", false)
		}
		return nil
	}
	if kind != "text" {
		return problem(400, "INVALID_ANCHOR", "不支持此选区类型", false)
	}
	quote := obj(a, "quote")
	exact := str(quote, "exact")
	if str(quote, "visible") != exact {
		return problem(400, "INVALID_ANCHOR", "可见摘录与规范选段不一致", false)
	}
	if exact == "" || utf8.RuneCountInString(exact) > 20000 {
		return problem(400, "INVALID_ANCHOR", "选区为空或过长", false)
	}
	found := false
	native := false
	for _, raw := range arr(a, "selectors") {
		sel, ok := raw.(map[string]any)
		if !ok {
			return problem(400, "INVALID_ANCHOR", "选区定位器格式错误", false)
		}
		switch str(sel, "type") {
		case "text":
			for _, block := range arr(artifact, "blocks") {
				b, _ := block.(map[string]any)
				if str(b, "id") == str(sel, "block") {
					r := []rune(str(b, "text"))
					start, end := num(sel, "start"), num(sel, "end")
					if start < 0 || end <= start || end > len(r) || string(r[start:end]) != exact {
						return problem(400, "INVALID_ANCHOR", "选段与已保存提取文本不一致", false)
					}
					prefix, suffix := str(quote, "prefix"), str(quote, "suffix")
					if !strings.HasSuffix(string(r[:start]), prefix) || !strings.HasPrefix(string(r[end:]), suffix) {
						return problem(400, "INVALID_ANCHOR", "选段上下文不匹配", false)
					}
					found = true
				}
			}
		case "pdf":
			if str(v, "format") != "pdf" || num(sel, "pageIndex") < 0 || len(arr(sel, "quads")) == 0 || len(arr(sel, "quads")) > 500 {
				return problem(400, "INVALID_ANCHOR", "PDF 坐标无效", false)
			}
			for _, quad := range arr(sel, "quads") {
				coords, ok := quad.([]any)
				if !ok || len(coords) != 8 {
					return problem(400, "INVALID_ANCHOR", "PDF 四边形无效", false)
				}
				for _, n := range coords {
					x, ok := n.(float64)
					if !ok || math.IsNaN(x) || math.IsInf(x, 0) || math.Abs(x) > 1e6 {
						return problem(400, "INVALID_ANCHOR", "PDF 坐标越界", false)
					}
				}
			}
			native = true
		case "epub":
			if str(v, "format") != "epub" || !strings.HasPrefix(str(sel, "cfi"), "epubcfi(") || len(str(sel, "cfi")) > 10000 {
				return problem(400, "INVALID_ANCHOR", "EPUB CFI 无效", false)
			}
			native = true
		default:
			return problem(400, "INVALID_ANCHOR", "未知定位器", false)
		}
	}
	if !found || ((str(v, "format") == "pdf" || str(v, "format") == "epub") && !native) {
		return problem(400, "INVALID_ANCHOR", "选区缺少必要定位数据", false)
	}
	return nil
}
func validStyle(m M) M {
	colors := map[string]bool{"#e8cb76": true, "#b8d8c6": true, "#c6c3e3": true, "#e8b9a6": true}
	color := str(m, "color")
	if !colors[color] {
		color = "#e8cb76"
	}
	underline, _ := m["underline"].(bool)
	return M{"color": color, "underline": underline}
}
func (s *Server) threadData(q querier, where string, args ...any) ([]M, error) {
	threads, e := all(q, "SELECT a.*,t.id AS thread_id,t.learning_state,t.revision AS thread_revision FROM annotations a JOIN threads t ON t.annotation_id=a.id "+where+" ORDER BY a.created_at", args...)
	if e != nil {
		return nil, e
	}
	for _, t := range threads {
		messages, e := all(q, "SELECT * FROM messages WHERE thread_id=? ORDER BY created_at,id", t["threadId"])
		if e != nil {
			return nil, e
		}
		for _, m := range messages {
			if str(m, "role") == "assistant" {
				run, e := one(q, "SELECT r.*,json_extract(c.config_json,'$.protocol') AS protocol FROM ai_runs r JOIN contexts c ON c.id=r.snapshot_id WHERE r.assistant_message_id=? ORDER BY r.created_at DESC LIMIT 1", m["id"])
				if e == nil {
					m["run"] = run
				} else if !isNotFound(e) {
					return nil, e
				}
			}
		}
		t["messages"] = messages
		t["resolutions"], e = all(q, "SELECT * FROM resolutions WHERE annotation_id=?", t["id"])
		if e != nil {
			return nil, e
		}
	}
	return threads, nil
}
func (s *Server) addMessage(tx *sql.Tx, thread M, message M) (M, error) {
	body := strings.TrimSpace(str(message, "body"))
	if body == "" || utf8.RuneCountInString(body) > 30000 {
		return nil, problem(400, "INVALID_MESSAGE", "请输入问题或笔记，最多 30000 字", false)
	}
	recipient := str(message, "recipient")
	if recipient != "note" && recipient != "assistant" {
		return nil, problem(400, "INVALID_RECIPIENT", "请选择记笔记或显式提及小阅", false)
	}
	messageID := id()
	if e := exec(tx, "INSERT INTO messages(id,thread_id,role,recipient,body,created_at) VALUES(?,?,'user',?,?,?)", messageID, thread["threadId"], recipient, body, now()); e != nil {
		return nil, e
	}
	result := M{"threadId": thread["threadId"], "messageId": messageID}
	if recipient == "assistant" {
		run, e := s.queueQuestion(tx, thread, messageID, message)
		if e != nil {
			return nil, e
		}
		result["runId"] = run["id"]
		result["snapshotId"] = run["snapshotId"]
	}
	return result, nil
}
func (s *Server) annotationRoutes() {
	s.route("DELETE /api/threads/{t}", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		e = s.transaction(func(tx *sql.Tx) error {
			thread, e := one(tx, "SELECT * FROM threads WHERE id=?", r.PathValue("t"))
			if e != nil {
				return e
			}
			if num(thread, "revision") != num(b, "revision") {
				return problem(409, "REVISION_CONFLICT", "批注已在另一标签更新，请重新载入", false)
			}
			active, e := all(tx, "SELECT r.id FROM ai_runs r JOIN messages m ON m.id=r.message_id WHERE m.thread_id=? AND r.state IN ('queued','preparing','generating')", thread["id"])
			if e != nil {
				return e
			}
			if len(active) > 0 {
				return problem(409, "RUN_ACTIVE", "请先停止此线程的问答，再删除批注", false)
			}
			contexts, e := all(tx, "SELECT DISTINCT r.snapshot_id FROM ai_runs r JOIN messages m ON m.id=r.message_id WHERE m.thread_id=?", thread["id"])
			if e != nil {
				return e
			}
			if e = exec(tx, "DELETE FROM annotations WHERE id=?", thread["annotationId"]); e != nil {
				return e
			}
			for _, c := range contexts {
				if e = exec(tx, "DELETE FROM contexts WHERE id=? AND NOT EXISTS(SELECT 1 FROM ai_runs r WHERE r.snapshot_id=contexts.id)", c["snapshotId"]); e != nil {
					return e
				}
			}
			return nil
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("GET /api/documents/{m}/threads", func(w http.ResponseWriter, r *http.Request) error {
		if _, e := s.member(s.db, r.PathValue("m")); e != nil {
			return e
		}
		v, e := s.threadData(s.db, "WHERE a.workspace_document_id=?", r.PathValue("m"))
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("GET /api/workspaces/{w}/notes", func(w http.ResponseWriter, r *http.Request) error {
		v, e := s.threadData(s.db, "JOIN workspace_documents wd ON wd.id=a.workspace_document_id WHERE wd.workspace_id=?", r.PathValue("w"))
		if e != nil {
			return e
		}
		for _, t := range v {
			name, _ := one(s.db, "SELECT e.relative_path FROM source_entries e JOIN document_bindings b ON b.source_entry_id=e.id WHERE b.workspace_document_id=? LIMIT 1", t["workspaceDocumentId"])
			t["title"] = name["relativePath"]
		}
		return send(w, v)
	})
	s.route("POST /api/threads", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		result, e := s.idem("create-thread", str(b, "clientRequestId"), b, func(tx *sql.Tx) (M, error) {
			anchor := obj(b, "selectionSnapshot")
			member, version := str(b, "workspaceDocumentId"), str(b, "documentVersionId")
			if e := s.validateAnchor(tx, member, version, anchor); e != nil {
				return nil, e
			}
			annotationID, threadID := id(), id()
			var manifest any
			if x := str(anchor, "resourceManifestId"); x != "" {
				manifest = x
			}
			if e := exec(tx, "INSERT INTO annotations(id,workspace_document_id,original_version_id,artifact_id,manifest_id,anchor_json,style_json,created_at) VALUES(?,?,?,?,?,?,?,?)", annotationID, member, version, anchor["extractionArtifactId"], manifest, js(anchor), js(validStyle(obj(b, "style"))), now()); e != nil {
				return nil, e
			}
			if e := exec(tx, "INSERT INTO threads(id,annotation_id,created_at) VALUES(?,?,?)", threadID, annotationID, now()); e != nil {
				return nil, e
			}
			result := M{"annotationId": annotationID, "threadId": threadID}
			if len(obj(b, "message")) > 0 {
				t, e := s.threadData(tx, "WHERE t.id=?", threadID)
				if e != nil {
					return nil, e
				}
				v, e := s.addMessage(tx, t[0], obj(b, "message"))
				if e != nil {
					return nil, e
				}
				for k, value := range v {
					result[k] = value
				}
			}
			if draft := str(b, "draftId"); draft != "" {
				if e := exec(tx, "DELETE FROM drafts WHERE id=? AND workspace_document_id=?", draft, member); e != nil {
					return nil, e
				}
			}
			return result, nil
		})
		if e != nil {
			return e
		}
		return send(w, result)
	})
	s.route("POST /api/threads/{t}/messages", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		result, e := s.idem("message:"+r.PathValue("t"), str(b, "clientRequestId"), b, func(tx *sql.Tx) (M, error) {
			t, e := s.threadData(tx, "WHERE t.id=?", r.PathValue("t"))
			if e != nil {
				return nil, e
			}
			if len(t) == 0 {
				return nil, problem(404, "NOT_FOUND", "批注不存在", false)
			}
			result, e := s.addMessage(tx, t[0], obj(b, "message"))
			if e != nil {
				return nil, e
			}
			if draft := str(b, "draftId"); draft != "" {
				if e := exec(tx, "DELETE FROM drafts WHERE id=? AND workspace_document_id=?", draft, t[0]["workspaceDocumentId"]); e != nil {
					return nil, e
				}
			}
			return result, nil
		})
		if e != nil {
			return e
		}
		return send(w, result)
	})
	s.route("PATCH /api/threads/{t}", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		state := str(b, "learningState")
		if state != "待理解" && state != "已理解" && state != "待复习" {
			return problem(400, "INVALID_STATE", "学习状态无效", false)
		}
		e = s.transaction(func(tx *sql.Tx) error {
			return checkRevision(tx, "threads", r.PathValue("t"), num(b, "revision"), M{"learning_state": state})
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("PATCH /api/annotations/{a}", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		e = s.transaction(func(tx *sql.Tx) error {
			return checkRevision(tx, "annotations", r.PathValue("a"), num(b, "revision"), M{"style_json": js(validStyle(obj(b, "style")))})
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("POST /api/annotations/{a}/relocate", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		e = s.transaction(func(tx *sql.Tx) error {
			a, e := one(tx, "SELECT * FROM annotations WHERE id=?", r.PathValue("a"))
			if e != nil {
				return e
			}
			anchor := obj(b, "anchor")
			version := str(anchor, "documentVersionId")
			if e = s.validateAnchor(tx, str(a, "workspaceDocumentId"), version, anchor); e != nil {
				return e
			}
			if e = checkRevision(tx, "annotations", str(a, "id"), num(b, "revision"), M{}); e != nil {
				return e
			}
			return exec(tx, "INSERT INTO resolutions VALUES(?,?,?,'resolved','manual') ON CONFLICT(annotation_id,target_version_id) DO UPDATE SET selector_json=excluded.selector_json,state='resolved',method='manual'", a["id"], version, js(M{"anchor": anchor}))
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("PATCH /api/messages/{m}", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		if len(str(b, "body")) > 120000 || strings.TrimSpace(str(b, "body")) == "" {
			return problem(400, "INVALID_MESSAGE", "笔记为空或过长", false)
		}
		e = s.transaction(func(tx *sql.Tx) error {
			m, e := one(tx, "SELECT * FROM messages WHERE id=? AND role='user'", r.PathValue("m"))
			if e != nil {
				return e
			}
			if e = checkRevision(tx, "messages", str(m, "id"), num(b, "revision"), M{"body": str(b, "body"), "version": num(m, "version") + 1}); e != nil {
				return e
			}
			return exec(tx, "INSERT INTO message_versions VALUES(?,?,?,?)", m["id"], m["version"], m["body"], now())
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("GET /api/documents/{m}/reading-state", func(w http.ResponseWriter, r *http.Request) error {
		v, e := one(s.db, "SELECT * FROM reading_states WHERE workspace_document_id=?", r.PathValue("m"))
		if isNotFound(e) {
			return send(w, M{})
		}
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("PUT /api/documents/{m}/reading-state", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		e = s.transaction(func(tx *sql.Tx) error {
			if _, e := s.memberVersion(tx, r.PathValue("m"), str(b, "versionId")); e != nil {
				return e
			}
			return exec(tx, "INSERT INTO reading_states VALUES(?,?,?,?) ON CONFLICT(workspace_document_id) DO UPDATE SET version_id=excluded.version_id,locator_json=excluded.locator_json,updated_at=excluded.updated_at", r.PathValue("m"), b["versionId"], js(obj(b, "locator")), now())
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("GET /api/drafts/{d}", func(w http.ResponseWriter, r *http.Request) error {
		v, e := one(s.db, "SELECT * FROM drafts WHERE id=? AND workspace_document_id=?", r.PathValue("d"), r.URL.Query().Get("workspaceDocumentId"))
		if isNotFound(e) {
			return send(w, M{})
		}
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("PUT /api/drafts/{d}", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		var result M
		e = s.transaction(func(tx *sql.Tx) error {
			if _, e := s.member(tx, str(b, "workspaceDocumentId")); e != nil {
				return e
			}
			var thread any
			if t := str(b, "threadId"); t != "" {
				if _, e := one(tx, "SELECT t.id FROM threads t JOIN annotations a ON a.id=t.annotation_id WHERE t.id=? AND a.workspace_document_id=?", t, b["workspaceDocumentId"]); e != nil {
					return e
				}
				thread = t
			}
			old, e := one(tx, "SELECT * FROM drafts WHERE id=?", r.PathValue("d"))
			revision := 1
			if e == nil {
				if old["workspaceDocumentId"] != b["workspaceDocumentId"] {
					return problem(403, "PATH_NOT_ALLOWED", "草稿身份不匹配", false)
				}
				if num(old, "revision") != num(b, "revision") {
					return problem(409, "REVISION_CONFLICT", "草稿已在另一标签更新，请复制保留后重新载入", false)
				}
				revision = num(old, "revision") + 1
			} else if !isNotFound(e) {
				return e
			}
			if e = exec(tx, "INSERT INTO drafts VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,selection_json=excluded.selection_json,revision=excluded.revision,updated_at=excluded.updated_at", r.PathValue("d"), b["workspaceDocumentId"], thread, str(b, "body"), js(obj(b, "selection")), revision, now()); e != nil {
				return e
			}
			result = M{"revision": revision}
			return nil
		})
		if e != nil {
			return e
		}
		return send(w, result)
	})
	s.route("POST /api/documents/{m}/resolve", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		result := []M{}
		e = s.transaction(func(tx *sql.Tx) error {
			member := r.PathValue("m")
			artifact, e := one(tx, "SELECT * FROM artifacts WHERE id=?", b["artifactId"])
			if e != nil {
				return e
			}
			if _, e = s.memberVersion(tx, member, str(artifact, "versionId")); e != nil {
				return e
			}
			annotations, e := all(tx, "SELECT * FROM annotations WHERE workspace_document_id=? AND original_version_id<>?", member, artifact["versionId"])
			if e != nil {
				return e
			}
			for _, a := range annotations {
				anchor := obj(a, "anchor")
				quote := obj(anchor, "quote")
				candidates := []M{}
				for _, raw := range arr(artifact, "blocks") {
					block, _ := raw.(map[string]any)
					runes := []rune(str(block, "text"))
					exact := []rune(str(quote, "exact"))
					if len(exact) == 0 {
						continue
					}
					for start := 0; start+len(exact) <= len(runes); start++ {
						end := start + len(exact)
						if string(runes[start:end]) == string(exact) && strings.HasSuffix(string(runes[:start]), str(quote, "prefix")) && strings.HasPrefix(string(runes[end:]), str(quote, "suffix")) {
							newAnchor := M{}
							for k, v := range anchor {
								newAnchor[k] = v
							}
							newAnchor["documentVersionId"] = artifact["versionId"]
							newAnchor["extractionArtifactId"] = artifact["id"]
							newAnchor["resourceManifestId"] = nil
							newAnchor["selectors"] = []M{{"type": "text", "block": block["id"], "start": start, "end": end}}
							newAnchor["parserVersion"] = artifact["parserVersion"]
							newAnchor["normalizationVersion"] = artifact["normalizationVersion"]
							candidates = append(candidates, newAnchor)
						}
					}
				}
				state := "missing"
				selector := M{}
				if len(candidates) > 1 {
					state = "ambiguous"
				} else if len(candidates) == 1 {
					format, err := s.member(tx, member)
					if err != nil {
						return err
					}
					if str(format, "format") == "txt" || str(format, "format") == "markdown" {
						state = "resolved"
						selector["anchor"] = candidates[0]
					} else {
						state = "unsupported"
					}
				}
				existing, e := one(tx, "SELECT method FROM resolutions WHERE annotation_id=? AND target_version_id=?", a["id"], artifact["versionId"])
				if e == nil && str(existing, "method") == "manual" {
					continue
				}
				if e != nil && !isNotFound(e) {
					return e
				}
				if e = exec(tx, "INSERT INTO resolutions VALUES(?,?,?,?,?) ON CONFLICT(annotation_id,target_version_id) DO UPDATE SET selector_json=excluded.selector_json,state=excluded.state,method=excluded.method", a["id"], artifact["versionId"], js(selector), state, "unique-exact-full-context"); e != nil {
					return e
				}
				result = append(result, M{"annotationId": a["id"], "state": state, "candidates": len(candidates)})
			}
			return nil
		})
		if e != nil {
			return e
		}
		return send(w, M{"items": result})
	})
}
