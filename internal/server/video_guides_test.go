package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func guideScript() videoGuideScript {
	return videoGuideScript{Title: "理解幂等设计", Slides: []videoGuideSlide{
		{Title: "为什么重复请求", Narration: "网络会重试，所以同一操作可能被执行多次。首先要理解这里的输入与业务效果。", Layout: "concept", Items: []videoGuideItem{{Label: "重复请求", Detail: "同一意图可能多次到达服务端"}}, SourceIDs: []string{"S1"}},
		{Title: "怎样保证结果", Narration: "把请求编号和结果一起保存，重试时先检查已经保存的结果。这里还需要考虑事务边界。", Layout: "steps", Items: []videoGuideItem{{Label: "保存结果", Detail: "将请求编号和业务结果一起保存"}, {Label: "返回结果", Detail: "重试返回同一结果"}}, SourceIDs: []string{"S1"}},
		{Title: "明确适用边界", Narration: "幂等不代表所有并发问题都会自动解决。仍然需要核对材料中的唯一约束与事务条件。", Layout: "comparison", Items: []videoGuideItem{{Label: "已有保障", Detail: "重复请求返回既有结果"}, {Label: "仍需核对", Detail: "事务与业务边界"}}, SourceIDs: []string{"S1"}},
	}}
}

func guideSetup(t *testing.T, upstream string, text string) (*testClient, M, M, string, M) {
	t.Helper()
	c := newClient(t, Config{AllowMock: true})
	x := c.sample(text)
	provider := M{"name": "讲解测试", "protocol": "openai", "baseUrl": upstream, "apiKey": "fixture-only-key", "modelId": "fixture-model", "generatedTokenCap": 2000, "inputBudget": 8000}
	if upstream == "" {
		provider["protocol"] = "mock"
		provider["baseUrl"] = "http://127.0.0.1:1"
	}
	p := c.ok("POST", "/api/providers", provider)
	c.ok("POST", "/api/workspaces/"+str(x.w, "id")+"/providers/"+str(p, "id")+"/enable", M{})
	version := str(obj(x.prepared, "version"), "id")
	c.ok("PUT", "/api/documents/"+str(x.d, "id")+"/search-index", M{"versionId": version, "sections": []M{{"position": 0, "label": "幂等设计", "locator": M{"scrollTop": 0}, "text": text}}, "replace": true, "complete": true})
	base := "/api/documents/" + str(x.d, "id") + "/video-guides"
	request := M{"versionId": version, "mode": "overview", "goal": "理解请求重试", "modelProfileId": p["id"], "modelId": "fixture-model"}
	return c, x.w, p, base, request
}

func guideGeneration(c *testClient, base string, request M) M {
	p := c.ok("POST", base+"/preview", request)
	b := M{}
	for k, v := range request {
		b[k] = v
	}
	b["fingerprint"], b["clientRequestId"] = p["fingerprint"], id()
	return b
}

