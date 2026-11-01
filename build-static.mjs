// Builds a static HTTPS-hosting bundle: plain files, no server-side rendering.
// Works on Caddy, Nginx, GitHub Pages, Vercel, Netlify, Cloudflare Pages.
//
//   node build-static.mjs
//
// Output: dist/
//   index.html            (runtime flag __PQ_STATIC_HOST__ injected)
//   styles.css  config.js
//   js/*.js               (ES modules, served as-is)
//   assets/*              (icons, favicon)
//   manifest.webmanifest
//   sw.js
//   content.json          (generated file listing; replaces /local-api/content)
//   backgrounds/*         (real files, replaceable before upload)
//   prompts/*             (real files, replaceable before upload)
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const WEB = path.join(ROOT, 'web');
const DIST = path.join(ROOT, 'dist');

const BACKGROUND_EXT = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp']);
const PROMPT_EXT = new Set(['.md', '.txt']);

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function resetDist() {
  ensureDir(DIST);
  // Clean only the generated artefacts so a stale build cannot linger.
  for (const entry of readdirSync(DIST)) {
    rmSync(path.join(DIST, entry), { recursive: true, force: true });
  }
}

function listByExtension(dir, allowed) {
  if (!statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => allowed.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

function copyTree(from, to) {
  ensureDir(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest);
    else copyFileSync(src, dest);
  }
}

const MIME = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

// Backgrounds are embedded as data URLs in content.json.
//
// Windows IIS (what the 宝塔 Windows panel serves with) ships without an .svg
// MIME mapping, so a plain backgrounds/default.svg would 404 and the page would
// fall back to a bare gradient. Embedding sidesteps MIME configuration entirely
// and works identically on IIS, Apache, Nginx and any static host.
function dataURLFor(file, name) {
  const mime = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
  const base64 = readFileSync(file).toString('base64');
  return `data:${mime};base64,${base64}`;
}

function buildContentManifest(backgrounds) {
  const promptEntries = listByExtension(path.join(ROOT, 'prompts'), PROMPT_EXT)
    .filter((name) => !name.toUpperCase().startsWith('README'))
    // Prompt bodies ship as .txt: IIS has no .md MIME mapping by default.
    .map((name) => {
      const shipped = name.replace(/\.md$/i, '.txt');
      return { name: shipped, url: `prompts/${encodeURIComponent(shipped)}` };
    });

  const defaultBackground = backgrounds.find((item) => item.name === 'default.svg')?.name
    || backgrounds.find((item) => item.name === 'default.png' || item.name === 'default.jpg')?.name
    || backgrounds[0]?.name
    || '';
  const defaultPrompt = promptEntries.find((entry) => entry.name.startsWith('01-'))?.name
    || promptEntries[0]?.name
    || '';
  return { backgrounds, prompts: promptEntries, defaultBackground, defaultPrompt };
}

function readBackgrounds() {
  const dir = path.join(ROOT, 'backgrounds');
  return listByExtension(dir, BACKGROUND_EXT).map((name) => ({
    name,
    url: dataURLFor(path.join(dir, name), name),
  }));
}

function writePromptFiles() {
  const target = path.join(DIST, 'prompts');
  ensureDir(target);
  for (const name of listByExtension(path.join(ROOT, 'prompts'), PROMPT_EXT)) {
    if (name.toUpperCase().startsWith('README')) continue;
    const shipped = name.replace(/\.md$/i, '.txt');
    copyFileSync(path.join(ROOT, 'prompts', name), path.join(target, shipped));
  }
}

// Windows hosts need explicit MIME mappings for the modern extensions this site
// uses. web.config covers IIS (宝塔 Windows), .htaccess covers Apache.
function writeServerConfig() {
  const webConfig = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <defaultDocument>
      <files>
        <clear />
        <add value="index.html" />
      </files>
    </defaultDocument>
    <staticContent>
      <remove fileExtension=".json" />
      <mimeMap fileExtension=".json" mimeType="application/json" />
      <remove fileExtension=".webmanifest" />
      <mimeMap fileExtension=".webmanifest" mimeType="application/manifest+json" />
      <remove fileExtension=".svg" />
      <mimeMap fileExtension=".svg" mimeType="image/svg+xml" />
      <remove fileExtension=".webp" />
      <mimeMap fileExtension=".webp" mimeType="image/webp" />
      <remove fileExtension=".md" />
      <mimeMap fileExtension=".md" mimeType="text/markdown; charset=utf-8" />
      <remove fileExtension=".txt" />
      <mimeMap fileExtension=".txt" mimeType="text/plain; charset=utf-8" />
      <remove fileExtension=".js" />
      <mimeMap fileExtension=".js" mimeType="text/javascript; charset=utf-8" />
    </staticContent>
    <httpProtocol>
      <customHeaders>
        <add name="X-Content-Type-Options" value="nosniff" />
        <add name="X-Frame-Options" value="DENY" />
        <add name="Referrer-Policy" value="no-referrer" />
      </customHeaders>
    </httpProtocol>
  </system.webServer>
</configuration>
`;
  writeFileSync(path.join(DIST, 'web.config'), webConfig, 'utf8');

  const htaccess = `# Apache 站点配置（宝塔 Windows 若使用 Apache 时生效）
AddDefaultCharset UTF-8
DirectoryIndex index.html

AddType application/json .json
AddType application/manifest+json .webmanifest
AddType image/svg+xml .svg
AddType image/webp .webp
AddType text/markdown .md
AddType text/plain .txt
AddType text/javascript .js

<IfModule mod_headers.c>
  Header set X-Content-Type-Options "nosniff"
  Header set X-Frame-Options "DENY"
  Header set Referrer-Policy "no-referrer"
</IfModule>

# 提示词与内容清单不缓存，改完刷新即生效
<FilesMatch "^(content\\.json|sw\\.js)$">
  <IfModule mod_headers.c>
    Header set Cache-Control "no-cache"
  </IfModule>
</FilesMatch>
`;
  writeFileSync(path.join(DIST, '.htaccess'), htaccess, 'utf8');
}

function stampIndex() {
  const source = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const withFlag = source.replace(
    '<script src="js/boot.js"></script>',
    () => [
      '<script src="js/boot.js"></script>',
      '<script>window.__PQ_STATIC_HOST__ = true;</script>',
    ].join('\n  '),
  );
  if (!withFlag.includes('__PQ_STATIC_HOST__')) {
    throw new Error('could not inject the static-host flag; index.html changed?');
  }
  writeFileSync(path.join(DIST, 'index.html'), withFlag, 'utf8');
}

function main() {
  resetDist();

  // Shell files.
  stampIndex();
  for (const name of ['styles.css', 'config.js', 'manifest.webmanifest', 'sw.js']) {
    copyFileSync(path.join(WEB, name), path.join(DIST, name));
  }
  copyTree(path.join(WEB, 'js'), path.join(DIST, 'js'));
  copyTree(path.join(WEB, 'assets'), path.join(DIST, 'assets'));

  // Prompt bodies ship as .txt so IIS can serve them without extra MIME setup.
  writePromptFiles();

  // Backgrounds are embedded in content.json as data URLs, so no image file has
  // to survive the host's MIME configuration.
  const backgrounds = readBackgrounds();
  // Keep the raw images on disk too, so the folder stays human-manageable and
  // operators can drop in new files before rebuilding.
  copyTree(path.join(ROOT, 'backgrounds'), path.join(DIST, 'backgrounds'));

  // Content listing, because static hosts cannot enumerate directories.
  const manifest = buildContentManifest(backgrounds);
  writeFileSync(path.join(DIST, 'content.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // IIS / Apache need explicit MIME mappings for .json, .svg, .webmanifest ...
  // 宝塔 Windows uses IIS, where a missing .svg mapping would 404 the artwork.
  writeServerConfig();

  console.log(`static bundle written to ${DIST}`);
  console.log(`  backgrounds: ${manifest.backgrounds.length} (embedded as data URLs)`);
  console.log(`  prompts:     ${manifest.prompts.length} (.txt, IIS-safe)`);
  console.log('  web.config + .htaccess included for Windows/Apache hosting');
  console.log('  upload the contents of dist/ to your web root.');
}

main();
