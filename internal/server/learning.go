package server

import (
	"database/sql"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

func (s *Server) saveLearning(tx *sql.Tx, member, thread string, b M) (M, error) {
	if _, e := one(tx, "SELECT t.id FROM threads t JOIN annotations a ON a.id=t.annotation_id WHERE t.id=? AND a.workspace_document_id=?", thread, member); e != nil {
		return nil, e
	}
	previous, e := one(tx, "SELECT * FROM note_learning WHERE id=?", thread)
	if e != nil && !isNotFound(e) {
		return nil, e
	}
	if num(b, "revision") != num(previous, "revision") {
		return nil, problem(409, "REVISION_CONFLICT", "学习记录已变化，请重新载入；当前修改仍保留", false)
	}
	tags := []string{}
	seen := map[string]bool{}
	if _, ok := b["tags"]; ok {
		if _, ok := b["tags"].([]any); !ok {
			return nil, problem(400, "INVALID_TAGS", "标签必须是数组", false)
		}
		if len(arr(b, "tags")) > 20 {
			return nil, problem(400, "INVALID_TAGS", "最多添加 20 个标签", false)
		}
		for _, raw := range arr(b, "tags") {
			tag, ok := raw.(string)
			tag = strings.TrimSpace(tag)
			if !ok || utf8.RuneCountInString(tag) > 40 || tag == "" {
				return nil, problem(400, "INVALID_TAGS", "标签需为 1 至 40 字", false)
			}
			if !seen[tag] {
				tags = append(tags, tag)
				seen[tag] = true
			}
		}
	} else {
		for _, v := range arr(previous, "tags") {
			if tag, ok := v.(string); ok {
				tags = append(tags, tag)
			}
		}
	}
	due, reviewed, days := str(previous, "dueAt"), str(previous, "reviewedAt"), num(previous, "intervalDays")
	switch str(b, "outcome") {
	case "":
	case "schedule", "again":
		days = 1
	case "good":
		if days < 1 {
			days = 1
		}
		days *= 2
		if days > 180 {
			days = 180
		}
	case "easy":
		if days < 1 {
			days = 1
		}
		days *= 4
		if days > 365 {
			days = 365
		}
	case "pause":
		due = ""
	default:
		return nil, problem(400, "INVALID_REVIEW", "复习结果无效", false)
	}
	if outcome := str(b, "outcome"); outcome != "" && outcome != "pause" {
		due = time.Now().UTC().AddDate(0, 0, days).Format(time.RFC3339Nano)
		if outcome != "schedule" {
			reviewed = now()
		} else {
			due = now()
		}
	}
	if e := exec(tx, "INSERT INTO note_learning VALUES(?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET tags_json=excluded.tags_json,due_at=excluded.due_at,interval_days=excluded.interval_days,reviewed_at=excluded.reviewed_at,revision=note_learning.revision+1", thread, js(tags), due, days, reviewed); e != nil {
		return nil, e
	}
	return one(tx, "SELECT * FROM note_learning WHERE id=?", thread)
}

func (s *Server) learningRoutes() {
	s.route("GET /api/documents/{m}/recognized-pages", func(w http.ResponseWriter, r *http.Request) error {
		version := r.URL.Query().Get("version")
		if _, e := s.memberVersion(s.db, r.PathValue("m"), version); e != nil {
			return e
		}
		rows, e := all(s.db, "SELECT * FROM recognized_pages WHERE version_id=? ORDER BY page_index", version)
		if e != nil {
			return e
		}
		return send(w, rows)
	})
	s.route("PUT /api/documents/{m}/recognized-pages", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		text := strings.TrimSpace(str(b, "text"))
		if text == "" || len(text) > 1<<20 || num(b, "pageIndex") < 0 || num(b, "pageIndex") > 100000 {
			return problem(400, "INVALID_OCR", "识别页码或文字无效", false)
		}
		e = s.transaction(func(tx *sql.Tx) error {
			m, e := s.memberVersion(tx, r.PathValue("m"), str(b, "versionId"))
			if e != nil {
				return e
			}
			if str(m, "format") != "pdf" {
				return problem(400, "INVALID_OCR", "仅支持 PDF 页面识别", false)
			}
			if e := exec(tx, "UPDATE search_indexes SET complete=0 WHERE version_id=?", b["versionId"]); e != nil {
				return e
			}
			return exec(tx, "INSERT INTO recognized_pages VALUES(?,?,?) ON CONFLICT(version_id,page_index) DO UPDATE SET text=excluded.text", b["versionId"], num(b, "pageIndex"), text)
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("PUT /api/threads/{t}/learning", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		var result M
		e = s.transaction(func(tx *sql.Tx) error {
			t, e := one(tx, "SELECT a.workspace_document_id FROM threads t JOIN annotations a ON a.id=t.annotation_id WHERE t.id=?", r.PathValue("t"))
			if e != nil {
				return e
			}
			result, e = s.saveLearning(tx, str(t, "workspaceDocumentId"), r.PathValue("t"), b)
			return e
		})
		if e != nil {
			return e
		}
		return send(w, result)
	})
	s.route("GET /api/documents/{m}/preferences", func(w http.ResponseWriter, r *http.Request) error {
		if _, e := s.member(s.db, r.PathValue("m")); e != nil {
			return e
		}
		v, e := one(s.db, "SELECT * FROM book_preferences WHERE id=?", r.PathValue("m"))
		if isNotFound(e) {
			return send(w, M{"data": M{}, "revision": 0})
		}
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("PUT /api/documents/{m}/preferences", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		if len(js(b)) > 8192 {
			return problem(400, "INVALID_PREFERENCES", "阅读设置过大", false)
		}
		e = s.transaction(func(tx *sql.Tx) error {
			if _, e := s.member(tx, r.PathValue("m")); e != nil {
				return e
			}
			return exec(tx, "INSERT INTO book_preferences VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,revision=book_preferences.revision+1", r.PathValue("m"), js(b))
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("GET /api/documents/{m}/bookmarks", func(w http.ResponseWriter, r *http.Request) error {
		if _, e := s.member(s.db, r.PathValue("m")); e != nil {
			return e
		}
		v, e := all(s.db, "SELECT * FROM bookmarks WHERE workspace_document_id=? ORDER BY created_at", r.PathValue("m"))
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("POST /api/documents/{m}/bookmarks", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		result, e := s.idem("bookmark:"+r.PathValue("m"), str(b, "clientRequestId"), b, func(tx *sql.Tx) (M, error) { return s.addBookmark(tx, r.PathValue("m"), b) })
		if e != nil {
			return e
		}
		return send(w, result)
	})
	s.route("DELETE /api/documents/{m}/bookmarks/{b}", func(w http.ResponseWriter, r *http.Request) error {
		e := s.transaction(func(tx *sql.Tx) error {
			return exec(tx, "DELETE FROM bookmarks WHERE id=? AND workspace_document_id=?", r.PathValue("b"), r.PathValue("m"))
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
}
func (s *Server) addBookmark(tx *sql.Tx, member string, b M) (M, error) {
	if _, e := s.memberVersion(tx, member, str(b, "versionId")); e != nil {
		return nil, e
	}
	title := strings.TrimSpace(str(b, "title"))
	locator := obj(b, "locator")
	if title == "" || utf8.RuneCountInString(title) > 120 || len(locator) == 0 || len(js(locator)) > 8192 {
		return nil, problem(400, "INVALID_BOOKMARK", "请填写书签名称并选择有效位置", false)
	}
	bookmark := id()
	if e := exec(tx, "INSERT INTO bookmarks VALUES(?,?,?,?,?,?)", bookmark, member, b["versionId"], title, js(locator), now()); e != nil {
		return nil, e
	}
	return one(tx, "SELECT * FROM bookmarks WHERE id=?", bookmark)
}
