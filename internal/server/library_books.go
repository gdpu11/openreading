package server

import (
	"database/sql"
	"net/http"
)

// Keep shelf metadata separate from source state. Scanning a connected folder
// must never resurrect a book explicitly removed from the library.
func (s *Server) libraryBook(w http.ResponseWriter, r *http.Request) error {
	member := r.PathValue("m")
	if r.Method == "DELETE" {
		mode := r.URL.Query().Get("mode")
		if mode != "" && mode != "library" && mode != "original" {
			return problem(400, "INVALID_DELETE_MODE", "删除方式无效", false)
		}
		if mode == "original" {
			s.importMu.Lock()
			defer s.importMu.Unlock()
			if e := s.deleteBookOriginal(r); e != nil {
				return e
			}
			result, err := s.member(s.db, member)
			if err != nil {
				return err
			}
			return send(w, result)
		}
	}
	field, value := "removed_at", any(now())
	if r.Method == "PATCH" {
		b, e := body(r)
		if e != nil {
			return e
		}
		if len(b) != 1 {
			return problem(400, "INVALID_BOOK_UPDATE", "请选择一项书籍操作", false)
		}
		for key, raw := range b {
			enabled, ok := raw.(bool)
			if !ok {
				return problem(400, "INVALID_BOOK_UPDATE", "书籍状态必须是布尔值", false)
			}
			switch key {
			case "favorite":
				field, value = "favorite", 0
				if enabled {
					value = 1
				}
			case "finished":
				field, value = "finished_at", ""
				if enabled {
					value = now()
				}
			case "restore":
				if !enabled {
					return problem(400, "INVALID_BOOK_UPDATE", "恢复参数无效", false)
				}
				field, value = "removed_at", ""
			default:
				return problem(400, "INVALID_BOOK_UPDATE", "书籍操作无效", false)
			}
		}
	}
	var result M
	e := s.transaction(func(tx *sql.Tx) error {
		if _, err := s.member(tx, member); err != nil {
			return err
		}
		// field is selected exclusively from the whitelist above; this UPSERT
		// changes one field so different windows cannot clobber other book flags.
		if err := exec(tx, "INSERT INTO library_books(workspace_document_id,"+field+") VALUES(?,?) ON CONFLICT(workspace_document_id) DO UPDATE SET "+field+"=excluded."+field, member, value); err != nil {
			return err
		}
		var err error
		result, err = s.member(tx, member)
		return err
	})
	if e != nil {
		return e
	}
	return send(w, result)
}
