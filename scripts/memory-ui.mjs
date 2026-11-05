#!/usr/bin/env node
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { openStore, stats, listItems, getPerson, exportPerson, deletePerson, forget, recallTrace, listRelations, extractRelationCandidates, upsertRelation, applyFeedback } from '../lib/core.js';

const ROOT = '/Users/wentaohu/dsh-bootstrap-20261102';
const dbPath = process.env.PERSON_MEMORY_DB || `${ROOT}/state/person-memory.sqlite`;
const tokenFile = process.env.MEMORY_UI_TOKEN_FILE || `${ROOT}/state/run/memory-ui.token`;
const port = Number(process.env.MEMORY_UI_PORT || 8092);
const host = '127.0.0.1';
mkdirSync(dirname(tokenFile), { recursive: true });
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex'), { mode: 0o600 });
const token = readFileSync(tokenFile, 'utf8').trim();

function authorized(req, url) {
  const header = String(req.headers['x-memory-token'] || '');
  if (header && header === token) return true;
  return url.searchParams.get('token') === token;
}
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

const page = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>人物记忆</title>
<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;max-width:900px;margin:40px auto;padding:0 16px;color:#222}input,button{font:inherit}button{margin:2px;padding:4px 8px}pre{background:#f6f8fa;padding:12px;overflow:auto;border-radius:8px}li{margin:4px 0}.muted{color:#888}</style>
<h1>人物记忆</h1>
<p class="muted">仅本机 127.0.0.1；需要 token。删除不可恢复。</p>
<p>Token: <input id="token" size="48" placeholder="粘贴 memory-ui.token"><button onclick="save()">保存</button></p>
<button onclick="load()">刷新</button>
<button onclick="trace()">召回 trace</button>
<button onclick="relationCandidates()">关系候选</button>
<button onclick="addRelation()">加关系</button>
<button onclick="feedback()">反馈</button>
<ul id="list"></ul><pre id="out"></pre>
<script>
const $=s=>document.querySelector(s); let token=sessionStorage.getItem('memtok')||'';
$('#token').value=token;
function save(){token=$('#token').value.trim();sessionStorage.setItem('memtok',token);load();}
async function api(path,opts={}){opts.headers={...(opts.headers||{}),'x-memory-token':token};const r=await fetch(path,opts);const t=await r.text();let v;try{v=JSON.parse(t)}catch{v=t}if(!r.ok)throw new Error(typeof v==='string'?v:v.reason||r.status);return v;}
async function load(){try{const rows=await api('/api/persons');$('#list').innerHTML=rows.map(p=>'<li><b>'+p.display_name+'</b> <span class="muted">'+p.id+' · '+p.n+' 条</span> <button onclick="show(\\''+p.id+'\\')">查看</button> <button onclick="exp(\\''+p.id+'\\')">导出</button> <button onclick="del(\\''+p.id+'\\')">删除</button> <button onclick="rels(\\''+p.id+'\\')">关系</button></li>').join('');}catch(e){$('#out').textContent=e.message}}
async function trace(){const id=prompt('person id');if(!id)return;const q=prompt('query')||'';try{const v=await api('/api/trace?id='+encodeURIComponent(id)+'&q='+encodeURIComponent(q));$('#out').textContent=JSON.stringify(v,null,2);}catch(e){$('#out').textContent=e.message}}
async function show(id){try{const v=await api('/api/person?id='+encodeURIComponent(id));$('#out').textContent=JSON.stringify(v,null,2);}catch(e){$('#out').textContent=e.message}}
async function exp(id){try{const r=await fetch('/api/export?id='+encodeURIComponent(id),{headers:{'x-memory-token':token}});if(!r.ok)throw new Error(await r.text());const b=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='person-'+id.replace(/[^a-zA-Z0-9._-]/g,'_')+'.json';a.click();URL.revokeObjectURL(a.href);}catch(e){$('#out').textContent=e.message}}
async function rels(id){try{const v=await api('/api/relations?id='+encodeURIComponent(id));$('#out').textContent=JSON.stringify(v,null,2);}catch(e){$('#out').textContent=e.message}}
async function relationCandidates(){const text=prompt('输入明确关系句，例如 A是B的朋友');if(!text)return;try{const v=await api('/api/relation-candidates?text='+encodeURIComponent(text));$('#out').textContent=JSON.stringify(v,null,2);}catch(e){$('#out').textContent=e.message}}
async function addRelation(){const from=prompt('from person id');const to=prompt('to person id');const kind=prompt('kind (friend/partner/colleague/family/roommate/classmate)');if(!from||!to||!kind)return;try{$('#out').textContent=JSON.stringify(await api('/api/relation-add',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({from,to,kind})}),null,2);}catch(e){$('#out').textContent=e.message}}
async function feedback(){const person=prompt('person id');if(!person)return;const id=prompt('item id');if(!id)return;const action=prompt('confirm|deny|irrelevant|correct');if(!action)return;const text=action==='correct'?(prompt('新文本')||''):undefined;try{$('#out').textContent=JSON.stringify(await api('/api/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({person,id:Number(id),action,text})}),null,2);}catch(e){$('#out').textContent=e.message}}
async function del(id){const c=prompt('硬删除 '+id+' 的全部记忆。输入 DELETE 确认：');if(c!=='DELETE')return;try{$('#out').textContent=JSON.stringify(await api('/api/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({person:id,confirm:'DELETE'})}),null,2);load();}catch(e){$('#out').textContent=e.message}}
if(token)load();
</script></html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${host}:${port}`);
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, page, 'text/html; charset=utf-8');
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not-found' });
    if (!authorized(req, url)) return send(res, 401, { error: 'unauthorized' });
    const db = openStore(dbPath);
    try {
      if (req.method === 'GET' && url.pathname === '/api/persons') {
        const rows = db.prepare("SELECT p.id,p.display_name,COUNT(m.id) AS n FROM persons p LEFT JOIN memory_items m ON m.person_id=p.id AND m.status='active' GROUP BY p.id ORDER BY p.id").all();
        return send(res, 200, rows);
      }
      if (req.method === 'GET' && url.pathname === '/api/person') {
        const id = url.searchParams.get('id') || '';
        return send(res, 200, { person: getPerson(db, id), items: listItems(db, id, { statuses: ['active', 'superseded', 'forgotten', 'quarantined', 'pending_review', 'rejected'] }) });
      }
      if (req.method === 'GET' && url.pathname === '/api/trace') {
        const id = url.searchParams.get('id') || '';
        const query = url.searchParams.get('q') || '';
        return send(res, 200, recallTrace(db, { personId: id, queryText: query, audience: 'private', limit: 5 }));
      }
      if (req.method === 'GET' && url.pathname === '/api/relations') {
        return send(res, 200, listRelations(db, url.searchParams.get('id') || '', {}));
      }
      if (req.method === 'GET' && url.pathname === '/api/relation-candidates') {
        return send(res, 200, extractRelationCandidates(db, url.searchParams.get('text') || ''));
      }
      if (req.method === 'POST' && url.pathname === '/api/relation-add') {
        const b = await body(req);
        return send(res, 200, upsertRelation(db, { fromPersonId: String(b.from || ''), toPersonId: String(b.to || ''), kind: String(b.kind || 'friend'), evidence: 'memory-ui' }));
      }
      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        const b = await body(req);
        return send(res, 200, applyFeedback(db, { personId: String(b.person || ''), itemId: Number(b.id), action: String(b.action || ''), text: b.text, actor: 'memory-ui' }));
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const id = url.searchParams.get('id') || '';
        const bundle = exportPerson(db, id);
        if (!bundle) return send(res, 404, { error: 'not-found' });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="person-${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.json"`, 'cache-control': 'no-store' });
        return res.end(JSON.stringify(bundle, null, 2));
      }
      if (req.method === 'POST' && url.pathname === '/api/forget') {
        const b = await body(req);
        return send(res, 200, { forgotten: forget(db, { personId: String(b.person || ''), id: Number(b.id), reason: String(b.reason || 'memory-ui'), actor: 'memory-ui' }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/delete') {
        const b = await body(req);
        if (b.confirm !== 'DELETE') return send(res, 400, { error: 'confirm required' });
        return send(res, 200, deletePerson(db, String(b.person || '')));
      }
      return send(res, 404, { error: 'not-found' });
    } finally {
      db.close();
    }
  } catch (error) {
    send(res, 500, { error: String(error?.message || error) });
  }
});
server.listen(port, host, () => {
  console.log(`memory-ui http://${host}:${port}`);
  console.log(`token file: ${tokenFile}`);
  console.log('Ctrl-C to stop');
});
