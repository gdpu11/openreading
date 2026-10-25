package server

import (
	"os"
	"path/filepath"
	"strings"
)

var bookExtensions = map[string]string{
	".md": "markdown", ".markdown": "markdown", ".txt": "txt", ".pdf": "pdf", ".epub": "epub", ".kepub": "epub",
	".mobi": "mobi", ".azw": "mobi", ".prc": "mobi", ".azw3": "azw3", ".kf8": "azw3",
	".fb2": "fb2", ".fbz": "fb2", ".docx": "docx", ".html": "html", ".htm": "html", ".xhtml": "html",
	".rtf": "rtf", ".cbz": "cbz", ".cbr": "cbr",
}

func format(path string) string {
	if strings.HasSuffix(strings.ToLower(path), ".fb2.zip") {
		return "fb2"
	}
	return bookExtensions[strings.ToLower(filepath.Ext(path))]
}

func supportedFormat(kind string) bool {
	for _, value := range bookExtensions {
		if value == kind {
			return true
		}
	}
	return false
}

// Imported bytes and version hashes retain the source format. Reflowable books
// and comic pages share the EPUB renderer and its native CFI anchor contract.
func readingFormat(kind string) string {
	switch kind {
	case "mobi", "azw3", "fb2", "docx", "html", "rtf", "cbz", "cbr":
		return "epub"
	default:
		return kind
	}
}

func bookContentType(kind string) string {
	switch kind {
	case "pdf":
		return "application/pdf"
	case "epub":
		return "application/epub+zip"
	case "docx":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case "html":
		return "text/plain; charset=utf-8" // Never serve imported HTML as executable same-origin content.
	case "rtf":
		return "application/rtf"
	case "mobi", "azw3":
		return "application/x-mobipocket-ebook"
	case "fb2", "cbz", "cbr":
		return "application/octet-stream"
	default:
		return "text/plain; charset=utf-8"
	}
}

func checkBookArchive(path, kind string) error {
	switch kind {
	case "epub", "docx", "cbz":
		return checkArchiveKind(path, kind)
	case "fb2":
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		var magic [4]byte
		_, _ = f.Read(magic[:])
		if string(magic[:]) == "PK\x03\x04" {
			return checkArchiveKind(path, kind)
		}
	}
	return nil
}
