package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode"
)

func providerConfig(b M) M {
	cfg := M{}
	for _, k := range []string{"inputBudget", "generatedTokenCap", "contextWindow", "timeout", "streaming", "systemRole", "outputLimitField", "includeUsage", "mockScenario", "platformId", "models"} {
		if v, ok := obj(b, "config")[k]; ok {
			cfg[k] = v
		}
		if v, ok := b[k]; ok {
			cfg[k] = v
		}
	}
	for k, v := range (M{"inputBudget": 8000, "generatedTokenCap": 2000, "contextWindow": 32000, "timeout": 60, "streaming": true, "systemRole": "system", "outputLimitField": "max_tokens"}) {
		if cfg[k] == nil {
			cfg[k] = v
		}
	}
	return cfg
}
func (s *Server) providerEndpoint(b M) (string, error) {
	protocol := str(b, "protocol")
	if protocol != "openai" && !(protocol == "mock" && s.cfg.AllowMock) {
		return "", problem(400, "UNSUPPORTED_PROVIDER", "不支持此协议；模拟服务仅在 --allow-mock 时启用", false)
	}
	base := strings.TrimRight(strings.TrimSpace(str(b, "baseUrl")), "/")
	if strings.HasSuffix(base, "/chat/completions") {
		base = strings.TrimSuffix(base, "/chat/completions")
	}
	u, e := url.Parse(base)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"))) {
		return "", problem(400, "INVALID_ENDPOINT", "请输入 HTTPS API 基地址；本机服务可使用 HTTP", false)
	}
	return base, nil
}
func (s *Server) saveProvider(b M, providerID string) (M, error) {
	base, e := s.providerEndpoint(b)
	if e != nil {
		return nil, e
	}
	protocol := str(b, "protocol")
	if strings.TrimSpace(str(b, "name")) == "" {
		return nil, problem(400, "INVALID_PROVIDER", "请输入提供方名称", false)
	}
	cfg := providerConfig(b)
	models, e := normalizedModels(cfg, str(b, "modelId"))
	if e != nil {
		return nil, e
	}
	cfg["models"] = models
	if str(b, "modelId") != "" && !hasModel(models, str(b, "modelId")) {
		return nil, problem(400, "INVALID_MODEL", "默认模型必须在模型列表中", false)
	}
	if str(b, "modelId") == "" && len(models) > 0 {
		b["modelId"] = models[0]
	}
	if b["modelId"] == nil {
		b["modelId"] = ""
	}
	if num(cfg, "inputBudget") < 128 || num(cfg, "inputBudget") > 200000 || num(cfg, "generatedTokenCap") < 1 || num(cfg, "generatedTokenCap") > 32000 || num(cfg, "contextWindow") < 1024 || num(cfg, "timeout") < 1 || num(cfg, "timeout") > 600 {
		return nil, problem(400, "INVALID_PROVIDER", "预算、生成上限、容量或超时超出范围", false)
	}
	if x := str(cfg, "systemRole"); x != "system" && x != "developer" && x != "none" {
		return nil, problem(400, "INVALID_PROVIDER", "system 角色映射无效", false)
	}
	if x := str(cfg, "outputLimitField"); x != "max_tokens" && x != "max_completion_tokens" {
		return nil, problem(400, "INVALID_PROVIDER", "输出上限字段无效", false)
	}
	key := str(b, "apiKey")
	if len(key) > 8192 {
		return nil, problem(400, "INVALID_CREDENTIAL", "密钥过长", false)
	}
	credentialVersion := ""
	revision := 1
	e = s.transaction(func(tx *sql.Tx) error {
		if providerID != "" {
			old, e := one(tx, "SELECT * FROM providers WHERE id=?", providerID)
			if e != nil {
				return e
			}
			if num(b, "revision") != num(old, "revision") {
				return problem(409, "REVISION_CONFLICT", "模型配置已更新，请重新载入", false)
			}
			if obj(old, "config")["archived"] == true {
				return problem(404, "NOT_FOUND", "提供方已删除", false)
			}
			credentialVersion = str(old, "credentialVersion")
			if targetHash(old) != targetHash(M{"protocol": protocol, "baseUrl": base}) {
				credentialVersion = ""
			}
			revision = num(old, "revision") + 1
		} else {
			providerID = id()
		}
		if key != "" {
			credentialVersion = id()
		}
		return exec(tx, "INSERT INTO providers VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,protocol=excluded.protocol,base_url=excluded.base_url,model_id=excluded.model_id,config_json=excluded.config_json,revision=excluded.revision,credential_version=excluded.credential_version", providerID, b["name"], protocol, base, b["modelId"], js(cfg), revision, credentialVersion, now())
	})
	if e != nil {
		return nil, e
	}
	if key != "" {
		s.mu.Lock()
		s.credentials[providerID+":"+credentialVersion] = credential{key, credentialVersion}
		s.mu.Unlock()
	}
	s.mu.Lock()
	_, bound := s.credentials[providerID+":"+credentialVersion]
	s.mu.Unlock()
	return M{"id": providerID, "revision": revision, "credentialBound": bound}, nil
}
func (s *Server) aiRoutes() {
	s.route("GET /api/provider-platforms", func(w http.ResponseWriter, r *http.Request) error { return send(w, providerPlatforms) })
	s.route("POST /api/provider-models", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		base, e := s.providerEndpoint(b)
		if e != nil {
			return e
		}
		key := str(b, "apiKey")
		if len(key) > 8192 {
			return problem(400, "INVALID_CREDENTIAL", "密钥过长", false)
		}
		if key == "" && str(b, "id") != "" {
			p, e := one(s.db, "SELECT * FROM providers WHERE id=?", b["id"])
			if e != nil {
				return e
			}
			if obj(p, "config")["archived"] == true {
				return problem(404, "NOT_FOUND", "提供方已删除", false)
			}
			if targetHash(p) != targetHash(M{"protocol": b["protocol"], "baseUrl": base}) {
				return problem(400, "CREDENTIAL_MISSING", "地址已变化，请为新地址填写密钥", false)
			}
			s.mu.Lock()
			key = s.credentials[str(p, "id")+":"+str(p, "credentialVersion")].Value
			s.mu.Unlock()
		}
		models, e := s.discoverModels(r.Context(), base, str(b, "protocol"), key)
		if e != nil {
			return e
		}
		return send(w, M{"models": models})
	})
	s.route("GET /api/providers", func(w http.ResponseWriter, r *http.Request) error {
		v, e := all(s.db, "SELECT * FROM providers ORDER BY created_at")
		if e != nil {
			return e
		}
		active := []M{}
		for _, p := range v {
			if obj(p, "config")["archived"] == true {
				continue
			}
			models, _ := normalizedModels(obj(p, "config"), str(p, "modelId"))
			p["models"] = models
			enabled, e := all(s.db, "SELECT workspace_id,target_hash FROM provider_enablings WHERE provider_id=?", p["id"])
			if e != nil {
				return e
			}
			workspaces := []string{}
			for _, en := range enabled {
				if str(en, "targetHash") == targetHash(p) {
					workspaces = append(workspaces, str(en, "workspaceId"))
				}
			}
			p["enabledWorkspaceIds"] = workspaces
			active = append(active, p)
			s.mu.Lock()
			_, bound := s.credentials[str(p, "id")+":"+str(p, "credentialVersion")]
			s.mu.Unlock()
			p["credentialBound"] = bound
		}
		return send(w, active)
	})
	s.route("POST /api/providers", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		v, e := s.saveProvider(b, "")
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("PATCH /api/providers/{p}", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		v, e := s.saveProvider(b, r.PathValue("p"))
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("DELETE /api/providers/{p}", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		e = s.transaction(func(tx *sql.Tx) error {
			p, e := one(tx, "SELECT * FROM providers WHERE id=?", r.PathValue("p"))
			if e != nil {
				return e
			}
			if num(p, "revision") != num(b, "revision") {
				return problem(409, "REVISION_CONFLICT", "提供方已更新，请重新载入", false)
			}
			active, e := all(tx, "SELECT r.id FROM ai_runs r JOIN contexts c ON c.id=r.snapshot_id WHERE c.provider_id=? AND r.state IN ('queued','preparing','generating')", p["id"])
			if e != nil {
				return e
			}
			if len(active) > 0 {
				return problem(409, "PROVIDER_BUSY", "此提供方仍有问答运行，请先停止或等待完成", false)
			}
			cfg := obj(p, "config")
			cfg["archived"] = true
			if e = exec(tx, "UPDATE providers SET config_json=?,revision=revision+1 WHERE id=?", js(cfg), p["id"]); e != nil {
				return e
			}
			return exec(tx, "DELETE FROM provider_enablings WHERE provider_id=?", p["id"])
		})
		if e != nil {
			return e
		}
		s.mu.Lock()
		for k := range s.credentials {
			if strings.HasPrefix(k, r.PathValue("p")+":") {
				delete(s.credentials, k)
			}
		}
		s.mu.Unlock()
		return send(w, M{"ok": true})
	})
	s.route("DELETE /api/workspaces/{w}/providers/{p}/enable", func(w http.ResponseWriter, r *http.Request) error {
		if e := exec(s.db, "DELETE FROM provider_enablings WHERE workspace_id=? AND provider_id=?", r.PathValue("w"), r.PathValue("p")); e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("DELETE /api/providers/{p}/credential", func(w http.ResponseWriter, r *http.Request) error {
		s.mu.Lock()
		for k := range s.credentials {
			if strings.HasPrefix(k, r.PathValue("p")+":") {
				delete(s.credentials, k)
			}
		}
		s.mu.Unlock()
		return send(w, M{"ok": true})
	})
	s.route("POST /api/workspaces/{w}/providers/{p}/enable", func(w http.ResponseWriter, r *http.Request) error {
		e := s.transaction(func(tx *sql.Tx) error {
			p, e := one(tx, "SELECT * FROM providers WHERE id=?", r.PathValue("p"))
			if e != nil {
				return e
			}
			if obj(p, "config")["archived"] == true {
				return problem(404, "NOT_FOUND", "提供方已删除", false)
			}
			return exec(tx, "INSERT INTO provider_enablings VALUES(?,?,?) ON CONFLICT(workspace_id,provider_id) DO UPDATE SET target_hash=excluded.target_hash", r.PathValue("w"), p["id"], targetHash(p))
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("POST /api/contexts/preview", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		var result M
		e = s.transaction(func(tx *sql.Tx) error {
			thread := M{"anchor": b["anchor"], "workspaceDocumentId": b["workspaceDocumentId"], "threadId": b["threadId"]}
			if str(b, "threadId") != "" {
				t, e := s.threadData(tx, "WHERE t.id=?", b["threadId"])
				if e != nil {
					return e
				}
				if len(t) == 0 || t[0]["workspaceDocumentId"] != b["workspaceDocumentId"] {
					return problem(403, "PATH_NOT_ALLOWED", "线程不属于当前文档", false)
				}
				thread = t[0]
			}
			if e := s.validateAnchor(tx, str(thread, "workspaceDocumentId"), str(obj(thread, "anchor"), "documentVersionId"), obj(thread, "anchor")); e != nil {
				return e
			}
			var e error
			result, e = s.buildContext(tx, thread, b)
			return e
		})
		if e != nil {
			return e
		}
		return send(w, result)
	})
	s.route("POST /api/providers/{p}/test", func(w http.ResponseWriter, r *http.Request) error {
		p, e := one(s.db, "SELECT * FROM providers WHERE id=?", r.PathValue("p"))
		if e != nil {
			return e
		}
		if obj(p, "config")["archived"] == true {
			return problem(404, "NOT_FOUND", "提供方已删除", false)
		}
		if str(p, "protocol") == "mock" {
			return send(w, M{"message": "模拟连接正常（未验证真实 API）"})
		}
		if str(p, "modelId") == "" {
			return problem(400, "MODEL_REQUIRED", "请先添加并保存模型", false)
		}
		cfg := obj(p, "config")
		for _, k := range []string{"id", "baseUrl", "modelId", "credentialVersion", "protocol"} {
			cfg[k] = p[k]
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		cfg["generatedTokenCap"] = 16
		cfg["streaming"] = false
		response, e := s.providerRequest(ctx, cfg, []M{{"role": "user", "content": "Reply with OK."}})
		if e != nil {
			return e
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return providerError(response.StatusCode)
		}
		data, e := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		if e != nil {
			return e
		}
		var v M
		if json.Unmarshal(data, &v) != nil || len(arr(v, "choices")) == 0 {
			return problem(502, "PROVIDER_INVALID_RESPONSE", "服务商没有返回 Chat Completions 响应", false)
		}
		return send(w, M{"message": "真实 API 连接验证通过（固定短文本）"})
	})
	s.route("GET /api/providers/{p}/models", func(w http.ResponseWriter, r *http.Request) error {
		p, e := one(s.db, "SELECT * FROM providers WHERE id=?", r.PathValue("p"))
		if e != nil {
			return e
		}
		if obj(p, "config")["archived"] == true {
			return problem(404, "NOT_FOUND", "提供方已删除", false)
		}
		s.mu.Lock()
		key := s.credentials[str(p, "id")+":"+str(p, "credentialVersion")].Value
		s.mu.Unlock()
		models, e := s.discoverModels(r.Context(), str(p, "baseUrl"), str(p, "protocol"), key)
		if e != nil {
			return e
		}
		return send(w, M{"models": models})
	})
	s.runRoutes()
}

// Legacy profiles with one model remain usable without a schema migration.
func normalizedModels(cfg M, fallback string) ([]string, error) {
	values, exists := cfg["models"]
	raw := []any{}
	if exists {
		switch v := values.(type) {
		case []any:
			raw = v
		case []string:
			for _, x := range v {
				raw = append(raw, x)
			}
		default:
			return nil, problem(400, "INVALID_MODEL", "模型列表格式无效", false)
		}
	} else if fallback != "" {
		raw = append(raw, fallback)
	}
	if len(raw) > 256 {
		return nil, problem(400, "INVALID_MODEL", "每个提供方最多添加 256 个模型", false)
	}
	models := []string{}
	seen := map[string]bool{}
	for _, value := range raw {
		name, ok := value.(string)
		name = strings.TrimSpace(name)
		if !ok || name == "" || len(name) > 256 || strings.ContainsFunc(name, unicode.IsControl) {
			return nil, problem(400, "INVALID_MODEL", "模型 ID 不能为空、过长或含控制字符", false)
		}
		if !seen[name] {
			models = append(models, name)
			seen[name] = true
		}
	}
	return models, nil
}
func hasModel(models []string, model string) bool {
	for _, v := range models {
		if v == model {
			return true
		}
	}
	return false
}
func (s *Server) discoverModels(parent context.Context, base, protocol, key string) ([]string, error) {
	if protocol == "mock" {
		return []string{"mock-reading"}, nil
	}
	if key == "" {
		return nil, problem(400, "CREDENTIAL_MISSING", "请填写此提供方的 API Key", false)
	}
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	modelsURL := base + "/models"
	for _, platform := range providerPlatforms {
		if str(platform, "baseUrl") == base && str(platform, "modelsUrl") != "" {
			modelsURL = str(platform, "modelsUrl")
			break
		}
	}
	req, e := http.NewRequestWithContext(ctx, "GET", modelsURL, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Authorization", "Bearer "+key)
	response, e := (&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if e != nil {
		return nil, problem(502, "PROVIDER_UNAVAILABLE", "模型列表请求失败；可手动添加模型 ID", true)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, problem(502, "MODELS_UNAVAILABLE", "无法获取模型列表；可手动添加模型 ID，这不代表生成接口不可用", false)
	}
	var v M
	if json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&v) != nil {
		return nil, problem(502, "MODELS_UNAVAILABLE", "模型列表格式不支持；可手动添加模型 ID", false)
	}
	models := []string{}
	seen := map[string]bool{}
	for _, raw := range arr(v, "data") {
		m, _ := raw.(map[string]any)
		name := str(m, "id")
		if name != "" && len(name) <= 256 && !strings.ContainsFunc(name, unicode.IsControl) && !seen[name] {
			models = append(models, name)
			seen[name] = true
		}
	}
	sort.Strings(models)
	return models, nil
}
