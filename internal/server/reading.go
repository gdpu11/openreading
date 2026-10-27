package server

import (
	"database/sql"
	"math"
	"net/http"
	"time"
)

// Intervals are immutable receipts. Retrying a batch cannot add reading time.
func (s *Server) saveReading(r *http.Request, phone bool) error {
	b, e := body(r)
	if e != nil {
		return e
	}
	events := arr(b, "events")
	if len(events) == 0 || len(events) > 100 {
		return problem(400, "READING_INVALID", "每次提交 1—100 段阅读记录", false)
	}
	return s.transaction(func(tx *sql.Tx) error {
		for _, raw := range events {
			v, ok := raw.(map[string]any)
			if !ok {
				return problem(400, "READING_INVALID", "阅读记录无效", false)
			}
			key, member := str(v, "id"), str(v, "member")
			start, sok := v["startedAt"].(float64)
			end, eok := v["endedAt"].(float64)
			if len(key) < 16 || len(key) > 100 || !sok || !eok || math.Trunc(start) != start || math.Trunc(end) != end || start < 946684800000 || end <= start || end-start > 60000 || end > float64(time.Now().Add(5*time.Minute).UnixMilli()) {
				return problem(400, "READING_INVALID", "阅读时间无效，请检查设备时间", false)
			}
			if phone {
				if _, e = s.syncMember(tx, deviceFrom(r), member); e != nil {
					return e
				}
			} else {
				if _, e = s.member(tx, member); e != nil {
					return e
				}
			}
			previous, err := one(tx, "SELECT * FROM reading_events WHERE id=?", key)
			if err == nil {
				if str(previous, "workspaceDocumentId") != member || int64(num(previous, "startedAt")) != int64(start) || int64(num(previous, "endedAt")) != int64(end) {
					return problem(409, "READING_CONFLICT", "阅读记录编号已用于其他内容", false)
				}
				continue
			}
			if !isNotFound(err) {
				return err
			}
			if e = exec(tx, "INSERT INTO reading_events VALUES(?,?,?,?)", key, member, int64(start), int64(end)); e != nil {
				return e
			}
		}
		return nil
	})
}
func (s *Server) readingData(q querier, d M) (M, error) {
	rows, e := all(q, `SELECT r.id,r.workspace_document_id AS member,r.started_at,r.ended_at,wd.workspace_id,d.format,
 COALESCE((SELECT e.relative_path FROM source_entries e JOIN document_bindings b ON b.source_entry_id=e.id WHERE b.workspace_document_id=wd.id ORDER BY (b.state='active') DESC,e.relative_path LIMIT 1),'历史文档') AS title
 FROM reading_events r JOIN workspace_documents wd ON wd.id=r.workspace_document_id JOIN documents d ON d.id=wd.document_id ORDER BY r.started_at,r.id`)
	if e != nil {
		return nil, e
	}
	events := []M{}
	visibility := map[string]bool{}
	for _, v := range rows {
		allowed := true
		if d != nil {
			member := str(v, "member")
			var known bool
			allowed, known = visibility[member]
			if !known {
				allowed, e = deviceDocument(q, d, M{"id": v["member"], "workspaceId": v["workspaceId"], "format": v["format"]})
				if e != nil {
					return nil, e
				}
				visibility[member] = allowed
			}
		}
		if allowed {
			delete(v, "format")
			delete(v, "workspaceId")
			events = append(events, v)
		}
	}
	goal := 30
	pref, e := one(q, "SELECT data_json FROM preferences WHERE id='reading-goal'")
	if e != nil && !isNotFound(e) {
		return nil, e
	}
	if n := num(obj(pref, "data"), "minutes"); n >= 1 && n <= 1440 {
		goal = n
	}
	return M{"events": events, "goalMinutes": goal}, nil
}
func (s *Server) readingRoutes() {
	s.route("GET /api/reading/documents/{member}", func(w http.ResponseWriter, r *http.Request) error {
		member := r.PathValue("member")
		if _, e := s.member(s.db, member); e != nil {
			return e
		}
		events, e := all(s.db, `SELECT id,workspace_document_id AS member,started_at,ended_at FROM reading_events WHERE workspace_document_id=? ORDER BY started_at,id`, member)
		if e != nil {
			return e
		}
		return send(w, M{"events": events})
	})
	for _, phone := range []bool{false, true} {
		prefix := "/api/reading"
		if phone {
			prefix = "/api/sync/reading"
		}
		s.route("GET "+prefix, func(w http.ResponseWriter, r *http.Request) error {
			var d M
			if phone {
				d = deviceFrom(r)
			}
			v, e := s.readingData(s.db, d)
			if e != nil {
				return e
			}
			return send(w, v)
		})
		s.route("POST "+prefix+"/events", func(w http.ResponseWriter, r *http.Request) error {
			if e := s.saveReading(r, phone); e != nil {
				return e
			}
			return send(w, M{"ok": true})
		})
	}
	s.route("PUT /api/reading/goal", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		n, ok := b["minutes"].(float64)
		if !ok || math.Trunc(n) != n || n < 1 || n > 1440 {
			return problem(400, "READING_GOAL", "每日目标须为 1—1440 分钟", false)
		}
		e = s.transaction(func(tx *sql.Tx) error {
			return exec(tx, "INSERT INTO preferences VALUES('reading-goal',?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json", js(M{"minutes": int(n)}))
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
}
