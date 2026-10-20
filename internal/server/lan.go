package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type lanRequestKey struct{}
type lanConfig struct {
	Enabled bool `json:"enabled"`
	Port    int  `json:"port"`
}

func lanIPv4(ip net.IP) bool { return ip.To4() != nil && (ip.IsPrivate() || ip.IsLinkLocalUnicast()) }
func lanAddresses(port int) []M {
	out := []M{}
	interfaces, _ := net.Interfaces()
	for _, device := range interfaces {
		if device.Flags&net.FlagUp == 0 || device.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 {
			continue
		}
		addresses, _ := device.Addrs()
		for _, raw := range addresses {
			ip, _, e := net.ParseCIDR(raw.String())
			if e == nil && lanIPv4(ip) {
				out = append(out, M{"interface": device.Name, "origin": "https://" + net.JoinHostPort(ip.String(), strconv.Itoa(port))})
			}
		}
	}
	return out
}
func (s *Server) lanIdentity() (tls.Certificate, string, error) {
	path := filepath.Join(s.cfg.DataDir, ".lan-identity.json")
	data, e := os.ReadFile(path)
	if os.IsNotExist(e) {
		key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if e != nil {
			return tls.Certificate{}, "", e
		}
		serial, e := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
		if e != nil {
			return tls.Certificate{}, "", e
		}
		template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Open Reading local computer"}, NotBefore: time.Now().Add(-24 * time.Hour), NotAfter: time.Now().AddDate(10, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
		for _, a := range lanAddresses(0) {
			host, _, _ := net.SplitHostPort(strings.TrimPrefix(str(a, "origin"), "https://"))
			template.IPAddresses = append(template.IPAddresses, net.ParseIP(host))
		}
		der, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
		if e != nil {
			return tls.Certificate{}, "", e
		}
		private, e := x509.MarshalPKCS8PrivateKey(key)
		if e != nil {
			return tls.Certificate{}, "", e
		}
		data = []byte(js(M{"certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), "key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}))}))
		temp, e := os.CreateTemp(s.cfg.DataDir, ".lan-identity-")
		if e != nil {
			return tls.Certificate{}, "", e
		}
		defer os.Remove(temp.Name())
		if _, e = temp.Write(data); e == nil {
			e = temp.Sync()
		}
		closeErr := temp.Close()
		if e == nil {
			e = closeErr
		}
		if e == nil {
			e = os.Rename(temp.Name(), path)
		}
		if e != nil {
			return tls.Certificate{}, "", e
		}
		if e = syncDirectory(s.cfg.DataDir); e != nil {
			return tls.Certificate{}, "", e
		}
	} else if e != nil {
		return tls.Certificate{}, "", e
	}
	var identity struct {
		Certificate string `json:"certificate"`
		Key         string `json:"key"`
	}
	if json.Unmarshal(data, &identity) != nil {
		return tls.Certificate{}, "", fmt.Errorf("invalid LAN identity")
	}
	cert, e := tls.X509KeyPair([]byte(identity.Certificate), []byte(identity.Key))
	if e != nil {
		return cert, "", e
	}
	sum := sha256.Sum256(cert.Certificate[0])
	return cert, hex.EncodeToString(sum[:]), nil
}
func (s *Server) lanInfo() M {
	s.lanMu.Lock()
	defer s.lanMu.Unlock()
	name, _ := os.Hostname()
	return M{"enabled": s.lanServer != nil, "port": s.lanPort, "addresses": lanAddresses(s.lanPort), "certificateFingerprint": s.lanFingerprint, "computerName": name, "error": s.lanError}
}
func (s *Server) stopLAN() {
	s.lanMu.Lock()
	server := s.lanServer
	s.lanServer = nil
	s.lanMu.Unlock()
	if server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if server.Shutdown(ctx) != nil {
			server.Close()
		}
	}
}
func (s *Server) startLAN(port int) error {
	if s.cfg.PublicOrigin != "" {
		return problem(409, "LOCAL_LIBRARY_REQUIRED", "请在本机书库开启局域网同步", false)
	}
	if s.ctx.Err() != nil {
		return problem(503, "SERVER_STOPPING", "电脑服务正在关闭", true)
	}
	s.lanMu.Lock()
	already := s.lanServer != nil
	same := s.lanPort == port
	s.lanMu.Unlock()
	if already && same {
		return nil
	}
	if already {
		return problem(409, "LAN_ACTIVE", "请先关闭局域网同步，再更换端口", false)
	}
	if port < 0 || port > 65535 {
		return problem(400, "LAN_PORT", "局域网端口无效", false)
	}
	certificate, fingerprint, e := s.lanIdentity()
	if e != nil {
		return problem(500, "LAN_IDENTITY", "本机连接证书无法读取，书库仍可正常使用", false)
	}
	listener, e := net.Listen("tcp4", net.JoinHostPort("0.0.0.0", strconv.Itoa(port)))
	if e != nil {
		return problem(409, "LAN_PORT_BUSY", "局域网端口无法监听，请检查是否被其他程序占用", true)
	}
	server := &http.Server{Handler: http.HandlerFunc(s.serveLAN), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}}
	s.lanMu.Lock()
	s.lanServer = server
	s.lanPort = listener.Addr().(*net.TCPAddr).Port
	s.lanFingerprint = fingerprint
	s.lanError = ""
	s.lanMu.Unlock()
	go func() { _ = server.Serve(tls.NewListener(listener, server.TLSConfig)) }()
	return nil
}
func (s *Server) initLAN() {
	row, e := one(s.db, "SELECT data_json FROM preferences WHERE id='lan-sync'")
	if e != nil {
		return
	}
	data := obj(row, "data")
	if data["enabled"] != true || s.cfg.PublicOrigin != "" {
		return
	}
	port := num(data, "port")
	if port < 1 {
		port = 53318
	}
	if e = s.startLAN(port); e != nil {
		s.lanMu.Lock()
		s.lanError = e.Error()
		s.lanMu.Unlock()
	}
}
func (s *Server) serveLAN(w http.ResponseWriter, r *http.Request) {
	// The LAN socket never exposes the browser admin/session/filesystem surface,
	// even with a forged loopback Host or a copied admin cookie.
	host, port, e := net.SplitHostPort(r.Host)
	ip := net.ParseIP(host)
	s.lanMu.Lock()
	enabled := s.lanServer != nil
	expectedPort := s.lanPort
	s.lanMu.Unlock()
	peer, _, _ := net.SplitHostPort(r.RemoteAddr)
	peerIP := net.ParseIP(peer)
	allowed := false
	for _, a := range lanAddresses(expectedPort) {
		if str(a, "origin") == "https://"+r.Host {
			allowed = true
			break
		}
	}
	if ip != nil && ip.IsLoopback() {
		allowed = true
	}
	if e != nil || !enabled || port != strconv.Itoa(expectedPort) || !allowed || r.TLS == nil || peerIP == nil || (!lanIPv4(peerIP) && !peerIP.IsLoopback()) {
		s.fail(w, problem(403, "LAN_ONLY", "仅允许本机及局域网连接", false), id())
		return
	}
	path := r.URL.Path
	if !(strings.HasPrefix(path, "/api/sync/") || path == "/api/pair/claim" || path == "/api/pair/status") {
		s.fail(w, problem(403, "LAN_SCOPE", "此局域网端口仅用于手机配对和已授权同步", false), id())
		return
	}
	s.serve(w, r.WithContext(context.WithValue(r.Context(), lanRequestKey{}, true)))
}
func (s *Server) pairingOrigin(requested string) (string, string, error) {
	if s.cfg.PublicOrigin != "" {
		return s.cfg.PublicOrigin, "", nil
	}
	info := s.lanInfo()
	if info["enabled"] != true {
		return "", "", problem(409, "LAN_DISABLED", "请先开启局域网同步", false)
	}
	for _, a := range info["addresses"].([]M) {
		if str(a, "origin") == requested {
			return requested, str(info, "certificateFingerprint"), nil
		}
	}
	return "", "", problem(400, "LAN_ADDRESS", "请选择电脑当前网络中的局域网地址", false)
}
func (s *Server) lanRoutes() {
	s.route("GET /api/lan", func(w http.ResponseWriter, r *http.Request) error { return send(w, s.lanInfo()) })
	s.route("POST /api/lan", func(w http.ResponseWriter, r *http.Request) error {
		var b lanConfig
		if e := decode(r, &b); e != nil {
			return e
		}
		if b.Port == 0 {
			b.Port = 53318
		}
		s.lanControlMu.Lock()
		defer s.lanControlMu.Unlock()
		if b.Enabled {
			if e := s.startLAN(b.Port); e != nil {
				return e
			}
		} else {
			s.stopLAN()
		}
		e := s.transaction(func(tx *sql.Tx) error {
			return exec(tx, "INSERT INTO preferences(id,data_json) VALUES('lan-sync',?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json", js(b))
		})
		if e != nil {
			if b.Enabled {
				s.stopLAN()
			}
			return e
		}
		return send(w, s.lanInfo())
	})
}
