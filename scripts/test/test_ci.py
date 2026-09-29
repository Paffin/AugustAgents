"""Release contract regressions: skip evidence and rejected corrupt lockfiles."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("ci_report", ROOT / "scripts/ci-report.py")
report_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report_module)


class ReportTests(unittest.TestCase):
    def test_skips_are_not_passes_and_have_observed_reason(self):
        root = ET.fromstring('<testsuites><testsuite><testcase name="ok"/>'
                             '<testcase name="isolated" file="packages/mcp/test/sandbox-live.test.ts">'
                             '<skipped/></testcase><testcase name="broken"><failure/></testcase>'
                             '</testsuite></testsuites>')
        report = report_module.build_report(root, {"os": "darwin", "sandbox": "sandbox-exec"})
        self.assertEqual(report["passed"], 1)
        self.assertEqual(len(report["failed"]), 1)
        self.assertEqual(len(report["skipped"]), 1)
        self.assertIn("sandbox-exec on darwin", report["skipped"][0]["reason"])

    def test_missing_report_fails_with_unavailable_not_green(self):
        with tempfile.TemporaryDirectory(prefix="august-ci-") as directory:
            output = Path(directory)
            self.assertEqual(report_module.main([str(output / "tests.xml"), str(output / "platform.json")]), 1)
            self.assertEqual(json.loads((output / "report.json").read_text())["evidence"], "unavailable")

    def test_linux_sandbox_skip_fails_evidence_gate(self):
        with tempfile.TemporaryDirectory(prefix="august-ci-") as directory:
            output = Path(directory)
            (output / "tests.xml").write_text('<testsuites><testcase name="isolation" '
                'file="packages/mcp/test/sandbox-live.test.ts"><skipped/></testcase></testsuites>')
            (output / "platform.json").write_text(json.dumps({"os": "linux", "sandbox": "none"}))
            self.assertEqual(report_module.main([str(output / "tests.xml"), str(output / "platform.json")]), 1)

    def test_frozen_restore_rejects_corrupt_lock_without_repair(self):
        # An actual Bun invocation in process-owned state; never corrupt the working lockfile.
        with tempfile.TemporaryDirectory(prefix="august-lock-") as directory:
            output = Path(directory)
            shutil.copyfile(ROOT / "package.json", output / "package.json")
            for manifest in (ROOT / "packages").glob("*/package.json"):
                target = output / "packages" / manifest.parent.name
                target.mkdir(parents=True)
                shutil.copyfile(manifest, target / "package.json")
            corrupt = b"!" + (ROOT / "bun.lock").read_bytes()[1:]
            (output / "bun.lock").write_bytes(corrupt)
            result = subprocess.run(["bun", "install", "--frozen-lockfile"],
                                    cwd=output, capture_output=True, timeout=30, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((output / "bun.lock").read_bytes(), corrupt)


if __name__ == "__main__":
    unittest.main()
