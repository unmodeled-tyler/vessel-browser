import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";

function findIconBase64(): string {
  const candidates = [
    path.join(app.getAppPath(), "resources", "vessel-icon-400x400.png"),
    path.join(process.resourcesPath, "vessel-icon-400x400.png"),
    path.join(__dirname, "../../resources/vessel-icon-400x400.png"),
    path.join(app.getAppPath(), "resources", "vessel-icon.png"),
    path.join(process.resourcesPath, "vessel-icon.png"),
    path.join(__dirname, "../../resources/vessel-icon.png"),
  ];
  for (const p of candidates) {
    try {
      const data = fs.readFileSync(p);
      return `data:image/png;base64,${data.toString("base64")}`;
    } catch {
      // try next
    }
  }
  return "";
}

function buildSplashHTML(iconSrc: string): string {
  const imgTag = iconSrc
    ? `<img class="logo" src="${iconSrc}" alt="" />`
    : `<div class="logo-fallback">V</div>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%;
    background: #1a1a1e;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 20px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    overflow: hidden;
    -webkit-app-region: drag;
    user-select: none;
  }
  .logo-wrap {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: pop-in 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  .glow {
    position: absolute;
    inset: -16px;
    border-radius: 36px;
    background: radial-gradient(ellipse at center,
      rgba(196, 160, 90, 0.22) 0%,
      transparent 68%
    );
    animation: glow-pulse 2.8s ease-in-out infinite;
  }
  .logo {
    width: 84px;
    height: 84px;
    border-radius: 20px;
    display: block;
    position: relative;
  }
  .logo-fallback {
    width: 84px;
    height: 84px;
    border-radius: 20px;
    background: linear-gradient(135deg, #2a2a30, #1e1e24);
    border: 1px solid rgba(196, 160, 90, 0.25);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 36px;
    font-weight: 700;
    color: #c4a05a;
    position: relative;
  }
  .name {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.22em;
    color: #7a7a8a;
    text-transform: uppercase;
    animation: fade-up 0.5s 0.2s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .dots {
    display: flex;
    gap: 6px;
    animation: fade-up 0.4s 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #3e3e50;
    animation: dot-bounce 1.5s ease-in-out infinite;
  }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }

  @keyframes pop-in {
    from { opacity: 0; transform: scale(0.78); }
    to   { opacity: 1; transform: scale(1); }
  }
  @keyframes fade-up {
    from { opacity: 0; transform: translateY(7px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes glow-pulse {
    0%, 100% { opacity: 0.55; transform: scale(1); }
    50%       { opacity: 1;    transform: scale(1.1); }
  }
  @keyframes dot-bounce {
    0%, 75%, 100% { transform: translateY(0);   opacity: 0.3; }
    40%           { transform: translateY(-6px); opacity: 1;   }
  }
</style>
</head>
<body>
  <div class="logo-wrap">
    <div class="glow"></div>
    ${imgTag}
  </div>
  <div class="name">Vessel</div>
  <div class="dots">
    <div class="dot"></div>
    <div class="dot"></div>
    <div class="dot"></div>
  </div>
</body>
</html>`;
}

export function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 1280,
    height: 800,
    center: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#1a1a1e",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const iconSrc = findIconBase64();
  const html = buildSplashHTML(iconSrc);
  void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  return splash;
}

/**
 * Closes the splash window after the main window is visible.
 * Waits a brief moment so the main window has time to paint before
 * the splash disappears.
 */
export function closeSplash(splash: BrowserWindow, delayMs = 180): void {
  setTimeout(() => {
    if (!splash.isDestroyed()) {
      splash.close();
    }
  }, delayMs);
}
