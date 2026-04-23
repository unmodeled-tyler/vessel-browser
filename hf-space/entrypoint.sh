#!/bin/bash
set -e

NOVNC_DIR="/usr/share/novnc"
VNC_PORT=5900
HTTP_PORT=7860

echo "===== Application Startup at $(date -u '+%Y-%m-%d %H:%M:%S') ====="

# Graceful shutdown on SIGTERM
cleanup() {
  echo "[entrypoint] Received SIGTERM, shutting down gracefully..."
  kill "$ELECTRON_PID" 2>/dev/null || true
  kill "$WEBSOCKIFY_PID" 2>/dev/null || true
  kill "$X11VNC_PID" 2>/dev/null || true
  kill "$FLUXBOX_PID" 2>/dev/null || true
  kill "$XVFB_PID" 2>/dev/null || true
  wait
  echo "[entrypoint] Shutdown complete."
}
trap cleanup SIGTERM SIGINT

# Start virtual display
Xvfb :0 -screen 0 "${DISPLAY_RESOLUTION:-1280x800x24}" -ac &
XVFB_PID=$!
sleep 2

# Window manager
fluxbox &
FLUXBOX_PID=$!
sleep 1

# VNC server
x11vnc -display :0 -forever -nopw -shared -rfbport "$VNC_PORT" -localhost &
X11VNC_PID=$!
sleep 1

# noVNC auto-connect page with auto-reconnect
mkdir -p "$NOVNC_DIR"
cat > "$NOVNC_DIR/index.html" << 'REDIRECT'
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vessel Browser</title>
<script type="module">
import RFB from './core/rfb.js';

let rfb;
let reconnectDelay = 1000;
const maxReconnectDelay = 30000;

function connect() {
  if (rfb) {
    rfb.disconnect();
    rfb = null;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
  rfb = new RFB(
    document.body,
    protocol + window.location.host + '/websockify',
    { shared: true, wsProtocols: ['binary'] }
  );
  rfb.scaleViewport = true;
  rfb.resizeSession = true;

  rfb.addEventListener('disconnect', function (e) {
    console.log('VNC disconnected:', e.detail.clean ? 'clean' : 'unexpected');
    scheduleReconnect();
  });

  rfb.addEventListener('connect', function () {
    console.log('VNC connected');
    reconnectDelay = 1000;
  });
}

function scheduleReconnect() {
  console.log('Reconnecting in', reconnectDelay, 'ms...');
  setTimeout(function () {
    connect();
    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
  }, reconnectDelay);
}

window.addEventListener('load', connect);
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
WEBSOCKIFY_PID=$!
sleep 2

# Verify Electron binary exists
cd /app
ELECTRON_BIN="./node_modules/.bin/electron"
echo "[entrypoint] Checking Electron at: $ELECTRON_BIN"
if [ ! -f "$ELECTRON_BIN" ] && [ ! -L "$ELECTRON_BIN" ]; then
  echo "[entrypoint] ERROR: Electron binary not found at $ELECTRON_BIN"
  ls -la node_modules/.bin/electron* 2>/dev/null || echo "[entrypoint] No electron binaries in .bin"
  ls -la node_modules/electron/dist/ 2>/dev/null || echo "[entrypoint] No electron dist directory"
  exit 1
fi

# Check for missing shared libraries
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
  exit 1
fi

# Launch Electron directly (no npx wrapper) so signals reach the right process
echo "[entrypoint] Starting Electron..."
"$ELECTRON_BIN" . --no-sandbox --disable-setuid-sandbox --disable-gpu --disable-dev-shm-usage &
ELECTRON_PID=$!

# Keep container alive and forward signals to the electron process
wait "$ELECTRON_PID"
