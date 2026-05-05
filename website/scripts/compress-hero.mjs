// One-shot hero-video compression. Run with `node scripts/compress-hero.mjs`.
//
// Reads `assets/hero.mp4` (the original master, expected to be large —
// 100MB+ raw export from the source tool), inspects it with ffprobe,
// and emits two compressed siblings:
//
//   assets/hero.mp4   — H.264 baseline, faststart, no audio (overwritten)
//   assets/hero.webm  — VP9 (~30% smaller than H.264 at same quality)
//
// The original is NOT preserved here on disk — it's gitignored anyway,
// and the user keeps the master in cloud storage. If you need to re-run
// with different settings, restore the master and re-run.
//
// Why these settings:
//   - 720p cap: full-bleed hero with a dark overlay + foreground text.
//     1080p is wasted bytes at typical viewport sizes, and the overlay
//     hides fine detail that 720p would otherwise miss. ~2× saving.
//   - 24 fps: smooth enough for a slow hero loop; halves bitrate vs 60.
//   - CRF 32 (mp4) / 38 (webm): aggressive but visually clean given the
//     overlay + slow motion. Industry hero loops typically ship CRF 28-32
//     for H.264. We err toward the cheap side because bandwidth is the
//     binding cost.
//   - No audio: muted hero, no point shipping AAC stream.
//   - faststart on H.264: moves moov atom to file head so the browser
//     can begin playback before the whole body downloads. Without this
//     the `<video preload>` ends up fetching extra ranges.
//   - VP9 deadline=best + cpu-used=0: maximum compression at the cost
//     of encode time (~10-15min). One-shot encode so it's fine.

import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { spawnSync } from 'node:child_process';
import { statSync, renameSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'assets', 'hero.mp4');
const SRC_BACKUP = resolve(ROOT, 'assets', 'hero.original.mp4');
const OUT_MP4 = resolve(ROOT, 'assets', 'hero.mp4');
const OUT_WEBM = resolve(ROOT, 'assets', 'hero.webm');
// Poster lives in public/ so Vite copies it verbatim to dist/ root.
// Loaded eagerly with the HTML (well before JS runs) so the hero
// section never paints empty.
const OUT_POSTER = resolve(ROOT, 'public', 'hero-poster.jpg');

// Trim: take a 15-second segment starting at 0s. The source is a 120s
// master but a hero loop only needs 10-15s — that alone is an 8× cost
// win. Override via env vars if a different window suits the footage:
//   TRIM_START=30 TRIM_DURATION=12 node scripts/compress-hero.mjs
const TRIM_START = process.env.TRIM_START ?? '0';
const TRIM_DURATION = process.env.TRIM_DURATION ?? '15';

if (!existsSync(SRC)) {
  console.error(`[compress-hero] source not found: ${SRC}`);
  process.exit(1);
}

// Back up the original on first run so re-runs can restore from disk.
if (!existsSync(SRC_BACKUP)) {
  console.log(`[compress-hero] backing up original → hero.original.mp4`);
  copyFileSync(SRC, SRC_BACKUP);
}
const SOURCE_FOR_ENCODE = SRC_BACKUP;

const sourceSize = statSync(SOURCE_FOR_ENCODE).size;
const sizeMB = (b) => (b / 1024 / 1024).toFixed(2);

// ---- Probe ----------------------------------------------------------------
console.log(`[compress-hero] probing source: ${SOURCE_FOR_ENCODE}`);
const probe = spawnSync(
  ffprobeStatic.path,
  [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,r_frame_rate,duration,bit_rate',
    '-of',
    'json',
    SOURCE_FOR_ENCODE,
  ],
  { encoding: 'utf8' },
);
if (probe.status !== 0) {
  console.error('[compress-hero] ffprobe failed', probe.stderr);
  process.exit(1);
}
const probeJson = JSON.parse(probe.stdout);
const stream = probeJson.streams?.[0] ?? {};
const [num, den] = (stream.r_frame_rate ?? '0/1').split('/').map(Number);
const fps = den ? num / den : 0;
console.log(
  `[compress-hero] source: ${stream.width}×${stream.height} @ ${fps.toFixed(2)}fps · ${sizeMB(sourceSize)} MB · duration ${stream.duration}s`,
);
console.log(
  `[compress-hero] trim: ${TRIM_START}s → +${TRIM_DURATION}s (override with TRIM_START / TRIM_DURATION env vars)`,
);

// ---- Common filter --------------------------------------------------------
// scale: cap to 720p (preserve aspect), force-even dimensions for codecs.
// fps: cap to 24 — heroes don't need 60.
const SCALE_FILTER = "scale='min(1280,iw)':-2:flags=lanczos,fps=24";