func TestVideoGuidePreviewCacheAndRequestIdempotency(t *testing.T) {
	var calls atomic.Int32
	received := make(chan M, 8)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		payload := M{}
		json.NewDecoder(r.Body).Decode(&payload)
		received <- payload
		if r.Header.Get("Authorization") != "Bearer fixture-only-key" {
			t.Error("wrong provider credential")
		}
		json.NewEncoder(w).Encode(M{"choices": []M{{"message": M{"content": js(guideScript())}, "finish_reason": "stop"}}})
	}))
	defer upstream.Close()
	c, _, p, base, request := guideSetup(t, upstream.URL, "重复请求应当通过请求编号和唯一约束，返回已经保存的相同结果。")
	gen := guideGeneration(c, base, request)
	if calls.Load() != 0 {
		t.Fatal("preview called the paid provider")
	}
	first := c.ok("POST", base, gen)
	payload := <-received
	if calls.Load() != 1 || str(obj(first, "script"), "title") != "理解幂等设计" || payload["stream"] != false || str(payload, "model") != "fixture-model" {
		t.Fatal(first, payload, calls.Load())
	}
	if len(arr(payload, "messages")) != 2 || !strings.Contains(js(payload["messages"]), "S1") {
		t.Fatal("source package missing")
	}
	if repeat := c.ok("POST", base, gen); js(repeat) != js(first) || calls.Load() != 1 {
		t.Fatal("request retry generated again")
	}
	gen["clientRequestId"] = id()
	if cached := c.ok("POST", base, gen); js(cached) != js(first) || calls.Load() != 1 {
		t.Fatal("same plan did not reuse cache")
	}
	gen["regenerate"] = true
	second := c.ok("POST", base, gen)
	if calls.Load() != 2 || second["requestId"] == first["requestId"] {
		t.Fatal("explicit regeneration did not create a new result")
	}
	gen["clientRequestId"] = first["requestId"]
	if old := c.ok("POST", base, gen); old["createdAt"] != first["createdAt"] || calls.Load() != 2 {
		t.Fatal("old request ID was charged again after regeneration")
	}
	version := str(request, "versionId")
	c.ok("DELETE", "/api/providers/"+str(p, "id")+"/credential", M{})
	if len(c.list(base+"?version="+version)) != 2 {
		t.Fatal("cached guides require live credentials")
	}
	files, _ := os.ReadDir(c.s.videoGuideDir(strings.Split(base, "/")[3], version))
	if len(files) != 2 {
		t.Fatal("cache records missing", files)
	}
	for _, file := range files {
		path := c.s.videoGuideDir(strings.Split(base, "/")[3], version) + "/" + file.Name()
		info, _ := os.Stat(path)
		data, _ := os.ReadFile(path)
		if info.Mode().Perm() != 0600 || strings.Contains(string(data), "fixture-only-key") || strings.Contains(string(data), "baseUrl") {
			t.Fatal("cache permissions or credential boundary")
		}
	}
}

func TestVideoGuideSamplingPreviewAndConsent(t *testing.T) {
	c, workspace, p, base, request := guideSetup(t, "", strings.Repeat("长章节里的真实文字和边界。", 3000))
	preview := c.ok("POST", base+"/preview", request)
	coverage := obj(preview, "coverage")
	if coverage["partial"] != true || num(coverage, "sentCharacters") >= num(coverage, "totalCharacters") || num(preview, "estimatedInputTokens") > 8000 || len(arr(preview, "sources")) < 2 {
		t.Fatal("sampling was hidden or exceeded the budget", preview)
	}
	for _, raw := range arr(preview, "sources") {
		if !strings.Contains(strings.Repeat("长章节里的真实文字和边界。", 3000), str(raw.(M), "text")) {
			t.Fatal("invented source text")
		}
	}
	gen := guideGeneration(c, base, request)
	c.ok("PUT", strings.TrimSuffix(base, "/video-guides")+"/search-index", M{"versionId": request["versionId"], "sections": []M{{"position": 0, "text": "索引内容已变化", "label": "新内容", "locator": M{}}}, "replace": true, "complete": true})
	if status, result := c.req("POST", base, gen); status != 409 || str(result.(M), "code") != "GUIDE_PREVIEW_CHANGED" {
		t.Fatal("stale preview accepted", status, result)
	}
	c.ok("DELETE", "/api/workspaces/"+str(workspace, "id")+"/providers/"+str(p, "id")+"/enable", M{})
	if status, _ := c.req("POST", base+"/preview", request); status != 403 {
		t.Fatal("disabled provider accepted", status)
	}
	other := c.workspace("另一个工作区")
	if status, _ := c.req("GET", "/api/documents/"+str(other, "id")+"/video-guides?version="+str(request, "versionId"), nil); status == 200 {
		t.Fatal("unrelated membership accessed cache")
	}
}

func TestVideoGuideInvalidOutputIsNotCached(t *testing.T) {
	for _, scenario := range []string{"citation", "html-layout", "truncated", "malformed", "extra-json"} {
		t.Run(scenario, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				script := guideScript()
				finish := "stop"
				if scenario == "citation" {
					script.Slides[0].SourceIDs = []string{"S999"}
				}
				if scenario == "html-layout" {
					script.Slides[0].Layout = "<script>"
				}
				if scenario == "truncated" {
					finish = "length"
				}
				content := js(script)
				if scenario == "malformed" {
					content = "not a script"
				}
				if scenario == "extra-json" {
					content += " {}"
				}
				json.NewEncoder(w).Encode(M{"choices": []M{{"message": M{"content": content}, "finish_reason": finish}}})
			}))
			defer upstream.Close()
			c, _, _, base, request := guideSetup(t, upstream.URL, "请求重试必须检查保存的结果。")
			if status, _ := c.req("POST", base, guideGeneration(c, base, request)); status != 502 {
				t.Fatal(status)
			}
			if len(c.list(base+"?version="+str(request, "versionId"))) != 0 {
				t.Fatal("invalid result was cached")
			}
		})
	}
}

