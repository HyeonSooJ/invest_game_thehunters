/* ============================================================================
 * invest_game_thehunters 모의투자 게임용 Cloudflare Worker
 *
 * 역할: index.html(참가자 브라우저)이 이 Worker의 HTTP 엔드포인트만 호출하고,
 * 진짜 GitHub Personal Access Token은 이 Worker 안(Secret 환경변수)에만 존재합니다.
 * 그래서 참가자들에게 토큰을 나눠줄 필요가 전혀 없습니다.
 *
 * ---- 배포 방법 (Cloudflare 대시보드, 무료 플랜으로 충분) ----
 * 1. https://dash.cloudflare.com 가입/로그인
 * 2. 왼쪽 메뉴 Workers & Pages → Create → "Create Worker"
 * 3. 이름은 아무거나 (예: invest-game-worker) 정하고 Deploy
 * 4. 생성된 Worker의 "Edit code" 들어가서, 이 파일(worker.js) 내용을 전부
 *    복사해서 그대로 붙여넣고 Deploy
 * 5. Worker의 Settings → Variables and Secrets 에서 아래 항목 추가:
 *      - GITHUB_TOKEN (Secret 타입으로 추가!)
 *        → github.com/settings/personal-access-tokens/new 에서 발급
 *          Repository access: invest_game_thehunters 저장소만
 *          Permissions: Contents = Read and write (나머지는 No access)
 * 6. 배포되면 https://invest-game-worker.<본인계정>.workers.dev 같은 주소가 생깁니다.
 *    이 주소를 index.html 상단의 WORKER_URL 값에 넣으세요.
 * ============================================================================ */

