package server

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

func (s *Server) searchRoutes() {
	s.route("PUT /api/documents/{m}/search-index", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		sections := arr(b, "sections")
		version := str(b, "versionId")
		if len(sections) > 20000 || len(js(sections)) > 6<<20 {
			return problem(413, "INDEX_TOO_LARGE", "索引内容过大，请按章节建立索引", false)
		}
		e = s.transaction(func(tx *sql.Tx) error {
			if _, e := s.memberVersion(tx, r.PathValue("m"), version); e != nil {
				return e
			}
			if b["replace"] == true {
				if e := exec(tx, "INSERT INTO search_indexes VALUES(?,0) ON CONFLICT(version_id) DO UPDATE SET complete=0", version); e != nil {
					return e
				}
				if e := exec(tx, "DELETE FROM search_sections WHERE version_id=?", version); e != nil {
					return e
				}
			}
			for _, raw := range sections {
				section, ok := raw.(map[string]any)
				if !ok || num(section, "position") < 0 || len(js(obj(section, "locator"))) > 8192 || utf8.RuneCountInString(str(section, "label")) > 300 {
					return problem(400, "INVALID_INDEX", "索引片段无效", false)
				}
				if e := exec(tx, "INSERT INTO search_sections VALUES(?,?,?,?,?) ON CONFLICT(version_id,position) DO UPDATE SET label=excluded.label,locator_json=excluded.locator_json,text=excluded.text", version, num(section, "position"), str(section, "label"), js(obj(section, "locator")), str(section, "text")); e != nil {
					return e
				}
			}
			if b["complete"] == true {
				return exec(tx, "INSERT INTO search_indexes VALUES(?,1) ON CONFLICT(version_id) DO UPDATE SET complete=1", version)
			}
			return nil
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("GET /api/workspaces/{w}/search", func(w http.ResponseWriter, r *http.Request) error {
		query := strings.TrimSpace(r.URL.Query().Get("q"))
		if query == "" || utf8.RuneCountInString(query) > 200 {
			return problem(400, "INVALID_SEARCH", "请输入 1 至 200 字关键词", false)
		}
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		if offset < 0 || offset > 100000 {
			return problem(400, "INVALID_SEARCH", "搜索分页无效", false)
		}
		sql := "SELECT ss.*,wd.id AS workspace_document_id,COALESCE((SELECT e.relative_path FROM document_bindings b JOIN source_entries e ON e.id=b.source_entry_id WHERE b.workspace_document_id=wd.id ORDER BY e.relative_path LIMIT 1),'') AS title FROM search_sections ss JOIN versions v ON v.id=ss.version_id JOIN workspace_documents wd ON wd.document_id=v.document_id LEFT JOIN library_books lb ON lb.workspace_document_id=wd.id WHERE ss.version_id IN(SELECT version_id FROM search_indexes WHERE complete=1) AND wd.workspace_id=? AND COALESCE(lb.removed_at,'')='' AND instr(lower(ss.text),lower(?))>0"
		args := []any{r.PathValue("w"), query}
		if member := r.URL.Query().Get("member"); member != "" {
			sql += " AND wd.id=?"
			args = append(args, member)
		}
		if version := r.URL.Query().Get("version"); version != "" {
			sql += " AND ss.version_id=?"
			args = append(args, version)
		} else {
			sql += " AND ss.version_id=(SELECT id FROM versions WHERE document_id=wd.document_id ORDER BY created_at DESC,id LIMIT 1)"
		}
		sql += " ORDER BY wd.id,ss.position LIMIT 101 OFFSET ?"
		args = append(args, offset)
		items, e := all(s.db, sql, args...)
		if e != nil {
			return e
		}
		more := len(items) > 100
		if more {
			items = items[:100]
		}
		for _, item := range items {
			text := []rune(str(item, "text"))
			at := strings.Index(strings.ToLower(string(text)), strings.ToLower(query))
			start := 0
			if at >= 0 {
				start = utf8.RuneCountInString(string(text)[:at]) - 70
			}
			if start < 0 {
				start = 0
			}
			end := start + 220
			if end > len(text) {
				end = len(text)
			}
			item["snippet"] = string(text[start:end])
			delete(item, "text")
		}
		indexed, e := one(s.db, "SELECT count(DISTINCT wd.id) AS count FROM workspace_documents wd JOIN versions v ON v.document_id=wd.document_id JOIN search_sections ss ON ss.version_id=v.id WHERE wd.workspace_id=? AND ss.version_id IN(SELECT version_id FROM search_indexes WHERE complete=1)", r.PathValue("w"))
		if e != nil {
			return e
		}
		return send(w, M{"items": items, "hasMore": more, "indexedBooks": indexed["count"]})
	})
}
