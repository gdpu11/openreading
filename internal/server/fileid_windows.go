package server

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
)

func acquireDataLock(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	var overlap windows.Overlapped
	if err = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlap); err != nil {
		f.Close()
		return nil, problem(409, "DATA_DIRECTORY_IN_USE", "此数据目录已由另一个 Open Reading 程序使用，请先关闭它", false)
	}
	return f, nil
}

// Windows does not expose a portable directory fsync. Blob files are synced
// before publication; SQLite uses WAL + synchronous FULL.
func syncDirectory(path string) error { return nil }
func fileIdentity(path string, _ os.FileInfo) string {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}
	handle, err := windows.CreateFile(p, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &info) != nil {
		return ""
	}
	return fmt.Sprintf("win:%x:%x:%x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow)
}
func availableSpace(path string) uint64 {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0
	}
	var available, total, free uint64
	if windows.GetDiskFreeSpaceEx(p, &available, &total, &free) != nil {
		return 0
	}
	return available
}
