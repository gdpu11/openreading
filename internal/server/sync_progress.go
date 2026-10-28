package server

import (
	"net/http"
	"strings"
	"time"
)

type syncProgress struct {
	Revision   string `json:"revision"`
	Phase      string `json:"phase"`
	Done       int    `json:"done"`
	Total      int    `json:"total"`
	Title      string `json:"title,omitempty"`
	Received   int    `json:"received"`
	Bytes      int    `json:"bytes"`
	Message    string `json:"message,omitempty"`
	UpdatedAt  int64  `json:"updatedAt"`
	LastSeenAt int64  `json:"lastSeenAt"`
}

// Transfer observations are transient. Only the phone can acknowledge that
// downloaded bytes were verified and its offline library was durably saved.
func (s *Server) observeSync(d M, phase, title string, total int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.syncProgress == nil {
		s.syncProgress = map[string]syncProgress{}
	}
	key, revision := str(d, "id"), str(obj(d, "syncScope"), "revision")
	p := s.syncProgress[key]
	if p.Revision != "" && p.Revision != revision {
		return
	}
	p.Revision = revision
	p.LastSeenAt = time.Now().UnixMilli()
	if phase != "" {
		p.Phase, p.Title, p.Message, p.UpdatedAt = phase, title, "", p.LastSeenAt
		if phase == "preparing" {
			p.Done = 0
			p.Received = 0
			p.Bytes = 0
		}
		if total >= 0 {
			p.Total = total
		}
	}
	s.syncProgress[key] = p
}
func (s *Server) queueSync(device string, scope M) {
	// Scope writes can finish in one window while another saves a newer choice.
	// Never publish an older queue entry after the newer transaction committed.
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	current, err := one(s.db, "SELECT scope_json AS sync_scope_json FROM device_sync_scopes WHERE device_id=?", device)
	if err != nil || str(obj(current, "syncScope"), "revision") != str(scope, "revision") {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.syncProgress == nil {
		s.syncProgress = map[string]syncProgress{}
	}
	previous := s.syncProgress[device]
	if previous.Revision == str(scope, "revision") {
		return
	}
	s.syncProgress[device] = syncProgress{Revision: str(scope, "revision"), Phase: "waiting", UpdatedAt: time.Now().UnixMilli(), LastSeenAt: previous.LastSeenAt}
}
func (s *Server) syncProgressRoutes() {
	s.route("GET /api/devices/{d}/sync-progress", func(w http.ResponseWriter, r *http.Request) error {
		d, e := one(s.db, "SELECT d.id,COALESCE(s.scope_json,'{}') AS sync_scope_json FROM paired_devices d LEFT JOIN device_sync_scopes s ON s.device_id=d.id WHERE d.id=? AND d.revoked_at IS NULL AND d.expires_at>?", r.PathValue("d"), time.Now().Unix())
		if e != nil {
			return e
		}
		s.mu.Lock()
		p := s.syncProgress[str(d, "id")]
		s.mu.Unlock()
		revision := str(obj(d, "syncScope"), "revision")
		if p.Revision != revision {
			p = syncProgress{Revision: revision}
		}
		if p.Phase == "" {
			p.Phase = "waiting"
		}
		return send(w, p)
	})
	s.route("POST /api/sync/progress", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		d := deviceFrom(r)
		revision := str(obj(d, "syncScope"), "revision")
		if str(b, "revision") != revision {
			return problem(409, "SYNC_SCOPE_CHANGED", "电脑已更改同步范围，请重新接收所选书籍", true)
		}
		phase := str(b, "phase")
		if phase != "checking" && phase != "downloading" && phase != "saving" && phase != "completed" && phase != "failed" {
			return problem(400, "SYNC_PROGRESS", "同步状态无效", false)
		}
		done, total, received, size := num(b, "done"), num(b, "total"), num(b, "received"), num(b, "bytes")
		if done < 0 || total < done || total > 10000 || received < 0 || size < received || size > 210*1024*1024 || phase == "completed" && done != total {
			return problem(400, "SYNC_PROGRESS", "同步进度无效", false)
		}
		p := syncProgress{Revision: revision, Phase: phase, Done: done, Total: total, Title: strings.TrimSpace(str(b, "title")), Received: received, Bytes: size, Message: strings.TrimSpace(str(b, "message")), UpdatedAt: time.Now().UnixMilli(), LastSeenAt: time.Now().UnixMilli()}
		if len([]rune(p.Title)) > 300 || len([]rune(p.Message)) > 500 {
			return problem(400, "SYNC_PROGRESS", "同步状态过长", false)
		}
		s.mu.Lock()
		previous := s.syncProgress[str(d, "id")]
		if previous.Revision != "" && previous.Revision != revision {
			s.mu.Unlock()
			return problem(409, "SYNC_SCOPE_CHANGED", "电脑已更改同步范围，请重新同步", true)
		}
		if s.syncProgress == nil {
			s.syncProgress = map[string]syncProgress{}
		}
		s.syncProgress[str(d, "id")] = p
		s.mu.Unlock()
		return send(w, M{"ok": true})
	})
}
