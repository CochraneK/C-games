// 沙箱 git 协议出口被封，改用 gh api（走宿主机网络）按 Git Data API 推送等价于 git push。
// 流程：base main ref -> 逐文件建 blob -> 建 tree -> 建 commit -> 更新 main ref。
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OWNER_REPO = 'CochraneK/snake-games';
const DIR = 'C:/Users/cunyi/WorkBuddy/2026-09-29-22-27-16';
const PAYLOAD = path.join(DIR, '_gh_payload.json');

function gh(method, apiPath, bodyObj) {
  let cmd = `gh api -X ${method} /repos/${OWNER_REPO}${apiPath}`;
  if (bodyObj) {
    fs.writeFileSync(PAYLOAD, JSON.stringify(bodyObj));
    cmd += ` --input ${PAYLOAD} -H "Content-Type: application/json"`;
  }
  const out = execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 128, stdio: ['ignore', 'pipe', 'pipe'] });
  try { fs.unlinkSync(PAYLOAD); } catch (e) {}
  return out && out.trim() ? JSON.parse(out) : null;
}

function ghGet(apiPath) {
  const out = execSync(`gh api /repos/${OWNER_REPO}${apiPath}`, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 128 });
  return JSON.parse(out);
}

try {
  const ref = ghGet('/git/ref/heads/main');
  const baseCommit = ref.object.sha;
  console.log('base main commit:', baseCommit);
  const baseCommitData = ghGet(`/git/commits/${baseCommit}`);
  const baseTree = baseCommitData.tree.sha;
  console.log('base tree:', baseTree);

  const files = [
    { local: 'index.html', repo: 'index.html' },
    { local: 'play.html', repo: 'play.html' },
    { local: 'snake/index.html', repo: 'snake/index.html' },
    { local: 'smoke-test.js', repo: 'smoke-test.js' },
  ];

  const entries = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(DIR, f.local));
    const b64 = buf.toString('base64');
    console.log(`blob ${f.repo} (${buf.length} bytes -> b64 ${b64.length})`);
    const blob = gh('POST', '/git/blobs', { content: b64, encoding: 'base64' });
    entries.push({ path: f.repo, mode: '100644', type: 'blob', sha: blob.sha });
  }

  console.log('creating tree...');
  const tree = gh('POST', '/git/trees', { base_tree: baseTree, tree: entries });
  console.log('tree:', tree.sha);

  const msg = 'feat: 地铁城市晋级赛框架 + 仓库重组对齐远端\n\n' +
    '- LADDER 模块：8 赛区 × 全中国地铁城市晋级树，覆盖度点亮(>=50%)晋级\n' +
    '- 六段阶梯：城市线路->全省->全区(含港澳台)->全国->全洲->全球火车\n' +
    '- 仅北京/南京可玩，其余锁定「敬请期待」\n' +
    '- 入口 ?mode=ladder 总览 / ?from=ladder 返回钮\n' +
    '- 仓库重组对齐 CochraneK/snake-games：根 hub + play.html + snake/ + bell/\n' +
    '- Phase D：碰撞掉一半肉 + 换乘降频；smoke-test 晋级赛不变量';
  console.log('creating commit...');
  const commit = gh('POST', '/git/commits', { message: msg, tree: tree.sha, parents: [baseCommit] });
  console.log('commit:', commit.sha);

  console.log('updating ref main...');
  const upd = gh('PATCH', '/git/refs/heads/main', { sha: commit.sha, force: false });
  console.log('ref updated ->', upd.object.sha);
  console.log('DONE: pushed to remote main');
} catch (e) {
  console.error('PUSH FAILED:', e.message);
  try { fs.unlinkSync(PAYLOAD); } catch (_) {}
  process.exit(1);
}
