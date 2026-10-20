package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
)

type documentListCursor struct {
	Sort  string `json:"sort"`
	Value string `json:"value"`
	ID    string `json:"id"`
}

func (s *Server) listDocuments(r *http.Request) ([]M, string, error) {
	sort := r.URL.Query().Get("sort")
	if sort == "" {
		sort = "default"
	}
	key, direction := "wd.id", "ASC"
	switch sort {
	case "default":
	case "recent":
		key, direction = "max(wd.last_opened,COALESCE((SELECT updated_at FROM reading_states WHERE workspace_document_id=wd.id),''))", "DESC"
	case "added":
		key, direction = "d.created_at", "DESC"
	case "added-oldest":
		key = "d.created_at"
	case "name":
		// Bindings use source-relative paths; strip the last directory so names
		// sort consistently even when files come from different subfolders.
		path := `COALESCE((SELECT e.relative_path FROM document_bindings b JOIN source_entries e ON e.id=b.source_entry_id JOIN sources s ON s.id=e.source_id WHERE b.workspace_document_id=wd.id ORDER BY (e.state='active' AND b.state='active' AND s.state='active') DESC,e.relative_path LIMIT 1),'')`
		key = "lower(substr(" + path + ",length(rtrim(" + path + ",replace(" + path + ",'/','')))+1))"
	default:
		return nil, "", problem(400, "INVALID_SORT", "文件排序方式无效", false)
	}
	limit := 100
	if n, _ := strconv.Atoi(r.URL.Query().Get("limit")); n > 0 && n <= 500 {
		limit = n
	}
	q := "WITH listed AS (SELECT wd.*,d.format,d.created_at AS added_at,COALESCE(lb.favorite,0) AS favorite,COALESCE(lb.finished_at,'') AS finished_at,COALESCE(lb.removed_at,'') AS removed_at," + key + " AS sort_value FROM workspace_documents wd JOIN documents d ON d.id=wd.document_id LEFT JOIN library_books lb ON lb.workspace_document_id=wd.id WHERE wd.workspace_id=?"
	args := []any{r.PathValue("w")}
	filter := r.URL.Query().Get("filter")
	switch filter {
	case "", "all":
		q += " AND COALESCE(lb.removed_at,'')=''"
	case "favorites":
		q += " AND COALESCE(lb.removed_at,'')='' AND lb.favorite=1"
	case "finished":
		q += " AND COALESCE(lb.removed_at,'')='' AND lb.finished_at<>''"
	case "removed":
		q += " AND COALESCE(lb.removed_at,'')<>''"
	default:
		return nil, "", problem(400, "INVALID_BOOK_FILTER", "书库筛选方式无效", false)
	}
	if format := r.URL.Query().Get("format"); format != "" && format != "all" {
		switch format {
		case "pdf", "epub", "txt", "markdown":
		default:
			return nil, "", problem(400, "INVALID_FORMAT", "文件类型无效", false)
		}
		q += " AND d.format=?"
		args = append(args, format)
	}
	if search := r.URL.Query().Get("q"); search != "" {
		q += " AND EXISTS(SELECT 1 FROM document_bindings b JOIN source_entries e ON e.id=b.source_entry_id WHERE b.workspace_document_id=wd.id AND instr(lower(e.relative_path),lower(?))>0)"
		args = append(args, search)
	}
	q += ") SELECT * FROM listed WHERE 1=1"
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		if sort == "default" {
			// Retain the original ID cursor for older desktop/mobile clients.
			q += " AND id>?"
			args = append(args, raw)
		} else {
			var cursor documentListCursor
			data, err := base64.RawURLEncoding.DecodeString(raw)
			if len(raw) > 8192 || err != nil || json.Unmarshal(data, &cursor) != nil || cursor.Sort != sort || cursor.ID == "" {
				return nil, "", problem(400, "INVALID_CURSOR", "文件列表游标无效，请刷新列表", false)
			}
			comparison := ">"
			if direction == "DESC" {
				comparison = "<"
			}
			q += " AND (sort_value" + comparison + "? OR (sort_value=? AND id>?))"
			args = append(args, cursor.Value, cursor.Value, cursor.ID)
		}
	}
	q += " ORDER BY sort_value " + direction + ",id ASC LIMIT ?"
	args = append(args, limit+1)
	items, err := all(s.db, q, args...)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		next = str(last, "id")
		if sort != "default" {
			next = base64.RawURLEncoding.EncodeToString([]byte(js(documentListCursor{Sort: sort, Value: str(last, "sortValue"), ID: next})))
		}
	}
	for _, item := range items {
		delete(item, "sortValue")
	}
	return items, next, nil
}
