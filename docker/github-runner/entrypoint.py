"""One registration and one trusted job; no token in command arguments or logs."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def main():
    revision = os.environ.get("AUGUST_APPROVED_REVISION", "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Exact approved commit is required")
    token = sys.stdin.readline(4096).strip()
    if not token or len(token) > 2048 or not re.fullmatch(r"[A-Za-z0-9_-]+", token):
        raise ValueError("A private registration token is required on stdin")
    shutil.copytree("/opt/actions-runner", "/runner", dirs_exist_ok=True)
    Path("/runner/approved-revision").write_text(revision)
    environment = {**os.environ, "RUNNER_INPUT_TOKEN": token}
    registered = subprocess.run([
        "./config.sh", "--unattended", "--url", "https://github.com/Paffin/AugustAgents",
        "--name", os.environ["AUGUST_RUNNER_NAME"], "--labels", "august-local-docker",
        "--no-default-labels", "--ephemeral", "--disableupdate", "--work", "_work",
    ], env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    environment.pop("RUNNER_INPUT_TOKEN", None)
    token = ""
    if registered.returncode:
        # Do not echo registration diagnostics, which may contain credentials.
        print("Runner registration failed; check token expiry and repository permission", file=sys.stderr)
        return registered.returncode
    print("Ephemeral repository runner registered for the approved revision", flush=True)
    os.execve("./run.sh", ["./run.sh"], environment)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError) as error:
        print(f"Runner setup failed ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