const OWNER = 'HyeonSooJ';
const REPO = 'invest_game_thehunters';
const BRANCH = 'main';
const DATA_PATH = 'data/mock-investment-data.json';
const LEADERBOARD_PATH = 'LEADERBOARD.md';
const ADMIN_PASSWORD = '1011';

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    };
}
function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders())
    });
}
function b64EncodeUnicode(str) {
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode('0x' + p1)));
}
function b64DecodeUnicode(str) {
    return decodeURIComponent(atob(str).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
}
function ghHeaders(env, extra) {
    return Object.assign({
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'invest-game-worker'
    }, extra || {});
}
async function ghReadFile(path, env) {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}&_=${Date.now()}`;
    const res = await fetch(url, { headers: ghHeaders(env) });
    if (res.status === 404) return { sha: null, text: null };
    if (!res.ok) throw new Error(`GitHub 읽기 실패 (${res.status})`);
    const json = await res.json();
    return { sha: json.sha, text: b64DecodeUnicode(json.content.replace(/\n/g, '')) };
}
async function ghWriteFile(path, text, sha, message, env) {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
    const body = { message, content: b64EncodeUnicode(text), branch: BRANCH };
    if (sha) body.sha = sha;
    const res = await fetch(url, { method: 'PUT', headers: ghHeaders(env, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    if (res.status === 409) { const e = new Error('CONFLICT'); e.conflict = true; throw e; }
    if (!res.ok) throw new Error(`GitHub 저장 실패 (${res.status})`);
    return res.json();
}
async function readData(env) {
    const { sha, text } = await ghReadFile(DATA_PATH, env);
    const data = JSON.parse(text || '{}');
    if (!data.groups) data.groups = [];
    if (!data.participants) data.participants = [];
    return { sha, data };
}
function buildLeaderboardMarkdown(data) {
    const byGroup = {};
    data.groups.forEach(g => { byGroup[g.name] = []; });
    data.participants.forEach(p => { (byGroup[p.group] || (byGroup[p.group] = [])).push(p); });
    const groupNames = Object.keys(byGroup).sort((a, b) => a.localeCompare(b));
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    let md = `# 모의투자 대회 리더보드\n\n_마지막 업데이트: ${now} (KST)_\n\n`;
    if (groupNames.length === 0) { md += '아직 생성된 그룹이 없습니다.\n'; return md; }
    groupNames.forEach(name => {
        const list = [...byGroup[name]].sort((a, b) => (b.profit || 0) - (a.profit || 0));
        md += `## ${name} (${list.length}명)\n\n`;
        if (list.length === 0) { md += '참가자가 없습니다.\n\n'; return; }
        md += '| 순위 | 닉네임 | 수익률 |\n|---|---|---|\n';
        list.forEach((p, i) => { md += `| ${i + 1} | ${p.nickname} | ${(p.profit || 0).toFixed(2)}% |\n`; });
        md += '\n';
    });
    return md;
}
async function syncLeaderboard(data, env) {
    for (let i = 0; i < 5; i++) {
        try {
            const { sha } = await ghReadFile(LEADERBOARD_PATH, env);
            await ghWriteFile(LEADERBOARD_PATH, buildLeaderboardMarkdown(data), sha, 'update leaderboard', env);
            return;
        } catch (e) {
            if (e.conflict) { await new Promise(r => setTimeout(r, 300 + Math.random() * 400)); continue; }
            return; // 리더보드 갱신 실패는 치명적이지 않으므로 조용히 넘어갑니다.
        }
    }
}
// 동시 편집 충돌(409) 시 최신본을 다시 읽어 재시도합니다.
async function mutate(mutator, message, env) {
    for (let i = 0; i < 5; i++) {
        const { sha, data } = await readData(env);
        mutator(data);
        try {
            await ghWriteFile(DATA_PATH, JSON.stringify(data, null, 2), sha, message, env);
            await syncLeaderboard(data, env);
            return data;
        } catch (e) {
            if (e.conflict) { await new Promise(r => setTimeout(r, 300 + Math.random() * 400)); continue; }
            throw e;
        }
    }
    throw new Error('저장 충돌이 반복되어 실패했습니다.');
}
function uid() {
    return crypto.randomUUID();
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
        const { pathname } = new URL(request.url);
        let body = {};
        if (request.method === 'POST') body = await request.json().catch(() => ({}));

        try {
            if (pathname === '/state') {
                const { data } = await readData(env);
                return jsonResponse(data);
            }
            if (pathname === '/create-group') {
                if (body.adminPassword !== ADMIN_PASSWORD) return jsonResponse({ error: 'unauthorized' }, 401);
                if (!body.name) return jsonResponse({ error: 'name required' }, 400);
                const data = await mutate(d => { d.groups.push({ id: uid(), name: body.name }); }, `create group ${body.name}`, env);
                return jsonResponse(data);
            }
            if (pathname === '/rename-group') {
                if (body.adminPassword !== ADMIN_PASSWORD) return jsonResponse({ error: 'unauthorized' }, 401);
                if (!body.id || !body.name) return jsonResponse({ error: 'id/name required' }, 400);
                const data = await mutate(d => { const g = d.groups.find(x => x.id === body.id); if (g) g.name = body.name; }, `rename group ${body.id}`, env);
                return jsonResponse(data);
            }
            if (pathname === '/add-participant') {
                if (!body.nickname || !body.group) return jsonResponse({ error: 'nickname/group required' }, 400);
                const { data: current } = await readData(env);
                const exists = current.participants.some(p => p.group === body.group && p.nickname === body.nickname);
                if (exists) return jsonResponse({ error: 'duplicate' }, 409);
                const id = uid();
                await mutate(d => { d.participants.push({ id, nickname: body.nickname, group: body.group, profit: 0 }); }, `add participant ${body.nickname}`, env);
                return jsonResponse({ id });
            }
            if (pathname === '/remove-participant') {
                if (!body.id) return jsonResponse({ error: 'id required' }, 400);
                const data = await mutate(d => { d.participants = d.participants.filter(p => p.id !== body.id); }, `remove participant ${body.id}`, env);
                return jsonResponse(data);
            }
            if (pathname === '/update-profit') {
                if (!body.id) return jsonResponse({ error: 'id required' }, 400);
                const data = await mutate(d => { const p = d.participants.find(x => x.id === body.id); if (p) p.profit = body.profit; }, `update profit ${body.id}`, env);
                return jsonResponse(data);
            }
            if (pathname === '/reset') {
                if (body.adminPassword !== ADMIN_PASSWORD) return jsonResponse({ error: 'unauthorized' }, 401);
                const data = await mutate(d => { d.participants = []; }, 'reset participants', env);
                return jsonResponse(data);
            }
            return jsonResponse({ error: 'not found' }, 404);
        } catch (e) {
            return jsonResponse({ error: e.message || 'internal error' }, 500);
        }
    }
};