// ---- 1) MP4 / H.264 -------------------------------------------------------
console.log(`[compress-hero] encoding mp4 (H.264, CRF 28, faststart)...`);
const mp4Run = spawnSync(
  ffmpegPath,
  [
    '-y',
    // -ss/-t BEFORE -i is the fast-seek path: ffmpeg jumps to the
    // keyframe at TRIM_START rather than decoding from frame 0. Less
    // accurate at sub-second precision but fine for hero-loop trimming.
    '-ss',
    TRIM_START,
    '-t',
    TRIM_DURATION,
    '-i',
    SOURCE_FOR_ENCODE,
    '-an',
    '-vf',
    SCALE_FILTER,
    '-c:v',
    'libx264',
    '-preset',
    'veryslow', // one-time encode; spend CPU once for smallest bytes
    '-crf',
    '32',
    '-pix_fmt',
    'yuv420p', // ensures broadest browser compatibility
    '-profile:v',
    'high',
    '-level',
    '4.0',
    '-movflags',
    '+faststart',
    OUT_MP4 + '.tmp.mp4',
  ],
  { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' },
);
if (mp4Run.status !== 0) {
  console.error('[compress-hero] mp4 encode failed (exit', mp4Run.status, ')');
  console.error('---- ffmpeg stderr (tail) ----');
  console.error((mp4Run.stderr ?? '').split('\n').slice(-25).join('\n'));
  process.exit(1);
}
// Windows fs.renameSync can EPERM when overwriting an existing file
// that the OS hasn't fully released. Unlink first; if the rename then
// still EPERMs, retry once after a short delay.
if (existsSync(OUT_MP4)) {
  try {
    unlinkSync(OUT_MP4);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
renameSync(OUT_MP4 + '.tmp.mp4', OUT_MP4);
const mp4Size = statSync(OUT_MP4).size;
console.log(
  `[compress-hero] mp4 done: ${sizeMB(mp4Size)} MB (${((1 - mp4Size / sourceSize) * 100).toFixed(1)}% smaller)`,
);

// ---- 2) WebM / VP9 --------------------------------------------------------
console.log(`[compress-hero] encoding webm (VP9, CRF 32)...`);
const webmRun = spawnSync(
  ffmpegPath,
  [
    '-y',
    '-ss',
    TRIM_START,
    '-t',
    TRIM_DURATION,
    '-i',
    SOURCE_FOR_ENCODE,
    '-an',
    '-vf',
    SCALE_FILTER,
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '38',
    '-b:v',
    '0', // CRF mode (constant quality)
    '-row-mt',
    '1', // multi-threaded encode rows
    '-deadline',
    'best',
    '-cpu-used',
    '0',
    '-pix_fmt',
    'yuv420p',
    OUT_WEBM,
  ],
  { stdio: 'inherit' },
);
if (webmRun.status !== 0) {
  console.error('[compress-hero] webm encode failed');
  process.exit(1);
}
const webmSize = statSync(OUT_WEBM).size;
console.log(
  `[compress-hero] webm done: ${sizeMB(webmSize)} MB (${((1 - webmSize / sourceSize) * 100).toFixed(1)}% smaller)`,
);

// ---- 3) Poster JPEG -------------------------------------------------------
// Single frame from t=0 of the trimmed clip, 1280px wide, JPEG q=4
// (≈ visually transparent). Ends up <50KB and is what visitors see
// before the video mounts (or instead of it, on data-saver / 2g).
console.log(`[compress-hero] extracting poster jpeg...`);
const posterRun = spawnSync(
  ffmpegPath,
  [
    '-y',
    '-ss',
    TRIM_START,
    '-i',
    SOURCE_FOR_ENCODE,
    '-frames:v',
    '1',
    '-vf',
    "scale='min(1280,iw)':-2:flags=lanczos",
    '-q:v',
    '4', // mjpeg quality scale (2=best, 31=worst); 4 is a sweet spot
    OUT_POSTER,
  ],
  { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' },
);
if (posterRun.status !== 0) {
  console.error('[compress-hero] poster encode failed (exit', posterRun.status, ')');
  console.error('---- ffmpeg stderr (tail) ----');
  console.error((posterRun.stderr ?? '').split('\n').slice(-25).join('\n'));
  process.exit(1);
}
const posterSize = statSync(OUT_POSTER).size;
console.log(`[compress-hero] poster done: ${sizeMB(posterSize)} MB`);

// ---- Summary --------------------------------------------------------------
console.log('');
console.log('======================================================');
console.log(`Source            : ${sizeMB(sourceSize).padStart(8)} MB`);
console.log(`hero.mp4          : ${sizeMB(mp4Size).padStart(8)} MB  (H.264)`);
console.log(`hero.webm         : ${sizeMB(webmSize).padStart(8)} MB  (VP9, currently unused)`);
console.log(`hero-poster.jpg   : ${sizeMB(posterSize).padStart(8)} MB`);
console.log('======================================================');
console.log('');
console.log('Browsers will pick webm first (smaller); mp4 is the universal fallback.');
console.log('Re-run any time — the original master is preserved at hero.original.mp4');
