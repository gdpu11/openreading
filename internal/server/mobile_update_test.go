package server

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPairedMobileUpdateMetadataAndDownload(t *testing.T) {
	c, ws, _ := syncSetup(t)
	token, device := approveDevice(t, c, ws)
	file := filepath.Join(t.TempDir(), "test.apk")
	writeAPK := func(metadata string) []byte {
		var buf bytes.Buffer
		z := zip.NewWriter(&buf)
		w, e := z.Create("assets/openreading-update.json")
		if e != nil {
			t.Fatal(e)
		}
		w.Write([]byte(metadata))
		z.Close()
		if e = os.WriteFile(file, buf.Bytes(), 0600); e != nil {
			t.Fatal(e)
		}
		return buf.Bytes()
	}
	apk := writeAPK(`{"versionCode":21,"versionName":"1.6.7"}`)
	c.s.cfg.AndroidAPK = file
	rec := deviceReq(c, token, "GET", "/api/sync/app-update", nil)
	var info M
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &info) != nil {
		t.Fatal(rec.Code, rec.Body.String())
	}
	sum := sha256.Sum256(apk)
	if info["available"] != true || num(info, "versionCode") != 21 || str(info, "sha256") != hex.EncodeToString(sum[:]) || num(info, "bytes") != len(apk) {
		t.Fatal(info)
	}
	rec = deviceReq(c, token, "GET", "/api/sync/app-update/apk", nil)
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), apk) {
		t.Fatal(rec.Code, rec.Body.String())
	}
	for _, path := range []string{"/api/sync/app-update", "/api/sync/app-update/apk"} {
		if got := deviceReq(c, "invalid", "GET", path, nil).Code; got != 401 {
			t.Fatal(got)
		}
	}
	writeAPK(`{"versionCode":0}`)
	rec = deviceReq(c, token, "GET", "/api/sync/app-update", nil)
	json.Unmarshal(rec.Body.Bytes(), &info)
	if info["available"] != false {
		t.Fatal(info)
	}
	c.ok("DELETE", "/api/devices/"+str(device, "id"), nil)
	if got := deviceReq(c, token, "GET", "/api/sync/app-update/apk", nil).Code; got != 401 {
		t.Fatal(got)
	}
}
