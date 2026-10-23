package server

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/fsnotify/fsnotify"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed migrations/*.sql all:static
var assets embed.FS

type Config struct {
	AndroidAPK   string
	PublicOrigin string
	AccessCode   string
	DataDir      string
	AllowMock    bool
	ScanInterval time.Duration
}
type session struct {
	CSRF    string
	Expires time.Time
}
type credential struct {
	Value   string
	Version string
}
type Server struct {
	downloadMu     sync.Mutex
	download       *mobileDownload
	lanControlMu   sync.Mutex
	lanMu          sync.Mutex
	lanServer      *http.Server
	lanPort        int
	lanFingerprint string
	lanError       string
	db             *sql.DB
	cfg            Config
	mux            *http.ServeMux
	writeMu        sync.Mutex
	importMu       sync.Mutex
	mu             sync.Mutex
	pairCode       string
	sessions       map[string]session
	pickers        map[string]time.Time
	credentials    map[string]credential
	scans          map[string]*ScanJob
	restores       map[string]*restorePlan
	running        map[string]context.CancelFunc
	ctx            context.Context
	cancel         context.CancelFunc
	workers        sync.WaitGroup
	watcher        *fsnotify.Watcher
	watched        map[string]map[string]bool
	lockFile       *os.File
	closeOnce      sync.Once
	closeErr       error
}

