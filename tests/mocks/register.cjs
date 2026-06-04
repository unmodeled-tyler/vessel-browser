const { Module } = require("module");
const original = Module._resolveFilename;
const path = require("path");
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request === "electron") {
    return path.resolve(__dirname, "electron.cjs");
  }
  return original.call(this, request, parent, isMain, options);
};
