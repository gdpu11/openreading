# Local macOS installation

- Keep at most one rollback `.app` in `release/installed-app-backups/`.
- After backing up the installed app, installing the new build, and verifying the installed hashes, run `python3 scripts/prune-app-backups.py --keep "<absolute path to this installation's app backup>"`.
- Do not prune before installation verification succeeds. Pass the backup just created explicitly; copying an app can preserve old timestamps.
- Every local install script, including temporary scripts, must call this helper. Do not accumulate version-specific app copies without pruning.
- This retention rule applies only to app bundles, not library database backups.
