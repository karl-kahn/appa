#!/usr/bin/env node
// Copy non-TS assets (.html, .css, .md) from src/ to dist/ preserving structure.

import { readdir, mkdir, copyFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const DEST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const EXT = new Set([".html", ".css", ".md", ".svg", ".png", ".jpg", ".jpeg"]);

async function walk(dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, files);
    } else if (EXT.has(extOf(e.name))) {
      files.push(full);
    }
  }
  return files;
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

const files = await walk(SRC);
for (const src of files) {
  const rel = relative(SRC, src);
  const out = join(DEST, rel);
  await mkdir(dirname(out), { recursive: true });
  await copyFile(src, out);
}
console.log(`copied ${files.length} assets to dist/`);
