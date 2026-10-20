package server

import (
	"database/sql"
	"fmt"
	"net/url"
	"path"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestDocumentSortPagination(t *testing.T) {
	c := newClient(t, Config{})
	w := c.workspace("排序书库")
	source := c.source(w, t.TempDir())
	type item struct{ id, filename, added, recent string }
	var want []item
	err := c.s.transaction(func(tx *sql.Tx) error {
		for i := 0; i < 135; i++ {
			key := fmt.Sprintf("sort-%03d", i)
			filename := fmt.Sprintf("%03d-folder/Book-%02d.md", 134-i, (134-i)%30)
			if i%3 == 0 {
				filename = strings.ToLower(filename)
			}
			added := time.Date(2026, 1, 1+i%11, 0, 0, 0, 0, time.UTC).Format(time.RFC3339)
			opened := ""
			if i%4 != 0 {
				opened = time.Date(2026, 2, 1+i%7, 0, 0, 0, 0, time.UTC).Format(time.RFC3339)
			}
			for _, q := range []struct {
				sql  string
				args []any
			}{
				{"INSERT INTO documents VALUES(?,'markdown',?)", []any{key, added}},
				{"INSERT INTO workspace_documents(id,workspace_id,document_id,last_opened) VALUES(?,?,?,?)", []any{key, w["id"], key, opened}},
				{"INSERT INTO source_entries VALUES(?,?,?,?,?,1,1,'active')", []any{key, source["id"], key, filename, key}},
				{"INSERT INTO document_bindings VALUES(?,?,'active')", []any{key, key}},
			} {
				if err := exec(tx, q.sql, q.args...); err != nil {
					return err
				}
			}
			if i%9 == 0 {
				opened = "2026-03-01T00:00:00Z"
				if err := exec(tx, "INSERT INTO reading_states(workspace_document_id,locator_json,updated_at) VALUES(?,'{}',?)", key, opened); err != nil {
					return err
				}
			}
			want = append(want, item{key, strings.ToLower(path.Base(filename)), added, opened})
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	base := "/api/workspaces/" + str(w, "id") + "/documents"
	// A separate reader must address a book beyond the first library page.
	direct := c.ok("GET", "/api/documents/sort-134", nil)
	if str(direct, "workspaceId") != str(w, "id") || len(arr(direct, "bindings")) != 1 || str(direct, "format") != "markdown" {
		t.Fatal("independent reader lookup lost document context", direct)
	}

	for _, mode := range []string{"default", "recent", "added", "added-oldest", "name"} {
		t.Run(mode, func(t *testing.T) {
			expected := append([]item(nil), want...)
			sort.Slice(expected, func(i, j int) bool {
				a, b := expected[i], expected[j]
				x, y := a.id, b.id
				switch mode {
				case "recent":
					x, y = a.recent, b.recent
				case "added", "added-oldest":
					x, y = a.added, b.added
				case "name":
					x, y = a.filename, b.filename
				}
				if x == y {
					return a.id < b.id
				}
				if mode == "recent" || mode == "added" {
					return x > y
				}
				return x < y
			})
			var got, ids []string
			cursor := ""
			for pages := 0; pages < 10; pages++ {
				response := c.ok("GET", base+"?sort="+mode+"&limit=17&cursor="+url.QueryEscape(cursor), nil)
				for _, row := range arr(response, "items") {
					m := row.(map[string]any)
					got = append(got, str(m, "id"))
					if _, leaked := m["sortValue"]; leaked || str(m, "addedAt") == "" {
						t.Fatal("invalid document metadata", m)
					}
				}
				cursor = str(response, "nextCursor")
				if cursor == "" {
					break
				}
			}
			for _, row := range expected {
				ids = append(ids, row.id)
			}
			if !reflect.DeepEqual(got, ids) {
				t.Fatalf("sort/pagination mismatch: got %v want %v", got, ids)
			}
		})
	}
	filtered := c.ok("GET", base+"?sort=name&q=book-02.md&limit=500", nil)
	if len(arr(filtered, "items")) != 5 {
		t.Fatal("search lost during sorting", filtered)
	}
	first := c.ok("GET", base+"?sort=recent&limit=1", nil)
	for _, query := range []string{"sort=invalid", "sort=name&cursor=broken", "sort=added&cursor=" + str(first, "nextCursor")} {
		status, _ := c.req("GET", base+"?"+query, nil)
		if status != 400 {
			t.Fatal("invalid sort/cursor accepted", query, status)
		}
	}
	legacy := c.ok("GET", base+"?limit=1", nil)
	if str(legacy, "nextCursor") != want[0].id {
		t.Fatal("default ID cursor changed", legacy)
	}
}

func TestDocumentFormatFilterBeforePagination(t *testing.T) {
	c := newClient(t, Config{})
	w := c.workspace("Format filters")
	for i, format := range []string{"epub", "pdf", "txt", "markdown", "pdf", "epub"} {
		key := fmt.Sprintf("format-%d", i)
		if e := exec(c.s.db, "INSERT INTO documents VALUES(?,?,?)", key, format, now()); e != nil {
			t.Fatal(e)
		}
		if e := exec(c.s.db, "INSERT INTO workspace_documents(id,workspace_id,document_id) VALUES(?,?,?)", key, w["id"], key); e != nil {
			t.Fatal(e)
		}
	}
	base := "/api/workspaces/" + str(w, "id") + "/documents"
	for _, format := range []string{"epub", "pdf", "txt", "markdown"} {
		cursor := ""
		count := 0
		for {
			page := c.ok("GET", base+"?format="+format+"&sort=added&limit=1&cursor="+url.QueryEscape(cursor), nil)
			for _, item := range arr(page, "items") {
				if str(item.(map[string]any), "format") != format {
					t.Fatal("wrong format", page)
				}
				count++
			}
			cursor = str(page, "nextCursor")
			if cursor == "" {
				break
			}
		}
		expected := 1
		if format == "pdf" || format == "epub" {
			expected = 2
		}
		if count != expected {
			t.Fatal(format, count)
		}
	}
	if code, _ := c.req("GET", base+"?format=bad", nil); code != 400 {
		t.Fatal(code)
	}
}
