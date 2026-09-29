"""Safety contract: no host mounts/privilege, no credential arguments, private token file."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("runner_launch", ROOT / "docker/github-runner/launch.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class RunnerTests(unittest.TestCase):
    def test_launch_is_owned_bounded_and_has_no_host_mounts_or_token_arguments(self):
        args = launcher.command("desktop-linux", "test-image", "a" * 40, "august-runner-fixture")
        for argument in ("--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--user=1000:1000"):
            self.assertIn(argument, args)
        for forbidden in ("--privileged", "--volume", "--mount", "--token"):
            self.assertNotIn(forbidden, args)
        self.assertFalse(any("RUNNER_INPUT_TOKEN" in arg or "docker.sock" in arg for arg in args))

    def test_bad_identity_or_revision_is_refused(self):
        for revision, name in (("main", "august-runner-fixture"), ("a" * 40, "foreign-container")):
            with self.assertRaises(ValueError):
                launcher.command("desktop-linux", "test-image", revision, name)

    def test_token_file_symlink_or_shared_permissions_are_refused(self):
        with tempfile.TemporaryDirectory(prefix="august-runner-test-") as directory:
            path = Path(directory) / "synthetic-token"
            path.write_text("SYNTHETIC_TEST_TOKEN")
            path.chmod(0o600)
            self.assertEqual(launcher.read_token(path), "SYNTHETIC_TEST_TOKEN")
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                launcher.read_token(path)
            path.chmod(0o600)
            link = Path(directory) / "link"
            os.symlink(path, link)
            with self.assertRaises(OSError):
                launcher.read_token(link)


if __name__ == "__main__":
    unittest.main()
