package server

import (
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func (s *Server) backupPolicy() (M, error) {
	v, e := one(s.db, "SELECT data_json FROM preferences WHERE id='backup-policy'")
	if isNotFound(e) {
		return M{"enabled": false, "keep": 7, "intervalHours": 24}, nil
	}
	if e != nil {
		return nil, e
	}
	return obj(v, "data"), nil
}
func (s *Server) storeBackupPolicy(v M) error {
	return s.transaction(func(tx *sql.Tx) error {
		return exec(tx, "INSERT INTO preferences VALUES('backup-policy',?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json", js(v))
	})
}
func (s *Server) backupPolicyRoutes() {
	s.route("GET /api/backup-policy", func(w http.ResponseWriter, r *http.Request) error {
		v, e := s.backupPolicy()
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("PUT /api/backup-policy", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		keep, hours := num(b, "keep"), num(b, "intervalHours")
		if keep < 1 || keep > 30 || hours < 1 || hours > 168 {
			return problem(400, "INVALID_BACKUP_POLICY", "保留 1 至 30 份备份，间隔 1 至 168 小时", false)
		}
		policy, e := s.backupPolicy()
		if e != nil {
			return e
		}
		policy["enabled"] = b["enabled"] == true
		policy["keep"] = keep
		policy["intervalHours"] = hours
		if e = s.storeBackupPolicy(policy); e != nil {
			return e
		}
		return send(w, policy)
	})
	s.route("GET /api/automatic-backups", func(w http.ResponseWriter, r *http.Request) error {
		entries, e := os.ReadDir(filepath.Join(s.cfg.DataDir, "backups"))
		if e != nil {
			return e
		}
		items := []M{}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "auto-") && strings.HasSuffix(entry.Name(), ".zip") {
				info, e := entry.Info()
				if e != nil {
					return e
				}
				items = append(items, M{"id": strings.TrimSuffix(entry.Name(), ".zip"), "createdAt": info.ModTime().UTC().Format(time.RFC3339Nano), "bytes": info.Size()})
			}
		}
		sort.Slice(items, func(i, j int) bool { return str(items[i], "createdAt") > str(items[j], "createdAt") })
		return send(w, items)
	})
}

// The background worker owns this operation. A failed backup never prunes previous copies.
func (s *Server) automaticBackup() {
	policy, e := s.backupPolicy()
	if e != nil || policy["enabled"] != true {
		return
	}
	previous, _ := time.Parse(time.RFC3339Nano, str(policy, "lastAttempt"))
	if time.Since(previous) < time.Duration(num(policy, "intervalHours"))*time.Hour {
		return
	}
	policy["lastAttempt"] = now()
	if s.storeBackupPolicy(policy) != nil {
		return
	}
	result, e := s.backup()
	if e == nil {
		name := "auto-" + str(result, "id")
		e = os.Rename(filepath.Join(s.cfg.DataDir, "backups", str(result, "id")+".zip"), filepath.Join(s.cfg.DataDir, "backups", name+".zip"))
		if e == nil {
			policy["lastSuccess"] = now()
			policy["lastBackupId"] = name
			policy["lastError"] = ""
			e = s.pruneAutomaticBackups(num(policy, "keep"))
		}
	}
	if e != nil {
		policy["lastError"] = "自动备份失败，旧备份已保留，请检查存储空间和来源文件"
	}
	if latest, err := s.backupPolicy(); err == nil {
		for _, key := range []string{"enabled", "keep", "intervalHours"} {
			policy[key] = latest[key]
		}
	}
	_ = s.storeBackupPolicy(policy)
}
func (s *Server) pruneAutomaticBackups(keep int) error {
	entries, e := os.ReadDir(filepath.Join(s.cfg.DataDir, "backups"))
	if e != nil {
		return e
	}
	type item struct {
		name string
		at   time.Time
	}
	files := []item{}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), "auto-") && strings.HasSuffix(entry.Name(), ".zip") {
			info, e := entry.Info()
			if e != nil {
				return e
			}
			files = append(files, item{entry.Name(), info.ModTime()})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].at.After(files[j].at) })
	for i := keep; i < len(files); i++ {
		if e := os.Remove(filepath.Join(s.cfg.DataDir, "backups", files[i].name)); e != nil {
			return e
		}
	}
	return nil
}