func TestVideoGuideConcurrentRequestsAndCancellation(t *testing.T) {
	started := make(chan struct{}, 4)
	ended := make(chan struct{}, 4)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		ioData := M{}
		json.NewDecoder(r.Body).Decode(&ioData)
		started <- struct{}{}
		<-r.Context().Done()
		ended <- struct{}{}
	}))
	defer upstream.Close()
	c, _, _, base, request := guideSetup(t, upstream.URL, "同一请求应当只执行一次业务效果。")
	gen := guideGeneration(c, base, request)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := httptest.NewRequest("POST", "http://127.0.0.1:7318"+base, strings.NewReader(js(gen))).WithContext(ctx)
	r.AddCookie(c.cookie)
	r.Header.Set("X-CSRF-Token", c.csrf)
	done := make(chan struct{})
	go func() { c.s.Handler().ServeHTTP(httptest.NewRecorder(), r); close(done) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("provider not started")
	}
	if status, _ := c.req("POST", base, gen); status != 409 || calls.Load() != 1 {
		t.Fatal("concurrent duplicate was sent", status)
	}
	secondRequest := M{}
	for k, v := range request {
		secondRequest[k] = v
	}
	secondRequest["goal"] = "另一个明确的阅读目标"
	secondGen := guideGeneration(c, base, secondRequest)
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	r2 := httptest.NewRequest("POST", "http://127.0.0.1:7318"+base, strings.NewReader(js(secondGen))).WithContext(ctx2)
	r2.AddCookie(c.cookie)
	r2.Header.Set("X-CSRF-Token", c.csrf)
	done2 := make(chan struct{})
	go func() { c.s.Handler().ServeHTTP(httptest.NewRecorder(), r2); close(done2) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("second provider call not started")
	}
	secondRequest["goal"] = "第三个阅读目标"
	if status, _ := c.req("POST", base, guideGeneration(c, base, secondRequest)); status != 409 || calls.Load() != 2 {
		t.Fatal("global generation limit exceeded", status, calls.Load())
	}
	cancel()
	cancel2()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("canceled generation did not stop")
	}
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream request not canceled")
	}
	select {
	case <-done2:
	case <-time.After(5 * time.Second):
		t.Fatal("second request not canceled")
	}
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("second upstream request not canceled")
	}
	if len(c.list(base+"?version="+str(request, "versionId"))) != 0 {
		t.Fatal("canceled result cached")
	}
}

func TestVideoGuideVersionIsolationAndChapterSelection(t *testing.T) {
	c, _, _, base, request := guideSetup(t, "", "第一页的来源文字。")
	c.ok("PUT", strings.TrimSuffix(base, "/video-guides")+"/search-index", M{"versionId": request["versionId"], "sections": []M{{"position": 1, "label": "第二章", "locator": M{"pageIndex": 1}, "text": "第二章讨论事务边界。"}}, "replace": false, "complete": true})
	request["mode"], request["sectionPosition"] = "section", 1
	preview := c.ok("POST", base+"/preview", request)
	if len(arr(preview, "sources")) != 1 || str(arr(preview, "sources")[0].(M), "text") != "第二章讨论事务边界。" || obj(preview, "coverage")["partial"] != false {
		t.Fatal("wrong chapter source", preview)
	}
	c.ok("POST", base, guideGeneration(c, base, request))
	if status, _ := c.req("GET", base+"?version=other-version", nil); status == 200 {
		t.Fatal("cache read across versions")
	}
	request["sectionPosition"] = 999
	if status, result := c.req("POST", base+"/preview", request); status != 400 {
		t.Fatal(status, result)
	}
	request["sectionPosition"] = 1.5
	if status, _ := c.req("POST", base+"/preview", request); status != 400 {
		t.Fatal("fractional section", status)
	}
}
