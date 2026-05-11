#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const allowedRepeatedBlankLines = new Set(["README.md", "docs/architecture.md"]);

const files = execFileSync("git", ["ls-files", "-z"], {
  encoding: "buffer",
})
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const issues = [];

function isBinary(buffer) {
  return buffer.includes(0);
}

function isGeneratedOrBuildOutput(file) {
  return (
    file.startsWith("coverage/") ||
    file.startsWith("dist/") ||
    file.startsWith("out/") ||
    file.endsWith(".tsbuildinfo") ||
    file === "package-lock.json"
  );
}

for (const file of files) {
  if (isGeneratedOrBuildOutput(file)) continue;

  const buffer = readFileSync(file);
  if (isBinary(buffer)) continue;

  const lines = buffer.toString("utf8").split(/\n/);
  let blankRunStart = 0;
  let blankRunLength = 0;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (/[ \t]+$/.test(line)) {
      issues.push(`${file}:${lineNumber} trailing whitespace`);
    }

    if (line.trim() === "") {
      if (blankRunLength === 0) blankRunStart = lineNumber;
      blankRunLength += 1;
      return;
    }

    if (blankRunLength > 1 && !allowedRepeatedBlankLines.has(file)) {
      issues.push(
        `${file}:${blankRunStart}-${lineNumber - 1} repeated blank lines`,
      );
    }
    blankRunLength = 0;
  });

  if (blankRunLength > 1 && !allowedRepeatedBlankLines.has(file)) {
    issues.push(`${file}:${blankRunStart}-${lines.length} repeated blank lines`);
  }
}

if (issues.length > 0) {
  console.error("Cleanup check failed:");
  for (const issue of issues) {
    console.error(`  ${issue}`);
  }
  process.exit(1);
}

console.log("Cleanup check passed.");
