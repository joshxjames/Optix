// Computes SHA256 CSP hash for the inline theme-bootstrap script in
// src/renderer/widget/index.html. Re-run this whenever the script body
// changes and update the `<meta http-equiv="Content-Security-Policy">`
// header accordingly.
//
//   node optix/desktop/scripts/compute-csp-hash.cjs
//
// The script must read the EXACT bytes between `<script>` and `</script>`
// (no whitespace stripping, no normalization) — the CSP hash is over the
// literal script body.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HTML_PATH = path.resolve(
  __dirname,
  '..',
  'src',
  'renderer',
  'widget',
  'index.html',
);

const html = fs.readFileSync(HTML_PATH, 'utf8');
// Match the FIRST inline <script> ... </script> (no `src=` attribute).
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) {
  console.error('No inline <script> block found in', HTML_PATH);
  process.exit(1);
}
const body = match[1];
const hash = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
console.log(`sha256-${hash}`);
