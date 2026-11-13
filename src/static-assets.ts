import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface AssetManifest { version: string; files: string[] }

/** The service worker cannot list itself; everything else under public/ is part of the offline app shell. */
const EXCLUDED = new Set(['sw.js']);
/** The customer app is not part of the till's offline shell. */
const GUEST_DIR = 'guest/';
const VERSION_CHARS = 12;

let cache: { signature: string; manifest: AssetManifest } | undefined;

function walk(dir: string, root: string, out: Array<{ path: string; full: string; stamp: string }>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, root, out); continue; }
    const path = relative(root, full).split(sep).join('/');
    if (EXCLUDED.has(path) || path.startsWith(GUEST_DIR)) continue;
    const st = statSync(full);
    out.push({ path, full, stamp: `${path}:${st.size}:${st.mtimeMs}` });
  }
}

/**
 * Lists every public file with a version that changes whenever any file's content changes.
 * Re-hashing only happens when a size or mtime changed, so serving sw.js stays cheap.
 */
export function buildAssetManifest(publicDir: string): AssetManifest {
  const found: Array<{ path: string; full: string; stamp: string }> = [];
  walk(publicDir, publicDir, found);
  found.sort((a, b) => (a.path < b.path ? -1 : 1));
  const signature = found.map((f) => f.stamp).join('|');
  if (cache?.signature === signature) return cache.manifest;
  const hash = createHash('sha256');
  for (const f of found) hash.update(f.path).update(readFileSync(f.full));
  const manifest = { version: hash.digest('hex').slice(0, VERSION_CHARS), files: found.map((f) => f.path) };
  cache = { signature, manifest };
  return manifest;
}
