"""Launch an owned ephemeral container; token is piped, never argv/docker env."""
import argparse
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


def command(context, image, revision, name):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Exact 40-character commit is required")
    if not re.fullmatch(r"august-runner-[a-z0-9-]+", name):
        raise ValueError("Owned runner name must start august-runner-")
    return ["docker", "--context", context, "run", "--rm", "--interactive",
            "--name", name, "--label", "io.august.owner=github-runner",
            "--label", "io.august.repository=Paffin/AugustAgents",
            "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
            "--pids-limit=512", "--memory=4g", "--cpus=2", "--user=1000:1000",
            "--tmpfs", "/runner:rw,exec,nosuid,size=6g,uid=1000,gid=1000,mode=0700",
            "--tmpfs", "/tmp:rw,exec,nosuid,size=2g,uid=1000,gid=1000,mode=0700",
            "--tmpfs", "/home/node:rw,nosuid,size=1g,uid=1000,gid=1000,mode=0700",
            "--env", f"AUGUST_APPROVED_REVISION={revision}",
            "--env", f"AUGUST_RUNNER_NAME={name}", image]


def read_token(path):
    # No symlinks, owner-only regular file; do not traverse arbitrary credential stores.
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "r") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Token file must be owner-only, regular, and owned by this user")
        token = stream.read(4096).strip()
    if not token or not re.fullmatch(r"[A-Za-z0-9_-]{1,2048}", token):
        raise ValueError("Invalid registration token file")
    return token


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token-file", required=True, type=Path)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--context", default="desktop-linux")
    parser.add_argument("--image", default="august-github-runner:2.337.0-arm64")
    args = parser.parse_args()
    invocation = command(args.context, args.image, args.revision, args.name)
    token = read_token(args.token_file)
    process = subprocess.Popen(invocation, stdin=subprocess.PIPE)
    process.stdin.write((token + "\n").encode())
    process.stdin.close()
    token = ""
    return process.wait()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"Runner launch refused ({type(error).__name__}); verify private file and arguments", file=sys.stderr)
        sys.exit(1)
