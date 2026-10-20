# Contributing

Small, focused fixes and reproducible bug reports are welcome.

1. Reproduce problems using a generated fixture or a document you can legally share. Do not upload private books, deployment files, API keys or a real library database.
2. Read `docs/architecture.md`, keep changes scoped and add meaningful regression coverage for behavior changes, especially data loss, file access and synchronization.
3. Run `npm test`, `npm run build`, `go vet ./...` and `go test ./...`. Run the relevant browser/native tests when changing reader behavior or IPC.
4. Describe the problem, resulting behavior, validation and remaining limitations in your pull request.

Use the MIT license for contributions. Dependencies and redistributed notices keep their original licenses. Do not add private runtime data or generated test evidence to Git.
