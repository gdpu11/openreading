# Public preview review — 1.6.6

Review date: 2026-10-20. This is a source and regression review, not an independent security audit or a guarantee that every book and device will work.

## Findings addressed

- **Original-file deletion:** stage the file on the same filesystem, commit the source/library metadata together, and restore the file if the database rejects the deletion. A fault-injection test verifies the original contents and metadata survive a database failure. Cleanup/recovery errors identify the retained temporary file. A process or machine crash during staging can still require manual recovery; keep independent backups.
- **Backup file references:** reject forged, correctly rehashed manifests whose version references are not exactly their lowercase SHA-256 content hashes. Validate references again before snapshot and cover reads, including corrupted stored metadata.
- **Build dependencies:** update the affected transitive dependency paths. The final npm audit reported zero known advisories across runtime and development dependencies.
- **Reader behavior:** fix context menus closing during pending automatic scrolling; preserve the PDF reading page during window reflow; restore text positions after delayed images/fonts and recalculate their percentages; wait for pending EPUB navigation before destroying a book during rapid switching.
- **Distribution boundaries:** remove workstation-specific cloud defaults and private repository links. A hosted mode requires an explicitly configured HTTPS origin; local reading remains the default.

## Verification performed

| Check | Result |
| --- | --- |
| Frontend unit tests | 33 passed across 11 files |
| Type checking and production frontend build | Passed, including from a clean source export with `npm ci` |
| Go vet | Passed |
| Complete Go tests | Passed, including the clean source export |
| Go server race detector | Passed |
| Chromium system and pairing tests from the clean source export | 42 passed; 5 explicitly skipped |
| Native conversion/deletion/filter/estimate and multi-window persistence tests | 2 passed on macOS during review |
| npm audit | 0 known vulnerabilities, including development dependencies |
| govulncheck v1.9.0 | No reachable vulnerability findings |
| Gitleaks v8.30.1 | No findings in the reviewed history or exported source |

The skipped browser cases require an explicitly supplied APK, authorized real books/papers, or separately configured cloud access. Their absence is not a pass. The default suite uses generated, artificial fixtures and isolated temporary libraries. Native build results for the public commit are available in [GitHub Actions](https://github.com/gdpu11/openreading/actions); a successful build does not establish physical-device coverage.

The frontend build currently warns about large bundles and PDF modules shared by static and dynamic imports. These are performance/build-organization limitations, not failed checks. External model quality and costs were not evaluated with a paid production key.

## Public source hygiene

The public repository begins with a clean source snapshot. Personal libraries, databases, credentials, signing material, private deployment records, old Git history, and workstation test evidence are excluded. Screenshots use original demonstration books. Dependency copyright and license notices are retained.

The source export includes a SHA-256 manifest. Generated frontend bundles are rebuilt locally or in CI; they are not copied from an installed application. Use [SECURITY.md](../SECURITY.md) to report sensitive findings privately, and review the [known limitations](known-limitations.md) before using the preview with important material.
