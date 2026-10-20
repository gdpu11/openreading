package server

import (
	"github.com/fsnotify/fsnotify"
	"os"
	"path/filepath"
	"sort"
	"time"
)

func (s *Server) watchDirectory(sourceID, path string) {
	if s.watcher == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.watched[path] == nil {
		if e := s.watcher.Add(path); e != nil {
			return
		}
		s.watched[path] = map[string]bool{}
	}
	s.watched[path][sourceID] = true
}

// Events are hints. A debounced metadata reconciliation handles rename pairs and
// never removes a logical document or its learning records.
func (s *Server) watchEvents() {
	defer s.workers.Done()
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	dirty := map[string]bool{}
	for {
		select {
		case <-s.ctx.Done():
			return
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			if event.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Remove|fsnotify.Rename) != 0 {
				s.mu.Lock()
				for source := range s.watched[filepath.Dir(event.Name)] {
					dirty[source] = true
				}
				s.mu.Unlock()
			}
		case _, ok := <-s.watcher.Errors:
			if !ok {
				return
			}
			s.mu.Lock()
			for _, sources := range s.watched {
				for source := range sources {
					dirty[source] = true
				}
			}
			s.mu.Unlock()
		case <-tick.C:
			for source := range dirty {
				if _, e := s.startScan(source); e == nil {
					delete(dirty, source)
				} else {
					delete(dirty, source)
				}
			}
		}
	}
}
func (s *Server) trimCache() {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	v, e := s.cacheCandidates()
	if e != nil {
		return
	}
	bytes, _ := v["bytes"].(int64)
	const quota int64 = 2 << 30
	if bytes <= quota {
		return
	}
	files := v["hashes"].([]string)
	sort.Slice(files, func(i, j int) bool {
		a, _ := os.Stat(filepath.Join(s.cfg.DataDir, "blobs", files[i]))
		b, _ := os.Stat(filepath.Join(s.cfg.DataDir, "blobs", files[j]))
		if a == nil || b == nil {
			return false
		}
		return a.ModTime().Before(b.ModTime())
	})
	for _, hash := range files {
		if bytes <= quota {
			return
		}
		path := filepath.Join(s.cfg.DataDir, "blobs", hash)
		info, e := os.Stat(path)
		if e == nil && os.Remove(path) == nil {
			bytes -= info.Size()
		}
	}
}
