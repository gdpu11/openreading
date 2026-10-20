package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	_ "modernc.org/sqlite"
	"strings"
	"time"
)

type M = map[string]any
type querier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func id() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func now() string            { return time.Now().UTC().Format(time.RFC3339Nano) }
func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func js(v any) string {
	b, e := json.Marshal(v)
	if e != nil {
		panic(e)
	}
	return string(b)
}
func str(m M, k string) string { v, _ := m[k].(string); return v }
func num(m M, k string) int {
	switch v := m[k].(type) {
	case int64:
		return int(v)
	case float64:
		return int(v)
	case int:
		return v
	}
	return 0
}
func obj(m M, k string) M {
	v, _ := m[k].(map[string]any)
	if v == nil {
		return M{}
	}
	return v
}
func arr(m M, k string) []any { v, _ := m[k].([]any); return v }
func camel(s string) string {
	p := strings.Split(s, "_")
	for i := 1; i < len(p); i++ {
		if p[i] != "" {
			p[i] = strings.ToUpper(p[i][:1]) + p[i][1:]
		}
	}
	return strings.Join(p, "")
}
func all(q querier, query string, args ...any) ([]M, error) {
	rows, e := q.QueryContext(context.Background(), query, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	cols, e := rows.Columns()
	if e != nil {
		return nil, e
	}
	out := []M{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptr := make([]any, len(cols))
		for i := range vals {
			ptr[i] = &vals[i]
		}
		if e = rows.Scan(ptr...); e != nil {
			return nil, e
		}
		m := M{}
		for i, c := range cols {
			v := vals[i]
			if b, ok := v.([]byte); ok {
				v = string(b)
			}
			if strings.HasSuffix(c, "_json") {
				key := camel(strings.TrimSuffix(c, "_json"))
				if s, ok := v.(string); ok {
					var j any
					if json.Unmarshal([]byte(s), &j) == nil {
						v = j
					}
				}
				m[key] = v
			} else {
				m[camel(c)] = v
			}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func one(q querier, query string, args ...any) (M, error) {
	r, e := all(q, query, args...)
	if e != nil {
		return nil, e
	}
	if len(r) == 0 {
		return nil, problem(404, "NOT_FOUND", "记录不存在", false)
	}
	return r[0], nil
}
func exec(q querier, query string, args ...any) error {
	_, e := q.ExecContext(context.Background(), query, args...)
	return e
}
func (s *Server) transaction(fn func(*sql.Tx) error) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = fn(tx); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Server) idem(scope, key string, body any, fn func(*sql.Tx) (M, error)) (M, error) {
	if key == "" || len(key) > 150 {
		return nil, problem(400, "INVALID_REQUEST", "缺少有效的 clientRequestId", false)
	}
	hash := digest([]byte(js(body)))
	var result M
	e := s.transaction(func(tx *sql.Tx) error {
		previous, err := one(tx, "SELECT * FROM idempotency WHERE scope=? AND key=?", scope, key)
		if err == nil {
			if str(previous, "bodyHash") != hash {
				return problem(409, "REVISION_CONFLICT", "相同请求编号包含不同内容", false)
			}
			result = obj(previous, "response")
			return nil
		}
		if !isNotFound(err) {
			return err
		}
		result, err = fn(tx)
		if err != nil {
			return err
		}
		return exec(tx, "INSERT INTO idempotency VALUES(?,?,?,?)", scope, key, hash, js(result))
	})
	return result, e
}
func (s *Server) member(q querier, memberID string) (M, error) {
	return one(q, "SELECT wd.*,d.format,COALESCE(lb.favorite,0) AS favorite,COALESCE(lb.finished_at,'') AS finished_at,COALESCE(lb.removed_at,'') AS removed_at FROM workspace_documents wd JOIN documents d ON d.id=wd.document_id LEFT JOIN library_books lb ON lb.workspace_document_id=wd.id WHERE wd.id=?", memberID)
}
func validBlobReference(hash, ref string) bool {
	if len(hash) != 64 || ref != hash {
		return false
	}
	_, err := hex.DecodeString(hash)
	return err == nil && strings.ToLower(hash) == hash
}
func (s *Server) memberVersion(q querier, memberID, versionID string) (M, error) {
	v, err := one(q, "SELECT v.*,wd.workspace_id,wd.id AS workspace_document_id,d.format FROM versions v JOIN workspace_documents wd ON wd.document_id=v.document_id JOIN documents d ON d.id=v.document_id WHERE wd.id=? AND v.id=?", memberID, versionID)
	if err != nil {
		return nil, err
	}
	if !validBlobReference(str(v, "contentHash"), str(v, "blobRef")) {
		return nil, problem(400, "INVALID_SNAPSHOT", "快照文件引用无效，已阻止读取", false)
	}
	return v, nil
}

type apiError struct {
	Status        int
	Code, Message string
	Retryable     bool
}

func (e *apiError) Error() string { return e.Code + ": " + e.Message }
func problem(status int, code, message string, retry bool) error {
	return &apiError{status, code, message, retry}
}
func isNotFound(e error) bool { var p *apiError; return errors.As(e, &p) && p.Status == 404 }
func checkRevision(q querier, table, id string, revision int, changes map[string]any) error {
	keys := []string{}
	values := []any{}
	for k, v := range changes {
		keys = append(keys, k+"=?")
		values = append(values, v)
	}
	keys = append(keys, "revision=revision+1")
	values = append(values, id, revision)
	r, e := q.ExecContext(context.Background(), fmt.Sprintf("UPDATE %s SET %s WHERE id=? AND revision=?", table, strings.Join(keys, ",")), values...)
	if e != nil {
		return e
	}
	n, e := r.RowsAffected()
	if e != nil {
		return e
	}
	if n != 1 {
		return problem(409, "REVISION_CONFLICT", "此内容已在另一个标签更新，请重新载入后合并", false)
	}
	return nil
}
