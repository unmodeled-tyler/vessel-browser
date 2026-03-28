#!/bin/bash
set -e

NOVNC_DIR="/usr/share/novnc"
VNC_PORT=5900
HTTP_PORT=7860

echo "===== Application Startup at $(date -u '+%Y-%m-%d %H:%M:%S') ====="

# Start virtual display
Xvfb :0 -screen 0 "${DISPLAY_RESOLUTION:-1280x800x24}" -ac &
sleep 2

# Window manager
fluxbox &
sleep 1

# VNC server
x11vnc -display :0 -forever -nopw -shared -rfbport "$VNC_PORT" -localhost &
sleep 1

# noVNC auto-connect page
cat > "$NOVNC_DIR/index.html" << 'REDIRECT'
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vessel Browser</title>
<script type="module">
import RFB from './core/rfb.js';

window.addEventListener('load', function() {
  const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
  const rfb = new RFB(
    document.body,
    protocol + window.location.host + '/websockify',
    { shared: true, wsProtocols: ['binary'] }
  );
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
});
</script>
<style>
  body { margin: 0; padding: 0; overflow: hidden; background: #000; }
  .noVNC_screen { width: 100vw !important; height: 100vh !important; }
</style>
</head>
<body></body>
</html>
REDIRECT

# WebSocket proxy
websockify --web "$NOVNC_DIR" "$HTTP_PORT" localhost:"$VNC_PORT" &
sleep 2

# Verify Electron binary exists
cd /app
ELECTRON_BIN="./node_modules/.bin/electron"
echo "[entrypoint] Checking Electron at: $ELECTRON_BIN"
if [ ! -f "$ELECTRON_BIN" ] && [ ! -L "$ELECTRON_BIN" ]; then
  echo "[entrypoint] ERROR: Electron binary not found at $ELECTRON_BIN"
  ls -la node_modules/.bin/electron* 2>/dev/null || echo "[entrypoint] No electron binaries in .bin"
  ls -la node_modules/electron/dist/ 2>/dev/null || echo "[entrypoint] No electron dist directory"
fi

# Check for missing shared libraries
echo "[entrypoint] Checking Electron shared library deps..."
ELECTRON_REAL=$(readlink -f node_modules/electron/dist/electron 2>/dev/null || echo "")
if [ -n "$ELECTRON_REAL" ] && [ -f "$ELECTRON_REAL" ]; then
  MISSING=$(ldd "$ELECTRON_REAL" 2>/dev/null | grep "not found" || true)
  if [ -n "$MISSING" ]; then
    echo "[entrypoint] WARNING: Missing shared libraries:"
    echo "$MISSING"
  else
    echo "[entrypoint] All shared libraries found."
  fi
else
  echo "[entrypoint] Could not resolve Electron binary for ldd check."
fi

# Check build output exists
if [ ! -f "out/main/index.js" ]; then
  echo "[entrypoint] ERROR: out/main/index.js not found — build output missing!"
  ls -la out/ 2>/dev/null || echo "[entrypoint] out/ directory does not exist"
fi

echo "[entrypoint] Starting Electron..."
exec npx electron . --no-sandbox --disable-setuid-sandbox --disable-gpu --disable-dev-shm-usage 2>&1
