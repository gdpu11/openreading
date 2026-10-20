# Security

Open Reading is preview software intended for a single user's library. The desktop administrative service listens on loopback; optional LAN synchronization has a separate, scoped interface.

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/gdpu11/openreading/security/advisories/new). Do not put credentials, book contents, pairing codes, session cookies or private library backups in a public issue.

Include a minimal reproduction using an artificial document, the version, platform, affected feature and expected behavior. Describe any data-loss or authorization impact. Avoid publishing exploit details before a fix is available.

## Security boundaries

- Local administrative access uses a session, same-origin checks and CSRF tokens. LAN clients receive device tokens scoped to selected workspaces.
- Documents are untrusted input. EPUB scripts and remote resources are blocked; desktop renderers have no Node integration. Conversion printing uses a separate sandboxed window and denies network and arbitrary file access.
- Backups and `.ord` learning packages can contain books and private notes. Share only material you have permission to disclose. API keys are not included.
- A separately confirmed original-file deletion can remove a connected source file. Keep independent backups.
- Optional model providers receive the context you choose to send. Their privacy terms and costs apply separately.

Only the latest preview release is maintained. The project has not received an independent security audit; passing tests and scanners are not a guarantee that no vulnerabilities exist.
