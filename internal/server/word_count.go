package server

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
)

type bookWordCount struct {
	Count     *int64 `json:"count"`
	TextPages *int   `json:"textPages,omitempty"`
	Pages     *int   `json:"pages,omitempty"`
}

// Regenerable renderer statistics; never change reading history or source files.
func (s *Server) wordCount(w http.ResponseWriter, r *http.Request) error {
	v, e := s.memberVersion(s.db, r.URL.Query().Get("workspaceDocumentId"), r.PathValue("v"))
	if e != nil {
		return e
	}
	rule, encoding := r.URL.Query().Get("rule"), r.URL.Query().Get("encoding")
	if rule != "body-mixed-v1" || (encoding != "utf-8" && encoding != "gb18030" && encoding != "gbk" && encoding != "big5") {
		return problem(400, "INVALID_WORD_COUNT", "字数统计参数无效", false)
	}
	key := sha256.Sum256([]byte(str(v, "contentHash") + ":" + str(v, "format") + ":" + rule + ":" + encoding))
	dir := filepath.Join(s.cfg.DataDir, "word-counts")
	name := filepath.Join(dir, fmt.Sprintf("%x.json", key))
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == "GET" {
		b, err := os.ReadFile(name)
		if os.IsNotExist(err) {
			return send(w, M{"statistics": nil})
		}
		if err != nil {
			return err
		}
		var value bookWordCount
		if json.Unmarshal(b, &value) != nil {
			return send(w, M{"statistics": nil})
		}
		return send(w, M{"statistics": value})
	}
	var value bookWordCount
	if e = decode(r, &value); e != nil {
		return e
	}
	invalid := value.Count == nil
	if value.Count != nil {
		invalid = *value.Count < 0 || *value.Count > 1_000_000_000
	}
	if str(v, "format") == "pdf" {
		invalid = invalid || value.Pages == nil || value.TextPages == nil
		if value.Pages != nil && value.TextPages != nil {
			invalid = invalid || *value.Pages < 1 || *value.Pages > 1_000_000 || *value.TextPages < 0 || *value.TextPages > *value.Pages
		}
	} else {
		invalid = invalid || value.Pages != nil || value.TextPages != nil
	}
	if invalid {
		return problem(400, "INVALID_WORD_COUNT", "字数统计结果无效", false)
	}
	b, e := json.Marshal(value)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	temp, e := os.CreateTemp(dir, "word-count-")
	if e != nil {
		return e
	}
	defer os.Remove(temp.Name())
	_, e = temp.Write(b)
	closeErr := temp.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	if e = os.Rename(temp.Name(), name); e != nil {
		return e
	}
	return send(w, M{"statistics": value})
}
