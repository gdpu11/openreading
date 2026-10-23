package server

import (
	"encoding/json"
	"io/fs"
	"testing"
)

// Scoped npm notice directories start with underscores. A normal recursive
// go:embed directory match silently omits them; validate the actual embedded FS.
func TestEmbeddedLicenseBundle(t *testing.T) {
	if _, err := fs.Stat(assets, "static/index.html"); err != nil {
		t.Skip("frontend not built; run npm run build before release verification")
	}
	for _, name := range []string{"index.html", "LICENSE", "PRIVACY.md", "THIRD_PARTY_NOTICES.md", "third-party/SOURCE-OFFER.md"} {
		if _, err := fs.ReadFile(assets, "static/licenses/"+name); err != nil {
			t.Fatalf("missing embedded license document %s: %v", name, err)
		}
	}
	raw, err := fs.ReadFile(assets, "static/licenses/third-party/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var packages []struct {
		Name    string   `json:"name"`
		Notices []string `json:"notices"`
	}
	if err := json.Unmarshal(raw, &packages); err != nil {
		t.Fatal(err)
	}
	if len(packages) == 0 {
		t.Fatal("embedded dependency notice inventory is empty")
	}
	for _, p := range packages {
		for _, notice := range p.Notices {
			if _, err := fs.ReadFile(assets, "static/licenses/"+notice); err != nil {
				t.Errorf("missing embedded notice for %s: %s: %v", p.Name, notice, err)
			}
		}
	}
}
