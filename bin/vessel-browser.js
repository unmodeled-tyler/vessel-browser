#!/usr/bin/env node
const { spawn } = require("child_process");
const path = require("path");

let electronPath;
try {
  electronPath = require("electron");
} catch {
  console.error(
    'Error: "electron" is required but not installed.\n' +
    "Install it with: npm install -g electron"
  );
  process.exit(1);
}

const appPath = path.resolve(__dirname, "..");

const child = spawn(electronPath, [appPath], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_IS_NPM_LAUNCH: "1" },
});

child.on("close", (code) => {
  process.exit(code ?? 0);
});
