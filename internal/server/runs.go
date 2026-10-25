package server

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func terminal(state string) bool {
	return state == "completed" || state == "failed" || state == "canceled" || state == "interrupted" || state == "truncated"
}
func providerError(status int) error {
	switch status {
	case 401, 403:
		return problem(502, "PROVIDER_AUTH_FAILED", "服务商认证失败，请检查密钥与权限", false)
	case 429:
		return problem(429, "PROVIDER_RATE_LIMITED", "服务商限流，请稍后主动重新生成", true)
	default:
		return problem(502, "PROVIDER_FAILED", "服务商拒绝或未完成请求，请检查配置后主动重试", true)
	}
}
func (s *Server) providerRequest(ctx context.Context, cfg M, messages []M) (*http.Response, error) {
	s.mu.Lock()
	key, ok := s.credentials[str(cfg, "id")+":"+str(cfg, "credentialVersion")]
	s.mu.Unlock()
	if !ok {
		return nil, problem(400, "CREDENTIAL_MISSING", "创建运行时绑定的密钥已失效，请重新配置后主动发送", false)
	}
	upstream := []M{}
	for _, message := range messages {
		m := M{}
		for k, v := range message {
			m[k] = v
		}
		if str(m, "role") == "system" {
			role := str(cfg, "systemRole")
			if role == "none" {
				m["role"] = "user"
			} else {
				m["role"] = role
			}
		}
		upstream = append(upstream, m)
	}
	stream, _ := cfg["streaming"].(bool)
	payload := M{"model": cfg["modelId"], "messages": upstream, "stream": stream}
	payload[str(cfg, "outputLimitField")] = num(cfg, "generatedTokenCap")
	if include, _ := cfg["includeUsage"].(bool); stream && include {
		payload["stream_options"] = M{"include_usage": true}
	}
	request, e := http.NewRequestWithContext(ctx, "POST", str(cfg, "baseUrl")+"/chat/completions", strings.NewReader(js(payload)))
	if e != nil {
		return nil, e
	}
	request.Header.Set("Authorization", "Bearer "+key.Value)
	request.Header.Set("Content-Type", "application/json")
	return (&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(request)
}
func (s *Server) persist(runID, delta, state, code, message string, usage any) error {
	return s.transaction(func(tx *sql.Tx) error {
		run, e := one(tx, "SELECT * FROM ai_runs WHERE id=?", runID)
		if e != nil {
			return e
		}
		if terminal(str(run, "state")) {
			return nil
		}
		seq := num(run, "lastSeq")
		event := func(kind string, payload any) error {
			seq++
			return exec(tx, "INSERT INTO run_events VALUES(?,?,?,?)", runID, seq, kind, js(payload))
		}
		if delta != "" {
			if e = exec(tx, "UPDATE messages SET body=body||? WHERE id=?", delta, run["assistantMessageId"]); e != nil {
				return e
			}
			if e = event("text_delta", M{"text": delta}); e != nil {
				return e
			}
		}
		if state != "" {
			if e = event("status", M{"state": state}); e != nil {
				return e
			}
		}
		if usage != nil {
			if e = event("usage", usage); e != nil {
				return e
			}
			if e = exec(tx, "UPDATE ai_runs SET usage_json=? WHERE id=?", js(usage), runID); e != nil {
				return e
			}
		}
		if code != "" {
			if e = event("error", M{"code": code, "message": message}); e != nil {
				return e
			}
		}
		if terminal(state) {
			body, e := one(tx, "SELECT body FROM messages WHERE id=?", run["assistantMessageId"])
			if e != nil {
				return e
			}
			c, e := one(tx, "SELECT sources_json FROM contexts WHERE id=?", run["snapshotId"])
			if e != nil {
				return e
			}
			labels := map[string]M{}
			for _, raw := range arr(c, "sources") {
				source, _ := raw.(map[string]any)
				labels[str(source, "localLabel")] = source
			}
			for _, match := range regexp.MustCompile(`\[(S\d+)\]`).FindAllStringSubmatch(str(body, "body"), -1) {
				if source, ok := labels[match[1]]; ok {
					if e = event("citation", M{"label": match[1], "source": source}); e != nil {
						return e
					}
				}
			}
			if e = event("done", M{"state": state}); e != nil {
				return e
			}
			if e = exec(tx, "UPDATE attempts SET state=?,ended_at=?,error_code=? WHERE run_id=? AND state='generating'", state, now(), code, runID); e != nil {
				return e
			}
			if e = exec(tx, "UPDATE ai_runs SET ended_at=? WHERE id=?", now(), runID); e != nil {
				return e
			}
		}
		if state == "" {
			state = str(run, "state")
		}
		return exec(tx, "UPDATE ai_runs SET state=?,error_code=?,error_message=?,last_seq=? WHERE id=?", state, code, message, seq, runID)
	})
}
func (s *Server) dispatch() {
	if s.ctx.Err() != nil {
		return
	}
	s.mu.Lock()
	if len(s.running)+len(s.videoJobs) >= 2 {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	queued, e := all(s.db, "SELECT r.id,m.thread_id FROM ai_runs r JOIN messages m ON m.id=r.message_id WHERE r.state='queued' ORDER BY r.created_at LIMIT 20")
	if e != nil {
		return
	}
	for _, v := range queued {
		s.mu.Lock()
		if len(s.running)+len(s.videoJobs) >= 2 {
			s.mu.Unlock()
			return
		}
		if _, exists := s.running[str(v, "id")]; exists {
			s.mu.Unlock()
			continue
		}
		s.mu.Unlock()
		active, e := all(s.db, "SELECT r.id FROM ai_runs r JOIN messages m ON m.id=r.message_id WHERE m.thread_id=? AND r.state IN ('preparing','generating')", v["threadId"])
		if e != nil || len(active) > 0 {
			continue
		}
		if e = s.persist(str(v, "id"), "", "preparing", "", "", nil); e != nil {
			continue
		}
		ctx, cancel := context.WithCancel(s.ctx)
		s.mu.Lock()
		if len(s.running)+len(s.videoJobs) >= 2 {
			s.mu.Unlock()
			cancel()
			// A video request can reserve the last slot while context is prepared.
			_ = s.persist(str(v, "id"), "", "queued", "", "", nil)
			return
		}
		s.running[str(v, "id")] = cancel
		s.workers.Add(1)
		s.mu.Unlock()
		go func(runID string) {
			defer s.workers.Done()
			defer func() { s.mu.Lock(); delete(s.running, runID); s.mu.Unlock(); cancel() }()
			s.generate(ctx, runID)
		}(str(v, "id"))
	}
}
func (s *Server) generate(parent context.Context, runID string) {
	run, e := one(s.db, "SELECT * FROM ai_runs WHERE id=?", runID)
	if e != nil || terminal(str(run, "state")) {
		return
	}
	snapshot, e := one(s.db, "SELECT * FROM contexts WHERE id=?", run["snapshotId"])
	if e != nil {
		return
	}
	cfg := obj(snapshot, "config")
	ctx, cancel := context.WithTimeout(parent, time.Duration(num(cfg, "timeout"))*time.Second)
	defer cancel()
	messages := []M{}
	for _, raw := range arr(snapshot, "messages") {
		m, _ := raw.(map[string]any)
		messages = append(messages, m)
	}
	if str(cfg, "protocol") != "mock" {
		s.mu.Lock()
		_, ok := s.credentials[str(cfg, "id")+":"+str(cfg, "credentialVersion")]
		s.mu.Unlock()
		if !ok {
			_ = s.persist(runID, "", "failed", "CREDENTIAL_MISSING", "运行绑定的会话密钥已失效，请重新配置后主动发送", nil)
			return
		}
	}
	e = s.transaction(func(tx *sql.Tx) error {
		r, e := one(tx, "SELECT state FROM ai_runs WHERE id=?", runID)
		if e != nil {
			return e
		}
		if terminal(str(r, "state")) {
			return context.Canceled
		}
		return exec(tx, "INSERT INTO attempts(id,run_id,state,started_at) VALUES(?,?,'generating',?)", id(), runID, now())
	})
	if e != nil {
		return
	}
	if e = s.persist(runID, "", "generating", "", "", nil); e != nil {
		return
	}
	pending := strings.Builder{}
	last := time.Now()
	flush := func(force bool) error {
		if pending.Len() == 0 {
			return nil
		}
		if !force && pending.Len() < 1024 && time.Since(last) < 250*time.Millisecond {
			return nil
		}
		delta := pending.String()
		if e := s.persist(runID, delta, "", "", "", nil); e != nil {
			return e
		}
		pending.Reset()
		last = time.Now()
		return nil
	}
	accept := func(text string) error { pending.WriteString(text); return flush(false) }
	state := "completed"
	var usage any
	if str(cfg, "protocol") == "mock" {
		scenario := str(cfg, "mockScenario")
		switch scenario {
		case "auth":
			e = providerError(401)
		case "rate":
			e = providerError(429)
		case "timeout":
			select {
			case <-ctx.Done():
				e = ctx.Err()
			case <-time.After(time.Duration(num(cfg, "timeout")+1) * time.Second):
				e = context.DeadlineExceeded
			}
		default:
			text := "【模拟回答，未调用真实模型】\n\n这段材料说明：同一个操作重复执行时，最终效果应保持一致。[S1]\n\n补充示例：订单接口可使用请求编号和数据库唯一约束，返回已保存的结果。实际实现仍需结合业务事务边界。"
			if scenario == "citation" {
				text += "不存在的来源 [S999] 不能作为有效证据。"
			}
			for _, r := range []rune(text) {
				select {
				case <-ctx.Done():
					e = ctx.Err()
				default:
					e = accept(string(r))
				}
				if e != nil {
					break
				}
				if scenario == "partial" && pending.Len() > 120 {
					e = io.ErrUnexpectedEOF
					break
				}
				select {
				case <-ctx.Done():
					e = ctx.Err()
				case <-time.After(12 * time.Millisecond):
				}
				if e != nil {
					break
				}
			}
			if scenario == "truncated" {
				state = "truncated"
			}
		}
	} else {
		var response *http.Response
		response, e = s.providerRequest(ctx, cfg, messages)
		if e == nil {
			defer response.Body.Close()
			if response.StatusCode != 200 {
				e = providerError(response.StatusCode)
			} else if stream, _ := cfg["streaming"].(bool); stream {
				scanner := bufio.NewScanner(response.Body)
				scanner.Buffer(make([]byte, 4096), 2<<20)
				finished := false
				for scanner.Scan() {
					line := scanner.Text()
					if !strings.HasPrefix(line, "data:") {
						continue
					}
					data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
					if data == "[DONE]" {
						finished = true
						break
					}
					var chunk M
					if json.Unmarshal([]byte(data), &chunk) != nil {
						e = problem(502, "PROVIDER_INVALID_RESPONSE", "服务商流式响应格式无效", false)
						break
					}
					if chunk["error"] != nil {
						e = problem(502, "PROVIDER_STREAM_FAILED", "服务商在生成中返回错误，已保存部分回答", true)
						break
					}
					if chunk["usage"] != nil {
						usage = chunk["usage"]
					}
					for _, raw := range arr(chunk, "choices") {
						choice, _ := raw.(map[string]any)
						if str(choice, "finish_reason") == "length" {
							state = "truncated"
						}
						if str(choice, "finish_reason") != "" {
							finished = true
						}
						if text := str(obj(choice, "delta"), "content"); text != "" {
							e = accept(text)
							if e != nil {
								break
							}
						}
					}
					if e != nil {
						break
					}
				}
				if e == nil {
					e = scanner.Err()
				}
				if e == nil && !finished {
					e = io.ErrUnexpectedEOF
				}
			} else {
				var payload M
				data, readErr := io.ReadAll(io.LimitReader(response.Body, 8<<20))
				e = readErr
				if e == nil {
					e = json.Unmarshal(data, &payload)
				}
				if e == nil {
					choices := arr(payload, "choices")
					if len(choices) == 0 {
						e = problem(502, "PROVIDER_INVALID_RESPONSE", "服务商没有返回回答", false)
					} else {
						choice, _ := choices[0].(map[string]any)
						if str(choice, "finish_reason") == "length" {
							state = "truncated"
						}
						e = accept(str(obj(choice, "message"), "content"))
						usage = payload["usage"]
					}
				}
			}
		}
	}
	if flushErr := flush(true); flushErr != nil {
		return
	}
	code, message := "", ""
	if e != nil {
		state = "failed"
		code = "PROVIDER_STREAM_FAILED"
		message = "生成未完成，已保存部分内容；可主动重新生成"
		var ae *apiError
		if errors.As(e, &ae) {
			code = ae.Code
			message = ae.Message
		}
		if errors.Is(e, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code = "PROVIDER_TIMEOUT"
			message = "请求超时，是否已计费未知；不会自动重发"
		}
		if parent.Err() != nil {
			state = "interrupted"
			code = "PROCESS_STOPPED"
			message = "程序已停止，部分回答已保存"
		}
	}
	_ = s.persist(runID, "", state, code, message, usage)
}
func (s *Server) runView(runID string) (M, error) {
	v, e := one(s.db, "SELECT r.*,m.body,c.config_json,c.sources_json,c.messages_json,c.omissions_json,c.content_hash FROM ai_runs r JOIN messages m ON m.id=r.assistant_message_id JOIN contexts c ON c.id=r.snapshot_id WHERE r.id=?", runID)
	if e != nil {
		return nil, e
	}
	v["attempts"], e = all(s.db, "SELECT * FROM attempts WHERE run_id=? ORDER BY started_at", runID)
	if e != nil {
		return nil, e
	}
	return v, nil
}
func (s *Server) runRoutes() {
	s.route("GET /api/ai-runs/{r}", func(w http.ResponseWriter, r *http.Request) error {
		v, e := s.runView(r.PathValue("r"))
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("POST /api/ai-runs/{r}/cancel", func(w http.ResponseWriter, r *http.Request) error {
		if e := s.persist(r.PathValue("r"), "", "canceled", "", "", nil); e != nil {
			return e
		}
		s.mu.Lock()
		cancel := s.running[r.PathValue("r")]
		s.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		v, e := s.runView(r.PathValue("r"))
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("POST /api/ai-runs/{r}/retry", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		result, e := s.idem("retry:"+r.PathValue("r"), str(b, "clientRequestId"), b, func(tx *sql.Tx) (M, error) {
			old, e := one(tx, "SELECT r.*,m.thread_id FROM ai_runs r JOIN messages m ON m.id=r.message_id WHERE r.id=?", r.PathValue("r"))
			if e != nil {
				return nil, e
			}
			active, e := all(tx, "SELECT r.id FROM ai_runs r JOIN messages m ON m.id=r.message_id WHERE m.thread_id=? AND r.state IN ('queued','preparing','generating')", old["threadId"])
			if e != nil {
				return nil, e
			}
			if len(active) > 0 {
				return nil, problem(409, "RUN_ACTIVE", "请先等待或停止当前回答", false)
			}
			runID, assistant := id(), id()
			if e = exec(tx, "INSERT INTO messages(id,thread_id,role,recipient,body,created_at) VALUES(?,?,'assistant','note','',?)", assistant, old["threadId"], now()); e != nil {
				return nil, e
			}
			if e = exec(tx, "INSERT INTO ai_runs(id,message_id,assistant_message_id,snapshot_id,state,retry_of_run_id,created_at) VALUES(?,?,?,?,'queued',?,?)", runID, old["messageId"], assistant, old["snapshotId"], old["id"], now()); e != nil {
				return nil, e
			}
			return M{"id": runID, "threadId": old["threadId"], "snapshotId": old["snapshotId"]}, nil
		})
		if e != nil {
			return e
		}
		return send(w, result)
	})
	s.route("GET /api/ai-runs/{r}/events", func(w http.ResponseWriter, r *http.Request) error {
		v, e := s.runView(r.PathValue("r"))
		if e != nil {
			return e
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			return problem(500, "STREAM_UNAVAILABLE", "当前连接不支持流式订阅", false)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Accel-Buffering", "no")
		after, _ := strconv.Atoi(r.URL.Query().Get("afterSeq"))
		if n, _ := strconv.Atoi(r.Header.Get("Last-Event-ID")); n > after {
			after = n
		}
		last := num(v, "lastSeq")
		if after < 0 || after > last {
			after = 0
		}
		snapshot := M{"runId": r.PathValue("r"), "seq": last, "type": "snapshot", "payload": M{"body": v["body"], "state": v["state"], "lastSeq": last, "errorMessage": v["errorMessage"]}}
		if _, e = fmt.Fprintf(w, "id: %d\ndata: %s\n\n", last, js(snapshot)); e != nil {
			return nil
		}
		flusher.Flush()
		after = last
		if terminal(str(v, "state")) {
			return nil
		}
		tick := time.NewTicker(150 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-r.Context().Done():
				return nil
			case <-s.ctx.Done():
				return nil
			case <-tick.C:
				events, e := all(s.db, "SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200", r.PathValue("r"), after)
				if e != nil {
					return nil
				}
				for _, event := range events {
					out := M{"runId": r.PathValue("r"), "seq": event["seq"], "type": event["type"], "payload": event["payload"]}
					if _, e = fmt.Fprintf(w, "id: %d\ndata: %s\n\n", num(event, "seq"), js(out)); e != nil {
						return nil
					}
					after = num(event, "seq")
					flusher.Flush()
					if str(event, "type") == "done" {
						return nil
					}
				}
				if len(events) == 0 {
					_, _ = io.WriteString(w, ": keepalive\n\n")
					flusher.Flush()
					state, e := one(s.db, "SELECT state FROM ai_runs WHERE id=?", r.PathValue("r"))
					if e != nil || terminal(str(state, "state")) {
						return nil
					}
				}
			}
		}
	})
}
