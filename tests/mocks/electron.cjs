const os = require("os");
const path = require("path");

let wcId = 0;

function createMockWebContents() {
  wcId += 1;
  let zoom = 0;
  return {
    id: wcId,
    isDestroyed: () => false,
    getURL: () => "about:blank",
    getTitle: () => "New Tab",
    session: {
      fromPartition: () => ({ setCertificateVerifyProc: () => {} }),
      setCertificateVerifyProc: () => {},
    },
    loadURL: () => {},
    reload: () => {},
    getZoomLevel: () => zoom,
    setZoomLevel: (v) => { zoom = v; },
    setAudioMuted: () => {},
    isAudioMuted: () => false,
    isCurrentlyAudible: () => false,
    executeJavaScript: () => Promise.resolve({}),
    setWindowOpenHandler: () => {},
    on: () => {},
    once: () => {},
    removeListener: () => {},
    close: () => {},
    copy: () => {},
    paste: () => {},
    cut: () => {},
    selectAll: () => {},
    send: () => {},
  };
}

function WebContentsView(opts) {
  const session = opts?.webPreferences?.session;
  this.webContents = createMockWebContents();
  if (session) {
    this.webContents.session = session;
  }
  this.setBounds = () => {};
}

module.exports = {
  app: {
    getPath: (name) => path.join(os.tmpdir(), `vessel-test-${name}`),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (str) => Buffer.from(str, "utf-8"),
    decryptString: (buf) => buf.toString("utf-8"),
  },
  BaseWindow: class BaseWindow {
    constructor() {
      this.contentView = { addChildView: () => {}, removeChildView: () => {} };
    }
  },
  WebContentsView,
  clipboard: { writeText: () => {} },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  MenuItem: class MenuItem {},
  session: {
    fromPartition: () => ({ setCertificateVerifyProc: () => {} }),
    defaultSession: { webRequest: { onBeforeRequest: () => {} } },
  },
};
