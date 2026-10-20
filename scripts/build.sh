#!/bin/sh
set -eu
OR_REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$OR_REPO_DIR"
npm ci
npm run build
mkdir -p release
env -u GOROOT GOSUMDB=sum.golang.org CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o release/openreading ./cmd/openreading
