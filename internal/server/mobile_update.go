package server

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
)

// The version descriptor travels inside the APK, so desktop packaging cannot
// accidentally pair an old installer with a newer sidecar descriptor.
func (s *Server) mobileUpdateRoutes() {
	s.route("GET /api/sync/app-update", func(w http.ResponseWriter, r *http.Request) error {
		f, e := os.Open(s.cfg.AndroidAPK)
		if e != nil {
			return send(w, M{"available": false})
		}
		defer f.Close()
		st, e := f.Stat()
		if e != nil || !st.Mode().IsRegular() || st.Size() > 210*1024*1024 {
			return send(w, M{"available": false})
		}
		archive, e := zip.NewReader(f, st.Size())
		if e != nil {
			return send(w, M{"available": false})
		}
		var version struct {
			VersionCode int64  `json:"versionCode"`
			VersionName string `json:"versionName"`
		}
		for _, entry := range archive.File {
			if entry.Name == "assets/openreading-update.json" {
				data, e := entry.Open()
				if e != nil {
					return e
				}
				e = json.NewDecoder(io.LimitReader(data, 4096)).Decode(&version)
				data.Close()
				if e != nil {
					return send(w, M{"available": false})
				}
				break
			}
		}
		if version.VersionCode < 1 || version.VersionName == "" {
			return send(w, M{"available": false})
		}
		hash := sha256.New()
		if _, e = io.Copy(hash, f); e != nil {
			return e
		}
		return send(w, M{"available": true, "versionCode": version.VersionCode, "versionName": version.VersionName, "bytes": st.Size(), "sha256": hex.EncodeToString(hash.Sum(nil))})
	})
	s.route("GET /api/sync/app-update/apk", func(w http.ResponseWriter, r *http.Request) error {
		f, e := os.Open(s.cfg.AndroidAPK)
		if e != nil {
			return problem(404, "INSTALLER_UNAVAILABLE", "电脑尚未提供手机升级包，请先更新电脑端", false)
		}
		defer f.Close()
		st, e := f.Stat()
		if e != nil {
			return e
		}
		if !st.Mode().IsRegular() || st.Size() > 210*1024*1024 {
			return problem(409, "INSTALLER_UNAVAILABLE", "电脑安装包不可用", false)
		}
		w.Header().Set("Content-Type", "application/vnd.android.package-archive")
		w.Header().Set("Content-Disposition", `attachment; filename="Open-Reading.apk"`)
		w.Header().Set("Cache-Control", "no-store")
		http.ServeContent(w, r, "Open-Reading.apk", st.ModTime(), f)
		return nil
	})
}
