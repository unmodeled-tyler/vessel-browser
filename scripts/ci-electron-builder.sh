#!/usr/bin/env bash
set -euo pipefail

attempts="${ELECTRON_BUILDER_ATTEMPTS:-3}"
delay_seconds="${ELECTRON_BUILDER_RETRY_DELAY_SECONDS:-15}"

if [[ "$attempts" -lt 1 ]]; then
  attempts=1
fi

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  echo "::group::electron-builder attempt ${attempt}/${attempts}"
  if npx electron-builder "$@"; then
    echo "::endgroup::"
    exit 0
  fi
  status=$?
  echo "::endgroup::"

  if [[ "$attempt" -eq "$attempts" ]]; then
    exit "$status"
  fi

  echo "electron-builder failed with exit code ${status}; retrying in ${delay_seconds}s..."
  sleep "$delay_seconds"
done
