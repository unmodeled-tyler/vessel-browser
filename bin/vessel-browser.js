#!/usr/bin/env node
const { spawn } = require("child_process");
const path = require("path");

const electronPath = require("electron");
const appPath = path.resolve(__dirname, "..");

const child = spawn(electronPath, [appPath], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_IS_NPM_LAUNCH: "1" },
});

child.on("close", (code) => {
  process.exit(code ?? 0);
});
