package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func lanClient(t *testing.T, c *testClient, pin string) *http.Client {
	t.Helper()
	return &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12, VerifyConnection: func(cs tls.ConnectionState) error {
		sum := sha256.Sum256(cs.PeerCertificates[0].Raw)
		if hex.EncodeToString(sum[:]) != pin {
			return x509.UnknownAuthorityError{Cert: cs.PeerCertificates[0]}
		}
		return nil
	}}}}
}
func TestLANComputerServerPairingFilesNotesAndIsolation(t *testing.T) {
	c := newClient(t, Config{})
	w := c.workspace("电脑本机书库")
	root := t.TempDir()
	text := "这本书只保存在自己的电脑，不需要上传到任何云端服务器。"
	os.WriteFile(filepath.Join(root, "局域网原文.txt"), []byte(text), 0600)
	c.source(w, root)
	if _, _, e := c.s.pairingOrigin("https://192.168.1.2:53318"); e == nil {
		t.Fatal("LAN enabled implicitly")
	}
	if e := c.s.startLAN(0); e != nil {
		t.Fatal(e)
	}
	info := c.s.lanInfo()
	addresses := info["addresses"].([]M)
	if len(addresses) == 0 {
		t.Skip("runner has no private LAN interface")
	}
	origin := str(addresses[0], "origin")
	pin := str(info, "certificateFingerprint")
	grant := c.ok("POST", "/api/pair/grants", M{"workspaceIds": []string{str(w, "id")}, "origin": origin})
	if str(grant, "origin") != origin || str(grant, "certificateFingerprint") != pin {
		t.Fatal(grant)
	}
	if status, _ := c.req("POST", "/api/pair/grants", M{"workspaceIds": []string{str(w, "id")}, "origin": "https://example.com"}); status != 400 {
		t.Fatal("public QR endpoint accepted")
	}
	client := lanClient(t, c, pin)
	token := id() + id()
	request := func(method, path string, b any) (int, []byte) {
		t.Helper()
		var input io.Reader
		if b != nil {
			input = bytes.NewBufferString(js(b))
		}
		r, _ := http.NewRequest(method, origin+path, input)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Origin", "capacitor://localhost")
		r.Header.Set("Content-Type", "application/json")
		resp, e := client.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		data, e := io.ReadAll(resp.Body)
		if e != nil {
			t.Fatal(e)
		}
		return resp.StatusCode, data
	}
	code, data := request("POST", "/api/pair/claim", M{"id": grant["id"], "secret": grant["secret"], "token": token, "name": "局域网手机"})
	if code != 200 {
		t.Fatal(code, string(data))
	}
	if code, _ = request("GET", "/api/sync/library", nil); code != 401 {
		t.Fatal("unapproved phone connected")
	}
	c.ok("POST", "/api/pair/grants/"+str(grant, "id")+"/approve", M{})
	code, data = request("GET", "/api/sync/library", nil)
	if code != 200 {
		t.Fatal(code, string(data))
	}
	var library M
	json.Unmarshal(data, &library)
	doc := arr(arr(library, "workspaces")[0].(map[string]any), "documents")[0].(map[string]any)
	v := obj(doc, "version")
	if str(v, "contentHash") != "" && str(v, "contentHash") != digest([]byte(text)) {
		t.Fatal("local original changed")
	}
	if str(v, "id") == "" {
		t.Fatal("unopened local folder book not captured")
	}
	code, data = request("GET", "/api/sync/files/"+str(v, "id")+"?member="+str(doc, "id"), nil)
	if code != 200 || string(data) != text {
		t.Fatal(code, string(data))
	}
	anchor := M{"schemaVersion": 1, "workspaceDocumentId": doc["id"], "documentVersionId": v["id"], "parserVersion": "txt-map-v1", "normalizationVersion": "unicode-codepoint-preserve-v1", "targetKind": "text", "quote": M{"exact": text, "visible": text, "prefix": "", "suffix": ""}, "selectors": []M{{"type": "text", "block": "body", "start": 0, "end": len([]rune(text))}}, "displayLocation": M{"label": "正文"}}
	operation := M{"operationId": id(), "type": "create", "member": doc["id"], "anchor": anchor, "artifact": M{"blocks": []M{{"id": "body", "text": text, "locator": M{"label": "正文"}}}, "parserVersion": "txt-map-v1", "normalizationVersion": "unicode-codepoint-preserve-v1"}, "body": "手机直接回传到电脑的学习笔记"}
	code, data = request("POST", "/api/sync/commands", operation)
	if code != 200 {
		t.Fatal(code, string(data))
	}
	if len(c.list("/api/workspaces/"+str(w, "id")+"/notes")) != 1 {
		t.Fatal("phone note not visible to PC")
	}
	for _, path := range []string{"/", "/api/session", "/api/workspaces", "/api/providers", "/api/backups", "/api/local-picker/roots", "/api/pair/grants", "/api/lan"} {
		r, _ := http.NewRequest("GET", origin+path, nil)
		r.AddCookie(c.cookie)
		r.Header.Set("X-CSRF-Token", c.csrf)
		r.Header.Set("Authorization", "Bearer "+token)
		resp, e := client.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
		if resp.StatusCode != 403 {
			t.Fatal("LAN admin surface exposed", path, resp.StatusCode)
		}
	}
	// Forged loopback Host still cannot reach the admin surface on the LAN socket.
	r, _ := http.NewRequest("POST", origin+"/api/session", bytes.NewBufferString(js(M{"code": c.s.PairCode()})))
	r.Host = "127.0.0.1:" + strconv.Itoa(num(info, "port"))
	resp, e := client.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("forged host bypass")
	}
	wrong := lanClient(t, c, digest([]byte("wrong computer")))
	if r, e := wrong.Get(origin + "/api/sync/library"); e == nil {
		r.Body.Close()
		t.Fatal("wrong TLS pin accepted")
	}
	outsider := httptest.NewRequest("GET", origin+"/api/sync/library", nil)
	outsider.RemoteAddr = "8.8.8.8:1234"
	outsider.TLS = &tls.ConnectionState{}
	out := httptest.NewRecorder()
	c.s.serveLAN(out, outsider)
	if out.Code != 403 {
		t.Fatal("public peer allowed")
	}
	devices := c.list("/api/devices")
	c.ok("DELETE", "/api/devices/"+str(devices[0].(map[string]any), "id"), nil)
	if code, _ = request("GET", "/api/sync/library", nil); code != 401 {
		t.Fatal("revoked phone retained access")
	}
	port := num(info, "port")
	c.s.stopLAN()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	socket, e := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if e == nil {
		socket.Close()
		t.Fatal("LAN socket remains open")
	}
}
func TestLANPreferenceRestartAndCertificateIdentity(t *testing.T) {
	dir := t.TempDir()
	c := newClient(t, Config{DataDir: dir})
	if e := c.s.startLAN(0); e != nil {
		t.Fatal(e)
	}
	info := c.s.lanInfo()
	port := num(info, "port")
	pin := str(info, "certificateFingerprint")
	c.ok("POST", "/api/lan", M{"enabled": true, "port": port})
	c.s.Close()
	restored, e := New(Config{DataDir: dir})
	if e != nil {
		t.Fatal(e)
	}
	defer restored.Close()
	after := restored.lanInfo()
	if after["enabled"] != true || num(after, "port") != port || str(after, "certificateFingerprint") != pin {
		t.Fatal("LAN preference or identity lost", after)
	}
	stat, e := os.Stat(filepath.Join(dir, ".lan-identity.json"))
	if e != nil {
		t.Fatal(e)
	}
	if stat.Size() == 0 {
		t.Fatal("missing computer key")
	}
	other := newClient(t, Config{})
	if e = other.s.startLAN(port); e == nil {
		t.Fatal("port collision hidden")
	}
	if other.s.lanInfo()["enabled"] == true {
		t.Fatal("failed bind enabled LAN")
	}
	restored.stopLAN()
}
