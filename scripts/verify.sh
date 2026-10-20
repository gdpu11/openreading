#!/bin/sh
set -eu
OR_REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$OR_REPO_DIR"
npm test
npm run build
env -u GOROOT GOSUMDB=sum.golang.org go vet ./...
env -u GOROOT GOSUMDB=sum.golang.org go test ./... -count=1 -timeout=120s
env -u GOROOT GOSUMDB=sum.golang.org go test ./internal/server -race -run 'Test(A|M|Watch|Backup|Restart|Restore|Context|Preference|Single|Workspace)' -count=1 -timeout=90s
env -u GOROOT GOSUMDB=sum.golang.org CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o release/openreading ./cmd/openreading
npm run test:e2e -- tests/browser/system.spec.ts tests/browser/pairing.spec.ts
