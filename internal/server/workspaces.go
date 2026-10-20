package server

import (
	"database/sql"
	"net/http"
	"strings"
)

func (s *Server) workspaceRoutes() {
	s.route("GET /api/requests/{k}", func(w http.ResponseWriter, r *http.Request) error {
		v, e := one(s.db, "SELECT response_json FROM idempotency WHERE scope=? AND key=?", r.URL.Query().Get("scope"), r.PathValue("k"))
		if e != nil {
			return e
		}
		return send(w, v["response"])
	})
	s.route("GET /api/workspaces", func(w http.ResponseWriter, r *http.Request) error {
		v, e := all(s.db, "SELECT * FROM workspaces ORDER BY created_at")
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("POST /api/workspaces", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		name := strings.TrimSpace(str(b, "name"))
		if name == "" || len([]rune(name)) > 60 {
			return problem(400, "INVALID_NAME", "请输入 1 至 60 字工作区名称", false)
		}
		v := M{"id": id(), "name": name, "revision": 1, "createdAt": now()}
		e = s.transaction(func(tx *sql.Tx) error {
			return exec(tx, "INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)", v["id"], name, v["createdAt"])
		})
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("PATCH /api/workspaces/{w}", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		name := strings.TrimSpace(str(b, "name"))
		if name == "" || len([]rune(name)) > 60 {
			return problem(400, "INVALID_NAME", "工作区名称无效", false)
		}
		e = s.transaction(func(tx *sql.Tx) error {
			return checkRevision(tx, "workspaces", r.PathValue("w"), num(b, "revision"), M{"name": name})
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("GET /api/workspaces/{w}/deletion-preview", func(w http.ResponseWriter, r *http.Request) error {
		v, e := one(s.db, "SELECT w.name,(SELECT count(*) FROM sources WHERE workspace_id=w.id) AS sources,(SELECT count(*) FROM annotations a JOIN workspace_documents wd ON wd.id=a.workspace_document_id WHERE wd.workspace_id=w.id) AS annotations FROM workspaces w WHERE w.id=?", r.PathValue("w"))
		if e != nil {
			return e
		}
		v["originalFilesDeleted"] = false
		return send(w, v)
	})
	s.route("DELETE /api/workspaces/{w}", func(w http.ResponseWriter, r *http.Request) error {
		if r.URL.Query().Get("confirm") != "delete-learning-data" {
			return problem(400, "CONFIRM_REQUIRED", "请确认删除此工作区的全部学习数据", false)
		}
		e := s.transaction(func(tx *sql.Tx) error {
			if _, e := one(tx, "SELECT id FROM ai_runs WHERE state IN ('queued','preparing','generating') AND snapshot_id IN (SELECT c.id FROM contexts c JOIN workspace_documents wd ON wd.id=c.workspace_document_id WHERE wd.workspace_id=?) LIMIT 1", r.PathValue("w")); e == nil {
				return problem(409, "RUN_ACTIVE", "请先停止此工作区的问答", false)
			}
			if e := exec(tx, "DELETE FROM workspace_documents WHERE workspace_id=?", r.PathValue("w")); e != nil {
				return e
			}
			if e := exec(tx, "DELETE FROM manifests WHERE source_entry_id IN(SELECT e.id FROM source_entries e JOIN sources s ON s.id=e.source_id WHERE s.workspace_id=?)", r.PathValue("w")); e != nil {
				return e
			}
			return exec(tx, "DELETE FROM workspaces WHERE id=?", r.PathValue("w"))
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("GET /api/workspaces/{w}/documents", func(w http.ResponseWriter, r *http.Request) error {
		v, next, e := s.listDocuments(r)
		if e != nil {
			return e
		}
		for _, m := range v {
			bindings, err := all(s.db, "SELECT e.*,s.label AS source_label,s.state AS source_state,b.state AS binding_state FROM document_bindings b JOIN source_entries e ON e.id=b.source_entry_id JOIN sources s ON s.id=e.source_id WHERE b.workspace_document_id=? ORDER BY (e.state='active' AND b.state='active' AND s.state='active') DESC,e.relative_path", m["id"])
			if err != nil {
				return err
			}
			m["bindings"] = bindings
			state, _ := one(s.db, "SELECT * FROM reading_states WHERE workspace_document_id=?", m["id"])
			m["readingState"] = state
		}
		return send(w, M{"items": v, "nextCursor": next})
	})
	s.route("GET /api/documents/{m}", func(w http.ResponseWriter, r *http.Request) error {
		m, e := s.member(s.db, r.PathValue("m"))
		if e != nil {
			return e
		}
		bindings, e := all(s.db, "SELECT e.*,s.label AS source_label,s.state AS source_state,b.state AS binding_state FROM document_bindings b JOIN source_entries e ON e.id=b.source_entry_id JOIN sources s ON s.id=e.source_id WHERE b.workspace_document_id=? ORDER BY (e.state='active' AND b.state='active' AND s.state='active') DESC,e.relative_path", m["id"])
		if e != nil {
			return e
		}
		m["bindings"] = bindings
		return send(w, m)
	})
	s.route("GET /api/preferences", func(w http.ResponseWriter, r *http.Request) error {
		v, e := one(s.db, "SELECT data_json FROM preferences WHERE id='personal'")
		if isNotFound(e) {
			return send(w, M{})
		}
		if e != nil {
			return e
		}
		return send(w, v["data"])
	})
	s.route("PUT /api/preferences", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		e = s.transaction(func(tx *sql.Tx) error {
			previous, err := one(tx, "SELECT data_json FROM preferences WHERE id='personal'")
			if err != nil && !isNotFound(err) {
				return err
			}
			merged := obj(previous, "data")
			for k, v := range b {
				if k == "lastDocuments" {
					last := obj(merged, k)
					for ws, doc := range obj(b, k) {
						last[ws] = doc
					}
					merged[k] = last
				} else {
					merged[k] = v
				}
			}
			return exec(tx, "INSERT INTO preferences VALUES('personal',?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json", js(merged))
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
}
