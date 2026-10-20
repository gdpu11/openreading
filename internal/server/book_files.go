package server

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

func originalFingerprint(f *os.File) (string, error) {
	info, e := f.Stat()
	if e != nil {
		return "", e
	}
	if info.Size() > maxFileSize {
		return "", problem(413, "FILE_TOO_LARGE", "文件超过 200 MB 上限", false)
	}
	hash := sha256.New()
	if _, e = io.Copy(hash, io.LimitReader(f, maxFileSize+1)); e != nil {
		return "", e
	}
	return fmt.Sprintf("%x-%x-%x", info.Size(), info.ModTime().UnixNano(), hash.Sum(nil)), nil
}
func (s *Server) originalEntries(member string) ([]M, error) {
	return all(s.db, "SELECT e.*,s.root,s.label AS source_label FROM source_entries e JOIN sources s ON s.id=e.source_id JOIN document_bindings b ON b.source_entry_id=e.id WHERE b.workspace_document_id=? AND b.state='active' AND e.state='active' AND s.state='active' ORDER BY e.relative_path", member)
}
func (s *Server) bookDeletionPreview(w http.ResponseWriter, r *http.Request) error {
	if _, e := s.member(s.db, r.PathValue("m")); e != nil {
		return e
	}
	files := []M{}
	if s.cfg.PublicOrigin == "" {
		entries, e := s.originalEntries(r.PathValue("m"))
		if e != nil {
			return e
		}
		for _, entry := range entries {
			f, e := safeFile(str(entry, "root"), str(entry, "relativePath"))
			if e != nil {
				continue
			}
			fingerprint, e := originalFingerprint(f)
			f.Close()
			if e != nil {
				return e
			}
			files = append(files, M{"sourceEntryId": entry["id"], "relativePath": entry["relativePath"], "sourceLabel": entry["sourceLabel"], "fingerprint": fingerprint})
		}
	}
	return send(w, M{"files": files, "originalDeletionAllowed": s.cfg.PublicOrigin == ""})
}
func (s *Server) deleteBookOriginal(r *http.Request) error {
	if s.cfg.PublicOrigin != "" {
		return problem(403, "LOCAL_ONLY", "仅可在本机书库删除原始文件", false)
	}
	b, e := body(r)
	if e != nil {
		return e
	}
	if str(b, "confirm") != "delete-original" || str(b, "fingerprint") == "" {
		return problem(400, "CONFIRM_REQUIRED", "请确认删除所选原始文件", false)
	}
	entries, e := s.originalEntries(r.PathValue("m"))
	if e != nil {
		return e
	}
	for _, entry := range entries {
		if str(entry, "id") != str(b, "sourceEntryId") {
			continue
		}
		root, e := os.OpenRoot(str(entry, "root"))
		if e != nil {
			return e
		}
		defer root.Close()
		relative := str(entry, "relativePath")
		// Root confines all path resolution, including symlink parents, to the
		// connected directory. A source-entry ID can never target another book.
		f, e := root.Open(relative)
		if e != nil {
			return problem(409, "SOURCE_CHANGED", "原文件已变化，请刷新后重试", false)
		}
		defer f.Close()
		info, e := f.Stat()
		if e != nil || !info.Mode().IsRegular() {
			return problem(403, "PATH_NOT_ALLOWED", "仅可删除普通文件", false)
		}
		fingerprint, e := originalFingerprint(f)
		if e != nil {
			return e
		}
		current, e := root.Lstat(relative)
		if e != nil || !current.Mode().IsRegular() || !os.SameFile(info, current) || fingerprint != str(b, "fingerprint") {
			return problem(409, "SOURCE_CHANGED", "原文件已变化，请刷新后重试", false)
		}
		// Windows cannot unlink an original while our read handle is open.
		if e = f.Close(); e != nil {
			return e
		}
		// Stage the original on the same filesystem. If the database rejects the
		// removal (including commit failure), restore the original path instead
		// of reporting an error after irreversibly deleting the user's file.
		staged := filepath.Join(filepath.Dir(relative), ".openreading-delete-"+id()+".tmp")
		if e = root.Rename(relative, staged); e != nil {
			return e
		}
		restore := func() error {
			if _, err := root.Lstat(relative); !os.IsNotExist(err) {
				return problem(500, "DELETE_RECOVERY_REQUIRED", "删除未完成，原文件保留在："+staged, false)
			}
			if err := root.Rename(staged, relative); err != nil {
				return problem(500, "DELETE_RECOVERY_REQUIRED", "删除未完成，原文件保留在："+staged, false)
			}
			return nil
		}
		stagedInfo, err := root.Lstat(staged)
		if err != nil || !os.SameFile(info, stagedInfo) {
			if recovery := restore(); recovery != nil {
				return recovery
			}
			return problem(409, "SOURCE_CHANGED", "原文件已变化，请刷新后重试", false)
		}
		e = s.transaction(func(tx *sql.Tx) error {
			if _, err := s.member(tx, r.PathValue("m")); err != nil {
				return err
			}
			if err := exec(tx, "UPDATE source_entries SET state='missing' WHERE id=?", entry["id"]); err != nil {
				return err
			}
			return exec(tx, "INSERT INTO library_books(workspace_document_id,removed_at) VALUES(?,?) ON CONFLICT(workspace_document_id) DO UPDATE SET removed_at=excluded.removed_at", r.PathValue("m"), now())
		})
		if e != nil {
			if recovery := restore(); recovery != nil {
				return recovery
			}
			return e
		}
		if e = root.Remove(staged); e != nil {
			return problem(500, "DELETE_RECOVERY_REQUIRED", "书籍已移出，原文件清理未完成，文件保留在："+staged, false)
		}
		return nil
	}
	return problem(409, "SOURCE_CHANGED", "原文件不可用或不属于这本书，请刷新后重试", false)
}
