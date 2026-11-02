// Creates the GitHub Release for v1.0-Beta and uploads all assets.
//
// api.github.com is unreachable from this machine most of the time, so this
// script retries and reports clearly. It reads the token from the credential
// store (~/.git-credentials) — the token is never written into the repo and is
// never printed.
//
// Usage: node scripts/publish-release.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OWNER = 'Chuyuya-cn';
const REPO = 'Politics-Task';
const TAG = 'v1.0-Beta';
const NAME = '政问 · 政治课程学习助手 v1.0-Beta';
const ASSET_DIR = '.release-assets';
const NOTES_FILE = '.release-notes.md';

function readToken() {
  const file = path.join(os.homedir(), '.git-credentials');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/https:\/\/([^:]+):([^@]+)@github\.com/);
    if (match && match[1].toLowerCase() === OWNER.toLowerCase()) return match[2];
  }
  throw new Error(`no GitHub credential for ${OWNER} in ${file}`);
}

async function probe(url, token, attempts = 1) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'politicsqa-release-script',
        },
      });
      return response;
    } catch (error) {
      if (i === attempts) throw error;
      console.log(`  retry ${i}/${attempts} after: ${error.cause?.code || error.message}`);
      await new Promise((r) => setTimeout(r, 8000));
    }
  }
  return null;
}

async function main() {
  const token = readToken();
  console.log(`token loaded (${token.length} chars, not printed)`);

  const api = `https://api.github.com/repos/${OWNER}/${REPO}`;

  console.log('1. 检查仓库可达性...');
  const repoRes = await probe(api, token, 20);
  if (!repoRes.ok) {
    throw new Error(`repo check failed: HTTP ${repoRes.status} ${await repoRes.text()}`);
  }
  const repo = await repoRes.json();
  console.log(`   仓库: ${repo.full_name}  default_branch=${repo.default_branch}`);

  console.log('2. 查找已有 release...');
  const existingRes = await probe(`${api}/releases/tags/${TAG}`, token);
  let release = null;
  if (existingRes.status === 200) {
    release = await existingRes.json();
    console.log(`   已存在 release id=${release.id}，将复用`);
  } else {
    console.log('   新建 release...');
    const body = readFileSync(NOTES_FILE, 'utf8');
    const createRes = await probe(`${api}/releases`, token);
    const created = await fetch(`${api}/releases`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'politicsqa-release-script',
      },
      body: JSON.stringify({
        tag_name: TAG,
        name: NAME,
        body,
        draft: false,
        prerelease: true,
      }),
    });
    if (!created.ok) throw new Error(`create failed: HTTP ${created.status} ${await created.text()}`);
    release = await created.json();
    console.log(`   已创建 id=${release.id}`);
  }

  const uploadBase = (release.upload_url || '').split('{')[0];
  if (!uploadBase) throw new Error('release has no upload_url');

  const assets = readdirSync(ASSET_DIR).filter((name) => statSync(path.join(ASSET_DIR, name)).isFile());
  for (const name of assets) {
    const file = path.join(ASSET_DIR, name);
    const data = readFileSync(file);
    process.stdout.write(`3. 上传 ${name} (${(data.length / 1024 / 1024).toFixed(2)} MB)... `);
    try {
      const res = await fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/octet-stream',
          'User-Agent': 'politicsqa-release-script',
        },
        body: data,
      });
      if (res.ok) {
        console.log('OK');
      } else {
        console.log(`FAILED HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (error) {
      console.log(`FAILED: ${error.cause?.code || error.message}`);
    }
  }

  console.log(`\n完成: ${release.html_url}`);
}

main().catch((error) => {
  console.error(`\n发布失败: ${error.message}`);
  process.exitCode = 1;
});
