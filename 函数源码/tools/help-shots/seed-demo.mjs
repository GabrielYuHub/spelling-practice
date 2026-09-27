// 帮助页截图用的示例数据（虚构的孩子和记录）
import fs from 'node:fs';
const ROOT = process.argv[2];
const U = 'http://localhost:8770/api/app';
const post = b => fetch(U, { method: 'POST', body: JSON.stringify(b) }).then(r => r.json());
const A = (action, x = {}) => post({ op: 'admin', password: 'demo-pw', action, ...x });
await fetch(U + '?op=config').then(r => r.json());
const split = t => { const secs = []; let cur = null; t.split(/\r?\n/).forEach(line => { const m = line.match(/^\s*##\s*(.+?)\s*$/); if (m) { cur = { name: m[1], lines: [] }; secs.push(cur); } else if (cur) cur.lines.push(line); }); return secs.map(s => ({ name: s.name, text: s.lines.join('\n').trim() + '\n' })); };
for (const f of ['课本单词表.txt', '英孚三上单词表.txt']) for (const s of split(fs.readFileSync(ROOT + '/' + f, 'utf8'))) await A('saveList', { list: { name: s.name }, text: s.text });
await A('deleteList', { id: 'l_default' });
let r = await A('saveChildren', { children: [
  { id: 'c_default', name: '小明', pin: '1234', goal: 25, tries: 6, round: 20, daily: 30, newCap: 5, groups: null },
  { name: '小红', pin: '5678', goal: 25, tries: 6, round: 20, daily: 30, newCap: 5, groups: ['课本三上'] },
] });
const cfg = r.config;
const u1 = cfg.lists.find(l => l.name === '课本三上 Unit 1').id;
const text = await fetch(U + '?op=list&id=' + u1).then(r => r.json()).then(d => d.text);
const words = text.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(/ (?=[a-z]+\.|[一-鿿（])/)[0].trim());
// 小明：前 4 天每天学 5 个新词、按规则复习；少量答错
const DAY = 86400e3, now = Date.now();
const iso = t => new Date(t).toISOString();
const rid = (t, list, s) => iso(t).replace(/[-:]/g, '').slice(0, 15) + '_' + list + '_' + s;
const plan = [ // [几天前, 学的新词下标, 复习的下标, 答错的词]
  [4, [0, 1, 2, 3, 4], [], []],
  [3, [5, 6, 7, 8, 9], [0, 1, 2, 3, 4], [2]],
  [2, [10, 11, 12, 13, 14], [5, 6, 7, 8, 9, 2], [7, 12]],
  [1, [15, 16, 17, 18, 19], [0, 1, 3, 4, 10, 11, 13, 14, 7, 12], [17]],
];
let n = 0;
for (const [ago, fresh, review, wrong] of plan) {
  const t = now - ago * DAY;
  const evs = [];
  for (const i of review) { if (wrong.includes(i)) evs.push({ en: words[i], ok: false, at: iso(t) }); evs.push({ en: words[i], ok: true, at: iso(t + 1000) }); }
  const e1 = evs.length ? await post({ op: 'record', child: 'c_default', pin: '1234', record: { id: rid(t, 'x_review', 'rv' + String(n++).padStart(3, '0')), seq: 1, status: 'complete', start: iso(t), durationSec: 300, correct: evs.filter(e => e.ok).length, wrong: evs.filter(e => !e.ok).length, events: evs } }) : null;
  const ev2 = [];
  for (const i of fresh) { if (wrong.includes(i)) ev2.push({ en: words[i], ok: false, at: iso(t + 5000) }); ev2.push({ en: words[i], ok: true, at: iso(t + 6000) }); }
  // 让每天答对数达到目标：再练一轮单元
  const extra = Array.from({ length: 12 }, (_, k) => ({ en: words[k % 5], ok: true, at: iso(t + 9000) }));
  await post({ op: 'record', child: 'c_default', pin: '1234', record: { id: rid(t + 5000, 'x_new', 'nw' + String(n++).padStart(3, '0')), seq: 1, status: 'complete', start: iso(t + 5000), durationSec: 240, correct: ev2.filter(e => e.ok).length, wrong: ev2.filter(e => !e.ok).length, events: ev2 } });
  await post({ op: 'record', child: 'c_default', pin: '1234', record: { id: rid(t + 9000, u1, 'un' + String(n++).padStart(3, '0')), seq: 1, status: 'complete', start: iso(t + 9000), durationSec: 200, correct: 12, wrong: 0, events: extra } });
}
const st = await fetch(U + '?op=stats&child=c_default').then(r => r.json());
console.log('lists', cfg.lists.length, 'words', words.slice(0, 6), 'stats', Object.keys(st.words).length, 'days', JSON.stringify(st.days));
console.log(JSON.stringify((await fetch(U + '?op=progress').then(r => r.json()))));
