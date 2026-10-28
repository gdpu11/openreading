package server

import (
	"crypto/subtle"
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

type deviceContextKey struct{}

func deviceFrom(r *http.Request) M {
	d, _ := r.Context().Value(deviceContextKey{}).(map[string]any)
	return d
}
func (s *Server) authenticateDevice(r *http.Request) (M, error) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if len(token) != 64 {
		return nil, problem(401, "DEVICE_REQUIRED", "设备授权已失效，请在电脑端重新扫码", false)
	}
	returnDevice, e := one(s.db, "SELECT d.*,COALESCE(s.scope_json,'{}') AS sync_scope_json FROM paired_devices d LEFT JOIN device_sync_scopes s ON s.device_id=d.id WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?", digest([]byte(token)), time.Now().Unix())
	if e != nil {
		return nil, problem(401, "DEVICE_REQUIRED", "设备授权已失效，请在电脑端重新扫码", false)
	}
	return returnDevice, nil
}
func deviceWorkspace(d M, w string) bool {
	for _, v := range arr(d, "workspaceIds") {
		if v == w {
			return true
		}
	}
	return false
}
func (s *Server) syncMember(q querier, d M, member string) (M, error) {
	m, e := s.member(q, member)
	if e != nil {
		return nil, problem(403, "SYNC_SCOPE", "此文档不在设备授权范围内", false)
	}
	allowed, e := deviceDocument(q, d, m)
	if e != nil {
		return nil, e
	}
	if !allowed {
		return nil, problem(403, "SYNC_SCOPE", "此文档不在设备授权范围内", false)
	}
	return m, nil
}
func fingerprint(hash string) string {
	if len(hash) < 8 {
		return ""
	}
	return strings.ToUpper(hash[:4] + "-" + hash[4:8])
}
func (s *Server) syncRoutes() {
	s.syncScopeRoutes()
	s.syncCatalogRoutes()
	s.syncProgressRoutes()
	s.route("POST /api/pair/grants", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		origin, certificateFingerprint, e := s.pairingOrigin(str(b, "origin"))
		if e != nil {
			return e
		}
		scopes, scope, e := s.validateSyncScope(s.db, b)
		if e != nil {
			return e
		}
		if b["connectionOnly"] == true {
			scope = M{"mode": "manual", "memberIds": []any{}, "connectionOnly": true}
		}
		grant, secret := id(), id()+id()
		expiry := time.Now().Add(3 * time.Minute).Unix()
		e = s.transaction(func(tx *sql.Tx) error {
			if e := exec(tx, "DELETE FROM pairing_grants WHERE expires_at<?", time.Now().Unix()); e != nil {
				return e
			}
			active, err := all(tx, "SELECT id FROM pairing_grants WHERE state IN ('waiting','claimed')")
			if err != nil {
				return err
			}
			if len(active) >= 10 {
				return problem(429, "PAIR_LIMIT", "待配对设备过多，请取消旧二维码或稍后重试", true)
			}
			if e := exec(tx, "INSERT INTO pairing_grants(id,secret_hash,workspace_ids_json,expires_at) VALUES(?,?,?,?)", grant, digest([]byte(secret)), js(scopes), expiry); e != nil {
				return e
			}
			return exec(tx, "INSERT INTO pairing_sync_scopes VALUES(?,?)", grant, js(scope))
		})
		if e != nil {
			return e
		}
		return send(w, M{"id": grant, "secret": secret, "origin": origin, "certificateFingerprint": certificateFingerprint, "expiresAt": expiry})
	})
	s.route("GET /api/pair/grants/{g}", func(w http.ResponseWriter, r *http.Request) error {
		v, e := one(s.db, "SELECT id,state,claim_name,claim_hash,expires_at FROM pairing_grants WHERE id=?", r.PathValue("g"))
		if e != nil {
			return e
		}
		v["fingerprint"] = fingerprint(str(v, "claimHash"))
		delete(v, "claimHash")
		if num(v, "expiresAt") <= int(time.Now().Unix()) {
			v["state"] = "expired"
		}
		return send(w, v)
	})
	s.route("POST /api/pair/claim", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		name := strings.TrimSpace(str(b, "name"))
		token := str(b, "token")
		if utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 60 || len(token) != 64 || len(str(b, "secret")) != 64 {
			return problem(400, "INVALID_PAIR", "配对信息无效", false)
		}
		e = s.transaction(func(tx *sql.Tx) error {
			grant, e := one(tx, "SELECT * FROM pairing_grants WHERE id=? AND expires_at>?", b["id"], time.Now().Unix())
			if e != nil || subtle.ConstantTimeCompare([]byte(str(grant, "secretHash")), []byte(digest([]byte(str(b, "secret"))))) != 1 {
				return problem(401, "INVALID_PAIR", "二维码已失效，请在电脑端重新生成", false)
			}
			hash := digest([]byte(token))
			if str(grant, "state") == "claimed" && str(grant, "claimHash") == hash {
				return nil
			}
			if str(grant, "state") != "waiting" {
				return problem(409, "PAIR_USED", "此二维码已被扫描，请生成新的二维码", false)
			}
			return exec(tx, "UPDATE pairing_grants SET state='claimed',claim_name=?,claim_hash=? WHERE id=?", name, hash, b["id"])
		})
		if e != nil {
			return e
		}
		return send(w, M{"state": "claimed", "fingerprint": fingerprint(digest([]byte(token)))})
	})
	s.route("GET /api/pair/status", func(w http.ResponseWriter, r *http.Request) error {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if len(token) != 64 {
			return problem(401, "INVALID_PAIR", "配对信息无效", false)
		}
		v, e := one(s.db, "SELECT state,device_id,expires_at FROM pairing_grants WHERE id=? AND claim_hash=? AND expires_at>?", r.URL.Query().Get("grant"), digest([]byte(token)), time.Now().Unix())
		if e != nil {
			return problem(401, "INVALID_PAIR", "配对已到期或取消，请重新扫描", false)
		}
		return send(w, v)
	})
	s.route("POST /api/pair/grants/{g}/approve", func(w http.ResponseWriter, r *http.Request) error {
		var result M
		e := s.transaction(func(tx *sql.Tx) error {
			g, e := one(tx, `SELECT g.*,COALESCE(s.scope_json,'{"mode":"all"}') AS sync_scope_json FROM pairing_grants g LEFT JOIN pairing_sync_scopes s ON s.grant_id=g.id WHERE g.id=? AND expires_at>? AND state='claimed'`, r.PathValue("g"), time.Now().Unix())
			if e != nil {
				return problem(409, "INVALID_PAIR", "设备尚未扫描，或二维码已过期", false)
			}
			d := id()
			existing, err := one(tx, "SELECT d.*,COALESCE(s.scope_json,'{}') AS sync_scope_json FROM paired_devices d LEFT JOIN device_sync_scopes s ON s.device_id=d.id WHERE token_hash=?", g["claimHash"])
			connectionOnly := obj(g, "syncScope")["connectionOnly"] == true
			delete(obj(g, "syncScope"), "connectionOnly")
			if err == nil {
				d = str(existing, "id")
				if connectionOnly && str(existing, "revokedAt") == "" && num(existing, "expiresAt") > int(time.Now().Unix()) {
					g["workspaceIds"] = existing["workspaceIds"]
					g["syncScope"] = obj(existing, "syncScope")
				}
				e = exec(tx, "UPDATE paired_devices SET name=?,workspace_ids_json=?,expires_at=?,revoked_at=NULL WHERE id=?", g["claimName"], js(g["workspaceIds"]), time.Now().Add(90*24*time.Hour).Unix(), d)
			} else if isNotFound(err) {
				e = exec(tx, "INSERT INTO paired_devices(id,name,token_hash,workspace_ids_json,created_at,expires_at) VALUES(?,?,?,?,?,?)", d, g["claimName"], g["claimHash"], js(g["workspaceIds"]), now(), time.Now().Add(90*24*time.Hour).Unix())
			} else {
				return err
			}
			if e != nil {
				return e
			}
			if e = exec(tx, "INSERT INTO device_sync_scopes VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET scope_json=excluded.scope_json", d, js(g["syncScope"])); e != nil {
				return e
			}
			if e = exec(tx, "UPDATE pairing_grants SET state='approved',device_id=? WHERE id=?", d, g["id"]); e != nil {
				return e
			}
			result = M{"id": d}
			return nil
		})
		if e != nil {
			return e
		}
		return send(w, result)
	})
	s.route("DELETE /api/pair/grants/{g}", func(w http.ResponseWriter, r *http.Request) error {
		returnError := exec(s.db, "DELETE FROM pairing_grants WHERE id=?", r.PathValue("g"))
		if returnError != nil {
			return returnError
		}
		return send(w, M{"ok": true})
	})
	s.route("GET /api/devices", func(w http.ResponseWriter, r *http.Request) error {
		v, e := all(s.db, "SELECT d.id,name,workspace_ids_json,created_at,expires_at,revoked_at,COALESCE(s.scope_json,'{}') AS sync_scope_json FROM paired_devices d LEFT JOIN device_sync_scopes s ON s.device_id=d.id ORDER BY created_at DESC")
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("DELETE /api/devices/{d}", func(w http.ResponseWriter, r *http.Request) error {
		e := s.transaction(func(tx *sql.Tx) error {
			return exec(tx, "UPDATE paired_devices SET revoked_at=? WHERE id=?", now(), r.PathValue("d"))
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("GET /api/sync/library", s.syncLibrary)
	s.route("GET /api/sync/status", func(w http.ResponseWriter, r *http.Request) error {
		return send(w, M{"enabled": obj(deviceFrom(r), "syncScope")["autoSync"] == true})
	})
	s.route("GET /api/sync/files/{v}", func(w http.ResponseWriter, r *http.Request) error {
		member := r.URL.Query().Get("member")
		if _, e := s.syncMember(s.db, deviceFrom(r), member); e != nil {
			return e
		}
		title, _ := one(s.db, "SELECT e.relative_path AS title FROM source_entries e JOIN document_bindings b ON b.source_entry_id=e.id WHERE b.workspace_document_id=? ORDER BY e.relative_path LIMIT 1", member)
		s.observeSync(deviceFrom(r), "sending", str(title, "title"), -1)
		v, e := s.memberVersion(s.db, member, r.PathValue("v"))
		if e != nil {
			return e
		}
		f, e := os.Open(filepath.Join(s.cfg.DataDir, "blobs", str(v, "contentHash")))
		if e != nil {
			return problem(404, "SOURCE_UNAVAILABLE", "快照未缓存，请在电脑端打开此文档后再同步", false)
		}
		defer f.Close()
		stat, e := f.Stat()
		if e != nil {
			return e
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeContent(w, r, "snapshot", stat.ModTime(), f)
		return nil
	})
	s.route("GET /api/sync/resources/{m}", func(w http.ResponseWriter, r *http.Request) error {
		member := r.URL.Query().Get("member")
		if _, e := s.syncMember(s.db, deviceFrom(r), member); e != nil {
			return e
		}
		m, e := one(s.db, "SELECT * FROM manifests WHERE id=?", r.PathValue("m"))
		if e != nil {
			return e
		}
		if e = s.manifestMember(s.db, str(m, "id"), member, str(m, "versionId")); e != nil {
			return e
		}
		for _, raw := range arr(m, "resources") {
			v, _ := raw.(map[string]any)
			if str(v, "path") == r.URL.Query().Get("path") {
				f, e := os.Open(filepath.Join(s.cfg.DataDir, "blobs", str(v, "blobHash")))
				if e != nil {
					return e
				}
				defer f.Close()
				st, e := f.Stat()
				if e != nil {
					return e
				}
				w.Header().Set("Content-Type", str(v, "mime"))
				http.ServeContent(w, r, "resource", st.ModTime(), f)
				return nil
			}
		}
		return problem(404, "SOURCE_UNAVAILABLE", "图片尚未捕获，请在电脑端打开后重新同步", false)
	})
	s.route("POST /api/sync/commands", s.syncCommand)
}

func (s *Server) syncLibrary(w http.ResponseWriter, r *http.Request) (result error) {
	d := deviceFrom(r)
	s.observeSync(d, "preparing", "", 0)
	defer func() {
		if result != nil {
			s.observeSync(d, "failed", "", -1)
		}
	}()
	out := []M{}
	// One DB transaction publishes a coherent manifest, including newly imported
	// files never opened on the PC. Sources/paths/provider credentials are omitted.
	e := s.transaction(func(tx *sql.Tx) error {
		for _, raw := range arr(d, "workspaceIds") {
			ws, e := one(tx, "SELECT id,name FROM workspaces WHERE id=?", raw)
			if isNotFound(e) {
				continue
			}
			if e != nil {
				return e
			}
			docs, e := all(tx, "SELECT wd.id,wd.workspace_id,wd.document_id,d.format,COALESCE(lb.favorite,0) AS favorite,COALESCE(lb.finished_at,'') AS finished_at FROM workspace_documents wd JOIN documents d ON d.id=wd.document_id LEFT JOIN library_books lb ON lb.workspace_document_id=wd.id WHERE wd.workspace_id=? AND wd.state='active' AND COALESCE(lb.removed_at,'')='' ORDER BY wd.id", raw)
			if e != nil {
				return e
			}
			visible := []M{}
			for _, m := range docs {
				allowed, err := deviceDocument(tx, d, m)
				if err != nil {
					return err
				}
				if !allowed {
					continue
				}
				delete(m, "workspaceId")
				visible = append(visible, m)
				entry, e := one(tx, "SELECT e.id,e.relative_path,s.root,s.kind FROM source_entries e JOIN sources s ON s.id=e.source_id JOIN document_bindings b ON b.source_entry_id=e.id WHERE b.workspace_document_id=? AND e.state='active' AND s.state='active' AND b.state='active' ORDER BY e.relative_path LIMIT 1", m["id"])
				versions, e2 := all(tx, "SELECT id,content_hash,size,created_at FROM versions WHERE document_id=? ORDER BY (id=COALESCE((SELECT version_id FROM mcp_documents WHERE workspace_document_id=?),'')) DESC,created_at DESC,id", m["documentId"], m["id"])
				if e2 != nil {
					return e2
				}
				if len(versions) == 0 && e == nil {
					hash, size, err := s.capture(str(entry, "root"), str(entry, "relativePath"))
					if err != nil {
						return err
					}
					v := M{"id": id(), "contentHash": hash, "size": size, "createdAt": now()}
					if err = exec(tx, "INSERT INTO versions VALUES(?,?,?,?,?,?)", v["id"], m["documentId"], hash, hash, size, v["createdAt"]); err != nil {
						return err
					}
					versions = append(versions, v)
				}
				m["title"] = str(entry, "relativePath")
				if m["title"] == "" {
					m["title"] = "历史文档"
				}
				m["workspaceDocumentId"] = m["id"]
				m["versions"] = versions
				if len(versions) > 0 {
					m["version"] = versions[0]
				}
				m["readingState"], e = one(tx, "SELECT * FROM reading_states WHERE workspace_document_id=?", m["id"])
				if e != nil && !isNotFound(e) {
					return e
				}
				threads, err := s.threadData(tx, "WHERE a.workspace_document_id=?", m["id"])
				if err != nil {
					return err
				}
				m["threads"] = threads
				m["recognizedPages"], err = all(tx, "SELECT rp.* FROM recognized_pages rp JOIN versions v ON v.id=rp.version_id WHERE v.document_id=?", m["documentId"])
				if err != nil {
					return err
				}
				m["bookmarks"], err = all(tx, "SELECT * FROM bookmarks WHERE workspace_document_id=? ORDER BY created_at", m["id"])
				if err != nil {
					return err
				}
				prefs, err := one(tx, "SELECT data_json FROM book_preferences WHERE id=?", m["id"])
				if err != nil && !isNotFound(err) {
					return err
				}
				m["preferences"] = obj(prefs, "data")
				manifests, err := all(tx, "SELECT m.id,m.version_id,m.resources_json FROM manifests m JOIN document_bindings b ON b.source_entry_id=m.source_entry_id WHERE b.workspace_document_id=? ORDER BY m.created_at", m["id"])
				if err != nil {
					return err
				}
				m["manifests"] = manifests
				for _, v := range versions {
					// Keep snapshots while an authorized phone may be reading them offline.
					if err = exec(tx, "INSERT INTO leases SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM leases WHERE version_id=? AND expires_at>=?)", id(), v["id"], d["expiresAt"], v["id"], d["expiresAt"]); err != nil {
						return err
					}
				}
			}
			ws["documents"] = visible
			out = append(out, ws)
		}
		return nil
	})
	if e != nil {
		return e
	}
	reading, e := s.readingData(s.db, d)
	if e != nil {
		return e
	}
	total := 0
	for _, ws := range out {
		if docs, ok := ws["documents"].([]M); ok {
			total += len(docs)
		}
	}
	s.observeSync(d, "checking", "", total)
	return send(w, M{"scopeRevision": str(obj(d, "syncScope"), "revision"), "schemaVersion": 1, "workspaces": out, "syncedAt": now(), "deviceId": d["id"], "readingData": reading})
}

func (s *Server) syncCommand(w http.ResponseWriter, r *http.Request) error {
	b, e := body(r)
	if e != nil {
		return e
	}
	d := deviceFrom(r)
	if _, e := s.syncMember(s.db, d, str(b, "member")); e != nil {
		return e
	}
	result, e := s.idem("device:"+str(d, "id"), str(b, "operationId"), b, func(tx *sql.Tx) (M, error) {
		member := str(b, "member")
		if _, e := s.syncMember(tx, d, member); e != nil {
			return nil, e
		}
		switch str(b, "type") {
		case "learning":
			return s.saveLearning(tx, member, str(b, "threadId"), b)
		case "bookmark":
			return s.addBookmark(tx, member, b)
		case "delete-bookmark":
			err := exec(tx, "DELETE FROM bookmarks WHERE id=? AND workspace_document_id=?", b["bookmarkId"], member)
			return M{"ok": true}, err
		case "create":
			anchor := obj(b, "anchor")
			a := obj(b, "artifact")
			blocks := arr(a, "blocks")
			version := str(anchor, "documentVersionId")
			if len(blocks) == 0 || len(blocks) > 20000 || len(js(blocks)) > 4<<20 || str(anchor, "normalizationVersion") != "unicode-codepoint-preserve-v1" || str(anchor, "parserVersion") == "" {
				return nil, problem(400, "INVALID_ARTIFACT", "选段内容无效", false)
			}
			if _, e := s.memberVersion(tx, member, version); e != nil {
				return nil, e
			}
			hash := digest([]byte(js(M{"blocks": blocks, "parser": anchor["parserVersion"], "normalization": anchor["normalizationVersion"], "sanitizer": "safe-v1"})))
			artifact, e := one(tx, "SELECT id FROM artifacts WHERE version_id=? AND artifact_hash=?", version, hash)
			if isNotFound(e) {
				artifact = M{"id": id()}
				e = exec(tx, "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?)", artifact["id"], version, anchor["parserVersion"], anchor["normalizationVersion"], "safe-v1", hash, js(blocks), now())
			}
			if e != nil {
				return nil, e
			}
			anchor["extractionArtifactId"] = artifact["id"]
			if e = s.validateAnchor(tx, member, version, anchor); e != nil {
				return nil, e
			}
			annotation, thread := id(), id()
			var manifest any
			if x := str(anchor, "resourceManifestId"); x != "" {
				manifest = x
			}
			if e = exec(tx, "INSERT INTO annotations(id,workspace_document_id,original_version_id,artifact_id,manifest_id,anchor_json,style_json,created_at) VALUES(?,?,?,?,?,?,?,?)", annotation, member, version, artifact["id"], manifest, js(anchor), js(validStyle(M{})), now()); e != nil {
				return nil, e
			}
			if e = exec(tx, "INSERT INTO threads(id,annotation_id,created_at) VALUES(?,?,?)", thread, annotation, now()); e != nil {
				return nil, e
			}
			threads, e := s.threadData(tx, "WHERE t.id=?", thread)
			if e != nil {
				return nil, e
			}
			return s.addMessage(tx, threads[0], M{"body": str(b, "body"), "recipient": "note"})
		case "edit":
			m, e := one(tx, "SELECT m.* FROM messages m JOIN threads t ON t.id=m.thread_id JOIN annotations a ON a.id=t.annotation_id WHERE m.id=? AND a.workspace_document_id=? AND m.role='user' AND m.recipient='note'", b["messageId"], member)
			if e != nil {
				return nil, e
			}
			text := strings.TrimSpace(str(b, "body"))
			if text == "" || utf8.RuneCountInString(text) > 100000 {
				return nil, problem(400, "INVALID_MESSAGE", "笔记为空或过长", false)
			}
			if num(m, "revision") != num(b, "revision") {
				return nil, problem(409, "REVISION_CONFLICT", "电脑或另一设备已修改这条笔记。手机草稿已保留，请比较后重试", false)
			}
			version := num(m, "version") + 1
			if e = exec(tx, "UPDATE messages SET body=?,version=?,revision=revision+1 WHERE id=?", text, version, m["id"]); e != nil {
				return nil, e
			}
			if e = exec(tx, "INSERT INTO message_versions VALUES(?,?,?,?)", m["id"], version, text, now()); e != nil {
				return nil, e
			}
			return M{"ok": true, "revision": num(m, "revision") + 1}, nil
		default:
			return nil, problem(400, "INVALID_COMMAND", "不支持的同步操作", false)
		}
	})
	if e != nil {
		return e
	}
	return send(w, result)
}

// Device credentials and pending grants intentionally stay outside logical
// backups: restoring a library must never restore another device's access.
