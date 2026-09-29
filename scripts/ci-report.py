"""Report actual JUnit skips separately from passes; fail missing Linux evidence."""
import json
import sys
from pathlib import Path
import xml.etree.ElementTree as ET


def build_report(root, platform):
    skipped = []
    failures = []
    passed = 0
    for case in root.iter("testcase"):
        filename = case.get("file")
        row = {"file": filename.replace("\\", "/") if filename else None,
               "suite": case.get("classname"), "name": case.get("name")}
        skip = case.find("skipped")
        if skip is not None:
            reason = skip.get("message") or skip.text
            if not reason and row["file"] in (
                "packages/mcp/test/sandbox-live.test.ts", "packages/app/test/containment.test.ts"
            ):
                reason = f"Requires working Linux bubblewrap; detected {platform['sandbox']} on {platform['os']}"
            skipped.append({**row, "reason": reason or "Runner supplied no reason; requires investigation"})
        elif case.find("failure") is not None or case.find("error") is not None:
            failures.append(row)
        else:
            passed += 1
    return {"platform": platform, "passed": passed, "failed": failures, "skipped": skipped,
            "live_model_acceptance": "not established by engineering CI"}


def main(argv):
    junit, metadata = map(Path, argv)
    output = junit.parent / "report.json"
    try:
        platform = json.loads(metadata.read_text())
        report = build_report(ET.parse(junit).getroot(), platform)
    except (OSError, ValueError, ET.ParseError) as error:
        report = {"evidence": "unavailable", "error": type(error).__name__}
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2))
        print("CI evidence unavailable: missing or invalid platform/JUnit report", file=sys.stderr)
        return 1
    output.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    # Linux CI must exercise the security suites, not silently green their skips.
    return int(bool(report["failed"]) or (platform["os"] == "linux" and (
        platform["sandbox"] != "bwrap" or any(item["file"] in (
            "packages/mcp/test/sandbox-live.test.ts", "packages/app/test/containment.test.ts"
        ) for item in report["skipped"]))))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
