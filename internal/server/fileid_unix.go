//go:build !windows

package server

import (
	"fmt"
	"os"
	"syscall"
)

func syncDirectory(path string) error {
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}
func acquireDataLock(path string) (*os.File, error) {
	f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, problem(409, "DATA_DIRECTORY_IN_USE", "此数据目录已由另一个 OpenReading 程序使用，请先关闭它", false)
	}
	return f, nil
}

func availableSpace(path string) uint64 {
	var stat syscall.Statfs_t
	if syscall.Statfs(path, &stat) != nil {
		return 0
	}
	return uint64(stat.Bavail) * uint64(stat.Bsize)
}

func fileIdentity(_ string, info os.FileInfo) string {
	if v, ok := info.Sys().(*syscall.Stat_t); ok {
		return fmt.Sprintf("%d:%d", v.Dev, v.Ino)
	}
	return ""
}
