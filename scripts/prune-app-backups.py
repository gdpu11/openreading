#!/usr/bin/env python3
"""Keep only the current rollback app after a verified local installation."""
from pathlib import Path
import argparse
import shutil


def prune_app_backups(backup_dir, keep):
    backup_dir, keep = Path(backup_dir), Path(keep)
    if backup_dir.is_symlink() or keep.is_symlink():
        raise ValueError("Backup directory and retained app must not be symlinks")
    backup_dir, keep = backup_dir.resolve(), keep.resolve()
    if (
        keep.parent != backup_dir
        or not keep.match("Open Reading*.app")
        or not (keep / "Contents/Info.plist").is_file()
    ):
        raise ValueError("Retained app must exist directly inside installed-app-backups")

    removed = []
    for candidate in sorted(backup_dir.glob("Open Reading*.app")):
        if candidate != keep and candidate.is_dir() and not candidate.is_symlink():
            shutil.rmtree(candidate)
            removed.append(candidate.name)
    return removed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", required=True, type=Path, help="This installation's rollback .app")
    args = parser.parse_args()
    backup_dir = Path(__file__).resolve().parent.parent / "release/installed-app-backups"
    removed = prune_app_backups(backup_dir, args.keep)
    print(f"Kept {args.keep.name}; removed {len(removed)} older app backup(s)")