func New(cfg Config) (*Server, error) {
	if cfg.PublicOrigin != "" {
		public, e := url.Parse(strings.TrimRight(cfg.PublicOrigin, "/"))
		if e != nil || public.Scheme != "https" || public.Hostname() == "" || public.User != nil || public.Path != "" || public.RawQuery != "" || public.Fragment != "" {
			return nil, fmt.Errorf("public-url 必须是无路径、无凭据的 HTTPS 来源")
		}
		cfg.PublicOrigin = public.String()
		if len(cfg.AccessCode) < 32 || len(cfg.AccessCode) > 256 {
			return nil, fmt.Errorf("云端模式需要 OPENREADING_ACCESS_CODE（32 至 256 字节）")
		}
	}

	if cfg.ScanInterval == 0 {
		cfg.ScanInterval = 60 * time.Second
	}
	if cfg.DataDir == "" {
		p, e := os.UserConfigDir()
		if e != nil {
			return nil, e
		}
		cfg.DataDir = filepath.Join(p, "OpenReading")
	}
	abs, e := filepath.Abs(cfg.DataDir)
	if e != nil {
		return nil, e
	}
	cfg.DataDir = abs
	for _, p := range []string{"", "blobs", "derived", "backups", "imports", "staging"} {
		if e = os.MkdirAll(filepath.Join(abs, p), 0700); e != nil {
			return nil, e
		}
	}
	lockFile, e := acquireDataLock(filepath.Join(abs, ".openreading.lock"))
	if e != nil {
		return nil, e
	}
	initialized := false
	defer func() {
		if !initialized {
			lockFile.Close()
		}
	}()
	dbPath := filepath.ToSlash(filepath.Join(abs, "library.sqlite"))
	if filepath.VolumeName(dbPath) != "" {
		dbPath = "/" + dbPath
	}
	db, e := sql.Open("sqlite", (&url.URL{Scheme: "file", Path: dbPath}).String()+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)")
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(8)
	for _, migration := range []string{"001.sql", "002.sql", "003.sql", "004.sql", "005.sql", "006.sql"} {
		schema, err := assets.ReadFile("migrations/" + migration)
		if err == nil {
			_, err = db.Exec(string(schema))
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	_ = os.Chmod(filepath.Join(abs, "library.sqlite"), 0600)
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{db: db, cfg: cfg, mux: http.NewServeMux(), pairCode: id(), sessions: map[string]session{}, pickers: map[string]time.Time{}, credentials: map[string]credential{}, scans: map[string]*ScanJob{}, restores: map[string]*restorePlan{}, running: map[string]context.CancelFunc{}, ctx: ctx, cancel: cancel}
	if cfg.PublicOrigin != "" {
		s.pairCode = cfg.AccessCode
	}
	s.lockFile = lockFile
	// A prior process may already have incurred charges. Never automatically resend.
	e = s.transaction(func(tx *sql.Tx) error {
		if e := exec(tx, "UPDATE attempts SET state='interrupted',ended_at=? WHERE state='generating'", now()); e != nil {
			return e
		}
		return exec(tx, "UPDATE ai_runs SET state='interrupted',error_code='PROCESS_RESTARTED',error_message='程序已重启，请主动重新生成',ended_at=? WHERE state IN ('queued','preparing','generating')", now())
	})
	if e != nil {
		db.Close()
		cancel()
		return nil, e
	}
	s.routes()
	s.initLAN()
	s.watcher, _ = fsnotify.NewWatcher()
	s.watched = map[string]map[string]bool{}
	if s.watcher != nil {
		s.workers.Add(1)
		go s.watchEvents()
	}
	s.workers.Add(1)
	go s.background()
	initialized = true
	return s, nil
}
func (s *Server) Close() error {
	s.closeOnce.Do(func() {
		s.cancel()
		s.stopMobileDownload()
		s.lanControlMu.Lock()
		s.stopLAN()
		s.lanControlMu.Unlock()
		if s.watcher != nil {
			_ = s.watcher.Close()
		}
		s.mu.Lock()
		for _, cancel := range s.running {
			cancel()
		}
		for _, j := range s.scans {
			j.cancel()
		}
		s.mu.Unlock()
		s.workers.Wait()
		s.closeErr = s.db.Close()
		_ = s.lockFile.Close()
	})
	return s.closeErr
}
func (s *Server) PairCode() string      { return s.pairCode }
func (s *Server) Handler() http.Handler { return http.HandlerFunc(s.serve) }
func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	rid := id()
	w.Header().Set("X-Request-Id", rid)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; frame-src 'self' blob:; img-src 'self' data: blob:; font-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
	host, _, e := net.SplitHostPort(r.Host)
	if e != nil {
		host = r.Host
	}
	public, _ := url.Parse(s.cfg.PublicOrigin)
	isPublic := s.cfg.PublicOrigin != "" && r.Host == public.Host
	isLAN, _ := r.Context().Value(lanRequestKey{}).(bool)
	if !isLAN && !isPublic && host != "127.0.0.1" && host != "localhost" && host != "[::1]" && host != "::1" {
		s.fail(w, problem(403, "HOST_NOT_ALLOWED", "仅允许本机访问", false), rid)
		return
	}
	expectedOrigin := "http://" + r.Host
	if isPublic || isLAN {
		expectedOrigin = s.cfg.PublicOrigin
	}
	if isLAN {
		expectedOrigin = "https://" + r.Host
	}
	// Native clients have no ambient cookies; only scoped bearer sync APIs
	// accept their fixed WebView origins. Admin/session APIs keep same-origin CSRF.
	nativeSync := strings.HasPrefix(r.URL.Path, "/api/sync/") || r.URL.Path == "/api/pair/claim" || r.URL.Path == "/api/pair/status"
	origin := r.Header.Get("Origin")
	nativeOrigin := origin == "capacitor://localhost" || origin == "https://localhost" || origin == "http://localhost"
	if origin != "" && origin != expectedOrigin && !(nativeSync && nativeOrigin) {
		s.fail(w, problem(403, "ORIGIN_NOT_ALLOWED", "请求来源不允许", false), rid)
		return
	}
	if nativeSync && nativeOrigin {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Range")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Content-Length")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
	}
	if strings.HasPrefix(r.URL.Path, "/api/sync/") {
		device, err := s.authenticateDevice(r)
		if err != nil {
			s.fail(w, err, rid)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), deviceContextKey{}, device))
		s.mux.ServeHTTP(w, r)
		return
	}
	publicPair := r.URL.Path == "/api/pair/claim" || r.URL.Path == "/api/pair/status"
	if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/session" && r.URL.Path != "/api/health" && !publicPair {
		cookie, e := r.Cookie("openreading_session")
		s.mu.Lock()
		sess, ok := s.sessions[func() string {
			if cookie != nil {
				return cookie.Value
			}
			return ""
		}()]
		s.mu.Unlock()
		if e != nil || !ok || time.Now().After(sess.Expires) {
			s.fail(w, problem(401, "SESSION_REQUIRED", "请输入启动终端中的配对码", false), rid)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && r.Header.Get("X-CSRF-Token") != sess.CSRF {
			s.fail(w, problem(403, "CSRF_FAILED", "会话校验失败，请重新打开页面", false), rid)
			return
		}
	}
	// Remote browsers upload files; they must not browse or connect server directories.
	if s.cfg.PublicOrigin != "" && (strings.HasPrefix(r.URL.Path, "/api/local-picker/") || (r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/workspaces/") && strings.HasSuffix(r.URL.Path, "/sources"))) {
		s.fail(w, problem(403, "REMOTE_IMPORT_ONLY", "云端阅读空间请使用导入文件，不能连接服务器文件夹", false), rid)
		return
	}
	s.mux.ServeHTTP(w, r)
}
func (s *Server) route(pattern string, fn func(http.ResponseWriter, *http.Request) error) {
	s.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		if e := fn(w, r); e != nil {
			s.fail(w, e, w.Header().Get("X-Request-Id"))
		}
	})
}
func (s *Server) fail(w http.ResponseWriter, e error, rid string) {
	p := &apiError{500, "SAVE_FAILED", "保存失败，请重试；之前已保存的内容仍保留", true}
	var ae *apiError
	if errors.As(e, &ae) {
		p = ae
	} else {
		msg := strings.ToLower(e.Error())
		if strings.Contains(msg, "disk") || strings.Contains(msg, "full") || strings.Contains(msg, "space") {
			p = &apiError{507, "INSUFFICIENT_STORAGE", "磁盘空间不足，内容尚未保存，请保留草稿并释放空间", true}
		}
		log.Printf("request=%s error=%T", rid, e)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(p.Status)
	_ = json.NewEncoder(w).Encode(M{"code": p.Code, "message": p.Message, "retryable": p.Retryable, "requestId": rid})
}
func send(w http.ResponseWriter, v any) error {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	return json.NewEncoder(w).Encode(v)
}
func decode(r *http.Request, v any) error {
	d := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	if e := d.Decode(v); e != nil {
		return problem(400, "INVALID_REQUEST", "请求格式有误", false)
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return problem(400, "INVALID_REQUEST", "请求包含额外或超大内容", false)
	}
	return nil
}
func body(r *http.Request) (M, error) { m := M{}; e := decode(r, &m); return m, e }
func (s *Server) routes() {
	s.route("GET /api/health", func(w http.ResponseWriter, r *http.Request) error {
		return send(w, M{"status": "ok", "version": "1.6.6", "schemaVersion": 6, "serverMode": s.cfg.PublicOrigin != ""})
	})
	s.route("POST /api/session", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.pairCode == "" || subtle.ConstantTimeCompare([]byte(str(b, "code")), []byte(s.pairCode)) != 1 {
			return problem(401, "INVALID_PAIR_CODE", "配对码无效；请检查启动终端", false)
		}
		token, csrf := id(), id()
		s.sessions[token] = session{csrf, time.Now().Add(30 * 24 * time.Hour)}
		// Keep the startup code usable by additional browsers. Each pairing
		// creates an independent session; a server restart rotates the code.
		http.SetCookie(w, &http.Cookie{Name: "openreading_session", Value: token, Path: "/", HttpOnly: true, Secure: s.cfg.PublicOrigin != "", SameSite: http.SameSiteStrictMode, MaxAge: 30 * 24 * 3600})
		return send(w, M{"csrf": csrf})
	})
	s.route("GET /api/me", func(w http.ResponseWriter, r *http.Request) error {
		c, _ := r.Cookie("openreading_session")
		s.mu.Lock()
		sess := s.sessions[c.Value]
		s.mu.Unlock()
		return send(w, M{"csrf": sess.CSRF, "allowMock": s.cfg.AllowMock, "serverMode": s.cfg.PublicOrigin != ""})
	})
	s.syncRoutes()
	s.lanRoutes()
	s.mobileDownloadRoutes()
	s.workspaceRoutes()
	s.route("GET /api/documents/{m}/deletion-preview", s.bookDeletionPreview)
	s.route("PATCH /api/documents/{m}", s.libraryBook)
	s.route("DELETE /api/documents/{m}", s.libraryBook)
	s.sourceRoutes()
	s.versionRoutes()
	s.coverRoutes()
	s.route("GET /api/versions/{v}/word-count", s.wordCount)
	s.route("PUT /api/versions/{v}/word-count", s.wordCount)
	s.annotationRoutes()
	s.aiRoutes()
	s.dataRoutes()
	s.ordRoutes()
	s.readingRoutes()
	s.learningRoutes()
	s.searchRoutes()
	s.articleRoutes()
	s.backupPolicyRoutes()
	public, _ := fs.Sub(assets, "static")
	fileServer := http.FileServer(http.FS(public))
	s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			s.fail(w, problem(404, "NOT_FOUND", "接口不存在", false), w.Header().Get("X-Request-Id"))
			return
		}
		if _, e := fs.Stat(public, strings.TrimPrefix(r.URL.Path, "/")); e != nil {
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})
}
func (s *Server) background() {
	defer s.workers.Done()
	initial, _ := all(s.db, "SELECT id FROM sources WHERE state='active'")
	for _, source := range initial {
		_, _ = s.startScan(str(source, "id"))
	}
	scan := time.NewTicker(s.cfg.ScanInterval)
	queue := time.NewTicker(300 * time.Millisecond)
	backups := time.NewTicker(time.Minute)
	defer backups.Stop()
	defer scan.Stop()
	defer queue.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-backups.C:
			s.automaticBackup()
		case <-queue.C:
			s.dispatch()
		case <-scan.C:
			s.trimCache()
			sources, _ := all(s.db, "SELECT id FROM sources WHERE state='active'")
			for _, v := range sources {
				_, _ = s.startScan(str(v, "id"))
			}
		}
	}
}
