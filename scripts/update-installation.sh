#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${VESSEL_INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${VESSEL_BRANCH:-main}"
CHECK_ONLY=0
FORMAT="text"

info() {
  printf '\033[1;34m==>\033[0m %s\n' "$1"
}

warn() {
  printf '\033[1;33m==>\033[0m %s\n' "$1"
}

fail() {
  printf '\033[1;31merror:\033[0m %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

usage() {
  cat <<'HELP'
Usage: vessel-browser-update [--check] [--json] [--help]

Options:
  --check   Check whether an update is available without modifying the install
  --json    Print machine-readable status
  --help    Show this help message
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      CHECK_ONLY=1
      ;;
    --json)
      FORMAT="json"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
  shift
done

require_cmd git
require_cmd node
require_cmd npm

[[ -d "$INSTALL_DIR/.git" ]] || fail "Vessel install is not a git checkout: $INSTALL_DIR"

DIRTY=0
if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]]; then
  DIRTY=1
fi

if [[ "$FORMAT" != "json" ]]; then
  info "Checking for Vessel updates on origin/$BRANCH"
fi
FETCH_ERROR=""
if ! FETCH_OUTPUT="$(git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH" 2>&1)"; then
  FETCH_ERROR="$FETCH_OUTPUT"
fi

LOCAL_REV="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
REMOTE_REV=""
UPDATE_AVAILABLE=0

if [[ -n "$FETCH_ERROR" ]]; then
  UPDATE_STATUS="fetch-failed"
elif REMOTE_REV="$(git -C "$INSTALL_DIR" rev-parse FETCH_HEAD 2>/dev/null)"; [[ "$LOCAL_REV" == "$REMOTE_REV" ]]; then
  UPDATE_STATUS="up-to-date"
else
  UPDATE_AVAILABLE=1
  UPDATE_STATUS="update-available"
fi

CAN_APPLY_UPDATE=0
if [[ "$DIRTY" -eq 0 && "$UPDATE_AVAILABLE" -eq 1 ]]; then
  CAN_APPLY_UPDATE=1
fi

if [[ "$FORMAT" == "json" ]]; then
  cat <<JSON
{
  "install_dir": "$INSTALL_DIR",
  "branch": "$BRANCH",
  "dirty": $( [[ "$DIRTY" -eq 1 ]] && printf 'true' || printf 'false' ),
  "local_rev": "$LOCAL_REV",
  "remote_rev": $(printf '%s' "$REMOTE_REV" | node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0,"utf8")));'),
  "up_to_date": $( [[ "$UPDATE_STATUS" == "up-to-date" ]] && printf 'true' || printf 'false' ),
  "update_available": $( [[ "$UPDATE_AVAILABLE" -eq 1 ]] && printf 'true' || printf 'false' ),
  "can_apply_update": $( [[ "$CAN_APPLY_UPDATE" -eq 1 ]] && printf 'true' || printf 'false' ),
  "status": "$UPDATE_STATUS",
  "fetch_error": $(printf '%s' "$FETCH_ERROR" | node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0,"utf8")));')
}
JSON
  exit 0
fi

if [[ -n "$FETCH_ERROR" ]]; then
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    warn "Unable to reach origin/$BRANCH right now. Launch as-is and try updating later."
    exit 0
  fi
  fail "Unable to reach origin/$BRANCH: $FETCH_ERROR"
fi

if [[ "$UPDATE_AVAILABLE" -eq 0 ]]; then
  info "Vessel is already up to date."
  exit 0
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  info "Update available for Vessel."
  printf 'local:  %s\n' "$LOCAL_REV"
  printf 'remote: %s\n' "$REMOTE_REV"
  if [[ "$DIRTY" -eq 1 ]]; then
    warn "Install directory has local changes. Launch as-is or clean/stash changes before updating: $INSTALL_DIR"
  fi
  exit 0
fi

if [[ "$DIRTY" -eq 1 ]]; then
  fail "Install directory has local changes. Resolve them before updating: $INSTALL_DIR"
fi

info "Updating Vessel in $INSTALL_DIR"
git -C "$INSTALL_DIR" checkout -B "$BRANCH" "origin/$BRANCH"

info "Installing npm dependencies"
npm --prefix "$INSTALL_DIR" install

info "Building Vessel"
npm --prefix "$INSTALL_DIR" run build

info "Vessel update complete."
