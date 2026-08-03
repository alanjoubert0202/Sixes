#!/usr/bin/env node
/**
 * Writes dist/sw.js after the Vite build.
 *
 * Vite hashes its output filenames, so the precache list can only be known once
 * the build exists. This walks dist/, injects the list plus a content-derived
 * version into the template, and writes the finished worker.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const template = join(root, 'scripts', 'sw-template.js');

/** Never precache these — the worker itself, and anything not worth the bytes. */
const SKIP = new Set(['sw.js']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let files;
try {
  files = walk(dist);
} catch {
  console.error('gen-sw: dist/ not found — run `vite build` first.');
  process.exit(1);
}

const hash = createHash('sha256');
const urls = [];

for (const file of files.sort()) {
  const url = `/${relative(dist, file).split(sep).join('/')}`;
  hash.update(readFileSync(file));
  if (SKIP.has(url.slice(1))) continue;
  urls.push(url);
}

// The shell must be reachable by its route as well as its filename.
if (!urls.includes('/index.html')) urls.push('/index.html');
urls.unshift('/');

const version = hash.digest('hex').slice(0, 12);
const precache = [...new Set(urls)];
const source = readFileSync(template, 'utf8')
  .replaceAll('__VERSION__', version)
  .replaceAll('__PRECACHE__', JSON.stringify(precache, null, 2));

// A worker that still carries a placeholder would cache nothing and silently
// break offline play, so fail the build rather than ship it.
for (const token of ['__VERSION__', '__PRECACHE__']) {
  if (source.includes(token)) {
    console.error(`gen-sw: ${token} was not substituted — check scripts/sw-template.js`);
    process.exit(1);
  }
}

writeFileSync(join(dist, 'sw.js'), source);
console.log(`gen-sw: dist/sw.js — ${precache.length} entries, version ${version}`);
