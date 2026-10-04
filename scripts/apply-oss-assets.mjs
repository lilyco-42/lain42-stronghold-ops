#!/usr/bin/env node
// Point data/assets.json at the OSS CDN host (dl.lain42.top) so the game pulls art / audio / spine
// from OSS instead of the ECS box, whose egress is only ~0.6 MB/s.
//
//   node tools/apply-oss-assets.mjs            # /assets/…  ->  https://dl.lain42.top/…/site/…
//   node tools/apply-oss-assets.mjs --revert   # restore the pristine site-relative manifest
//
// Idempotent: a second run is a no-op. deploy.sh calls this right after `fetch-assets.mjs --offline`,
// which regenerates data/assets.json from scratch and would otherwise drop the CDN rewrite.
//
// Why one file is deliberately left same-origin: the title screen loads entry/bg_mountains_tiled via a
// CSS background-image *and* a plain <img> (no crossorigin), while the battle backdrop loads the same
// URL through pixi (CORS). OSS does not emit `Vary: Origin` (ResponseVary is not writable via ossutil),
// so both requests share one cache entry and the CORS read dies with "No Access-Control-Allow-Origin".
// Keeping that file on our own origin avoids the collision; everything else goes to OSS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'data', 'assets.json');
const BACKUP = MANIFEST + '.site-local';

const BASE = (process.env.SP_SITE_BASE || 'https://dl.lain42.top/downloads/stronghold-protocol/site').replace(/\/+$/, '');
const LOCAL = '/assets';
const KEEP_LOCAL = ['/assets/ui/entry/bg_mountains_tiled.png'];

const raw = fs.readFileSync(MANIFEST, 'utf8');

if (process.argv.includes('--revert')) {
  if (!fs.existsSync(BACKUP)) { console.error(`no backup at ${BACKUP} — nothing to revert to`); process.exit(1); }
  fs.writeFileSync(MANIFEST, fs.readFileSync(BACKUP, 'utf8'));
  console.log(`reverted ${MANIFEST} from ${BACKUP}`);
  process.exit(0);
}

const PH = '\u0000KEEP\u0000';
const shield = (s) => { let w = s; KEEP_LOCAL.forEach((p, i) => { w = w.split(`"${p}"`).join(`"${PH}${i}"`); }); return w; };
const unshield = (s) => { let w = s; KEEP_LOCAL.forEach((p, i) => { w = w.split(`"${PH}${i}"`).join(`"${p}"`); }); return w; };

let work = shield(raw);
const before = (work.match(new RegExp(`"${LOCAL}/`, 'g')) || []).length;
if (before === 0) {
  console.log(`nothing to do: ${MANIFEST} already points at a CDN`);
  process.exit(0);
}

if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, raw);

work = unshield(work.split(`"${LOCAL}/`).join(`"${BASE}/`));

const urlCount = work.split(BASE).length - 1;
if (urlCount < before) {
  console.error(`refusing to write: only ${urlCount} CDN URLs vs ${before} candidates`);
  process.exit(1);
}
JSON.parse(work); // fail loudly rather than write a broken manifest
fs.writeFileSync(MANIFEST, work);
console.log(`rewrote ${before} entries -> ${BASE}`);
console.log(`kept same-origin: ${KEEP_LOCAL.join(', ')}`);
