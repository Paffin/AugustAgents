#!/usr/bin/env bash
# August installer. Download it, read it, run it:
#
#   curl -fsSL https://raw.githubusercontent.com/Paffin/augustagents/main/install.sh -o install.sh
#   bash install.sh
#
# What it does, and nothing else:
#   1. checks for Bun (offers to install it from bun.sh if missing)
#   2. puts August in ~/.august/app (git clone, or a tarball when git is absent)
#   3. adds the "august" command to ~/.local/bin
#   4. runs "august setup" (three questions) when a terminal is attached
#
# Settings: AUGUST_REF (branch or tag, default main), AUGUST_SOURCE (local folder to copy instead of downloading),
#           AUGUST_HOME (default ~/.august), AUGUST_BIN (default ~/.local/bin), AUGUST_NO_SETUP=1.
set -euo pipefail

REPO="https://github.com/Paffin/augustagents"
REF="${AUGUST_REF:-main}"
AUGUST_HOME="${AUGUST_HOME:-$HOME/.august}"
APP="$AUGUST_HOME/app"
BIN_DIR="${AUGUST_BIN:-$HOME/.local/bin}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'august install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) die "only Linux and macOS are supported for now (on Windows use WSL)";;
esac
case "$REF" in
  *[!A-Za-z0-9._/-]*|"") die "AUGUST_REF has unexpected characters";;
esac

tty_available() { [ -t 1 ] && { : </dev/tty; } 2>/dev/null; }

# 1. Bun
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  elif tty_available; then
    printf 'Bun (the JavaScript runtime August uses) is not installed. Install it from bun.sh now? [Y/n] '
    read -r answer </dev/tty || answer=n
    case "$answer" in n|N|no|No) die "install Bun from https://bun.sh and run this again";; esac
    tmp="$(mktemp)"
    curl -fsSL https://bun.sh/install -o "$tmp"
    bash "$tmp"
    rm -f "$tmp"
    export PATH="$HOME/.bun/bin:$PATH"
  else
    die "Bun is required: install it from https://bun.sh and run this again"
  fi
fi
bun_version="$(bun --version)"
case "$bun_version" in
  0.*|1.0.*) die "Bun $bun_version is too old; run: bun upgrade";;
esac

# 2. August itself
mkdir -p "$AUGUST_HOME"
chmod 700 "$AUGUST_HOME"
if [ -n "${AUGUST_SOURCE:-}" ]; then
  [ -f "$AUGUST_SOURCE/packages/app/src/bin.ts" ] || die "AUGUST_SOURCE does not look like an August checkout"
  rm -rf "$APP"
  mkdir -p "$APP"
  (cd "$AUGUST_SOURCE" && tar --exclude=.git --exclude=node_modules -cf - .) | (cd "$APP" && tar -xf -)
elif command -v git >/dev/null 2>&1; then
  if [ -d "$APP/.git" ]; then
    say "Updating August in $APP"
    git -C "$APP" fetch --depth 1 origin "$REF"
    git -C "$APP" checkout -q --detach FETCH_HEAD
  else
    say "Downloading August to $APP"
    rm -rf "$APP"
    git clone -q --depth 1 --branch "$REF" "$REPO" "$APP"
  fi
else
  say "Downloading August to $APP"
  tmp="$(mktemp -d)"
  curl -fsSL "$REPO/archive/$REF.tar.gz" -o "$tmp/august.tar.gz"
  rm -rf "$APP"
  mkdir -p "$APP"
  tar -xzf "$tmp/august.tar.gz" -C "$APP" --strip-components 1
  rm -rf "$tmp"
fi

# 3. The command
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/august" <<LAUNCHER
#!/bin/sh
exec bun "$APP/packages/app/src/bin.ts" "\$@"
LAUNCHER
chmod 755 "$BIN_DIR/august"
case ":$PATH:" in
  *":$BIN_DIR:"*) on_path=1 ;;
  *) on_path=0 ;;
esac

say "August is installed."
[ "$on_path" = 1 ] || printf 'Add this to your shell profile: export PATH="%s:$PATH"\n' "$BIN_DIR"

# 4. Setup
if [ "${AUGUST_NO_SETUP:-0}" != 1 ] && tty_available; then
  "$BIN_DIR/august" setup </dev/tty
else
  echo 'Next: run "august setup".'
fi
