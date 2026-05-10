import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const distDir = path.resolve("dist");
const artifactExtensions = new Set([".AppImage", ".appx", ".deb", ".dmg", ".exe", ".zip"]);

const entries = await readdir(distDir, { withFileTypes: true }).catch(() => []);
const files = entries
  .filter((entry) => entry.isFile() && artifactExtensions.has(path.extname(entry.name)))
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  throw new Error("No release artifacts found in dist/ for checksum generation.");
}

const lines = [];
for (const file of files) {
  const data = await readFile(path.join(distDir, file));
  lines.push(`${createHash("sha256").update(data).digest("hex")} *${file}`);
}

await writeFile(path.join(distDir, "SHASUMS256.txt"), `${lines.join("\n")}\n`, "utf-8");
console.log(`Wrote checksums for ${files.length} artifact(s) to dist/SHASUMS256.txt`);
