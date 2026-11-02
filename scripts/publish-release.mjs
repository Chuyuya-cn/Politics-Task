// Publishes the v1.0-Beta GitHub Release and uploads its assets.
//
// This machine cannot reach api.github.com on the address its resolver returns
// (20.205.243.168:443 is blocked), while other GitHub API addresses work. The
// script shells out to curl with --resolve to pin a working address per request.
//
// The token is read from ~/.git-credentials; it is never written into the repo
// and never printed.
//
// Usage: node scripts/publish-release.mjs [--tag v1.0-Beta] [--assets .release-assets] [--notes .release-notes.md]
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const OWNER = 'Chuyuya-cn';
const REPO = 'Politics-Task';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TAG = arg('--tag', 'v1.0-Beta');
const ASSET_DIR = arg('--assets', '.release-assets');
const NOTES_FILE = arg('--notes', '.release-notes.md');
const NAME = arg('--name', '政问 · 政治课程学习助手 v1.0-Beta');

const API_IPS = [
  '140.82.112.5', '140.82.113.5', '140.82.121.5', '140.82.114.5',
  '140.82.116.5', '20.27.177.116', '20.200.245.247',
];

function readToken() {
  const file = path.join(os.homedir(), '.git-credentials');
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/https:\/\/([^:]+):([^@]+)@github\.com/);
    if (m && m[1].toLowerCase() === OWNER.toLowerCase()) return m[2];
  }
  throw new Error(`no GitHub credential for ${OWNER}`);
}

// GitHub's asset uploader drops non-ASCII characters, so 政问-单文件版.html
// would arrive as "-.html". Give such files a readable ASCII name instead.
function asciiName(name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext)
    .replace(/[^\x20-\x7e]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return `${base || 'asset'}-single-file${ext}`;
}

function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

async function pickAPI() {
  for (const ip of API_IPS) {
    if (await tcpProbe(ip, 443)) return ip;
  }
  throw new Error('没有可达的 api.github.com 地址');
}

function curl(args) {
  return execFileSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

async function main() {
  const token = readToken();
  console.log(`token 已读取（${token.length} 字符，不打印）`);

  const ip = await pickAPI();
  console.log(`API 地址: ${ip}`);

  const resolve = `api.github.com:443:${ip}`;
  const authHeaders = [
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: politicsqa-release-script',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
  ];
  const api = `https://api.github.com/repos/${OWNER}/${REPO}`;

  console.log('\n[1/4] 校验仓库...');
  const repoRaw = curl(['-s', '--max-time', '40', '--resolve', resolve, ...authHeaders, api]);
  const repo = JSON.parse(repoRaw);
  if (!repo.full_name) throw new Error(`仓库校验失败: ${repoRaw.slice(0, 200)}`);
  console.log(`      ${repo.full_name} (default_branch=${repo.default_branch})`);

  console.log('\n[2/4] 查找或创建 Release...');
  const existingRaw = curl(['-s', '--max-time', '40', '--resolve', resolve, ...authHeaders, `${api}/releases/tags/${TAG}`]);
  let release = null;
  try {
    const parsed = JSON.parse(existingRaw);
    if (parsed.id) release = parsed;
  } catch { /* 404 body is JSON too; fall through */ }

  if (release) {
    console.log(`      已存在 id=${release.id}`);
  } else {
    const body = readFileSync(NOTES_FILE, 'utf8');
    // Build JSON in Node so the notes stay a plain string (PowerShell's
    // ConvertTo-Json wrapped them in an object and the API rejected it).
    const payload = JSON.stringify({
      tag_name: TAG,
      name: NAME,
      body,
      draft: false,
      prerelease: true,
    });
    const tmp = path.join(os.tmpdir(), `pq-release-${Date.now()}.json`);
    writeFileSync(tmp, payload, 'utf8');
    try {
      const createdRaw = curl([
        '-s', '--max-time', '60', '--resolve', resolve, ...authHeaders,
        '-H', 'Content-Type: application/json',
        '--data-binary', `@${tmp}`,
        `${api}/releases`,
      ]);
      release = JSON.parse(createdRaw);
      if (!release.id) throw new Error(`创建失败: ${createdRaw.slice(0, 300)}`);
      console.log(`      已创建 id=${release.id}`);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  const uploadBase = String(release.upload_url || '').split('{')[0];
  if (!uploadBase) throw new Error('release 缺少 upload_url');

  console.log('\n[3/4] 上传附件...');
  const existingNames = new Set((release.assets || []).map((a) => a.name));
  const files = readdirSync(ASSET_DIR)
    .filter((n) => statSync(path.join(ASSET_DIR, n)).isFile())
    .sort();
  let uploaded = 0;

  for (const name of files) {
    // GitHub's upload endpoint mangles non-ASCII asset names — a file called
    // 政问-单文件版.html lands as "-.html". Map such names to ASCII first.
    const assetName = /^[\x20-\x7e]+$/.test(name) ? name : asciiName(name);
    if (existingNames.has(assetName)) {
      console.log(`      ${assetName} 已存在，跳过`);
      continue;
    }
    const full = path.join(ASSET_DIR, name);
    const sizeMb = (statSync(full).size / 1024 / 1024).toFixed(2);
    process.stdout.write(`      ${assetName} (${sizeMb} MB) ... `);
    try {
      const res = curl([
        '-s', '--max-time', '600',
        '-H', `Authorization: Bearer ${token}`,
        '-H', 'Accept: application/vnd.github+json',
        '-H', 'User-Agent: politicsqa-release-script',
        '-H', 'Content-Type: application/octet-stream',
        '--data-binary', `@${full}`,
        `${uploadBase}?name=${encodeURIComponent(assetName)}`,
      ]);
      if (/"state"\s*:\s*"uploaded"/.test(res)) {
        console.log('OK');
        uploaded += 1;
      } else {
        console.log(`失败: ${res.slice(0, 160)}`);
      }
    } catch (error) {
      console.log(`失败: ${error.message}`);
    }
  }

  console.log('\n[4/4] 完成');
  console.log(`Release: ${release.html_url}`);
  console.log(`本次上传 ${uploaded} 个附件`);
}

main().catch((error) => {
  console.error(`\n发布失败: ${error.message}`);
  process.exitCode = 1;
});
