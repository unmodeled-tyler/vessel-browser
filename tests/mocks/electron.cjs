const os = require("os");
const path = require("path");
module.exports = {
  app: {
    getPath: (name) => path.join(os.tmpdir(), `vessel-test-${name}`),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (str) => Buffer.from(str, "utf-8"),
    decryptString: (buf) => buf.toString("utf-8"),
  },
};
