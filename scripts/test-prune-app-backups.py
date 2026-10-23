from pathlib import Path
import importlib.util
import os
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "prune_app_backups", Path(__file__).with_name("prune-app-backups.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AppBackupRetentionTest(unittest.TestCase):
    def test_keeps_current_backup_even_when_copy_preserves_old_mtime(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ["Open Reading-old.app", "Open Reading-current.app"]:
                (root / name / "Contents").mkdir(parents=True)
                (root / name / "Contents/Info.plist").write_text("fixture")
            keep = root / "Open Reading-current.app"
            os.utime(keep, (1, 1))
            (root / "library-before.sqlite").write_text("library backup")
            (root / "Other.app").mkdir()
            (root / "Open Reading-link.app").symlink_to(root / "Other.app")

            self.assertEqual(module.prune_app_backups(root, keep), ["Open Reading-old.app"])
            self.assertTrue((keep / "Contents/Info.plist").is_file())
            self.assertEqual((root / "library-before.sqlite").read_text(), "library backup")
            self.assertTrue((root / "Other.app").is_dir())
            self.assertTrue((root / "Open Reading-link.app").is_symlink())
            self.assertEqual(module.prune_app_backups(root, keep), [])

    def test_invalid_retained_backup_does_not_delete_existing_backups(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = root / "Open Reading-old.app"
            (old / "Contents").mkdir(parents=True)
            (old / "Contents/Info.plist").write_text("fixture")
            incomplete = root / "Open Reading-incomplete.app"
            incomplete.mkdir()
            link = root / "Open Reading-link.app"
            link.symlink_to(old)
            for invalid in [root / "Open Reading-missing.app", incomplete, link, root.parent / old.name]:
                with self.subTest(keep=invalid):
                    with self.assertRaises(ValueError):
                        module.prune_app_backups(root, invalid)
                    self.assertTrue(old.is_dir())


if __name__ == "__main__":
    unittest.main()
