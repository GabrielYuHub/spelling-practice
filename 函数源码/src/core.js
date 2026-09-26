// 单词拼写练习 · 业务逻辑（与部署平台无关）
//
// 接口：/api/app
//   GET  ?op=config              孩子名单（不含 PIN）和单词表目录
//   GET  ?op=list&id=<表id>      单词表内容
//   GET  ?op=stats&child=<id>    孩子的熟练度与复习计划（出题加权、错词本、今日复习用）
//   GET  ?op=alltext             全部单词表的内容（错词本、今日复习从所有单词表取词）
//   POST { op:'pin', child, pin }            验证孩子 PIN
//   POST { op:'record', child, pin, record } 提交答题记录并更新熟练度
//   POST { op:'admin', password, action, ... } 管理操作（见 admin()）
//
// 平台适配层（cloudbase.js）提供：
//   store：get(key, {type}) / set(key, text, {onlyIfNew}) / setJSON / delete(key) / list({prefix})
//          可选：update(key, mutate) 条件更新（乐观锁，多设备同时写入不丢数据）；deletePrefix(prefix) 按目录一次删除；listValues(prefix, offset, limit, fromKey) 按键排序、连内容一起分页读取（fromKey：只读键 ≥ 它的）
//          onlyIfNew 写入时 key 已存在要抛出 code 为 'PRECONDITION_FAILED' 的错误
//   loadDefaultWords()：返回默认单词表文本（words.js 的内容），用于首次初始化
//   password：管理密码
import '../../网站发布/wordlib.js';

const WordLib = globalThis.WordLib;

const CONFIG_KEY = 'config.json';
const LEGACY_KEY = 'wordlists/default.txt'; // 旧版“在线编辑词库”的数据
const DEFAULT_LIST_ID = 'l_default';
const MAX_TEXT = 200000;
// 虚拟单词表：由练习页从所有单词表中挑词组成，只用于答题记录
const VIRTUAL_LISTS = { x_review: '今日复习', x_wrong: '错词本' };

const LOCKS_KEY = 'locks.json';   // 口令连续输错的次数与锁定时间
const AUTH_KEY = 'auth.json';     // 在管理页修改过的密码（加盐哈希）；删除这条数据即恢复为代码里的原始密码
const MAX_FAILS = 5;
const PIN_LOCK_MIN = 10;
const ADMIN_LOCK_MIN = 15;

const listKey = id => `wordlists/${id}.txt`;
const statsKey = child => `stats/${child}.json`;
const recordPrefix = child => `records/${child}/`;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function bad(message, status = 400) { throw new HttpError(status, message); }

const readJSON = (s, key) => s.get(key, { type: 'json' });

// 读出 → 修改 → 写回，且不会被同时进行的其他写入覆盖（T3）
// fn(当前对象或 null) 返回新对象，返回 null 表示不修改；冲突时 fn 会基于最新数据再调用一次，所以 fn 只能依赖传入的对象
async function updateJSON(s, key, fn) {
  const wrap = cur => { const next = fn(cur == null ? null : JSON.parse(cur)); return next == null ? null : JSON.stringify(next); };
  if (s.update) return s.update(key, wrap);
  const next = wrap(await s.get(key)); // 存储层不支持条件写入时，退回普通读写
  if (next != null) await s.set(key, next);
  return next != null;
}

const ID_RE = /^[a-z0-9_]{1,40}$/;
function checkId(id, what = '编号') {
  if (typeof id !== 'string' || !ID_RE.test(id)) bad(what + '格式错误');
  return id;
}
function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
const int = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

// ---------- 配置 ----------
// 第一次使用时自动初始化：一个默认孩子 + 一个默认单词表（迁移旧版在线词库，没有就用网站自带的 words.js）
async function loadConfig(s, env) {
  const cfg = await readJSON(s, CONFIG_KEY);
  if (cfg) return cfg;

  let text = await s.get(LEGACY_KEY);
  const name = text ? '动物' : '三上 Unit 1'; // 旧版在线词库是动物；没有旧数据时用 words.js（Unit 1）
  if (!text) text = await env.loadDefaultWords();
  const init = {
    children: [{ id: 'c_default', name: '小朋友', pin: '0000' }],
    lists: [{ id: DEFAULT_LIST_ID, name, roundSize: 20, count: text ? WordLib.parse(text).length : 0 }],
  };
  if (text) await s.set(listKey(DEFAULT_LIST_ID), text);
  try {
    await s.setJSON(CONFIG_KEY, init, { onlyIfNew: true });
  } catch (e) {
    if (e && e.code === 'PRECONDITION_FAILED') return readJSON(s, CONFIG_KEY); // 同时有别的请求完成了初始化
    throw e;
  }
  return init;
}

// 单词表分组：没有单独设置过时，取名称里第一个空格前的部分（“三上 Unit 1” → “三上”），没有空格则为空（练习页显示为“其他”）
const cleanGroup = g => String(g || '').trim().slice(0, 12);
const listGroup = l => (typeof l.group === 'string' ? l.group : (l.name.includes(' ') ? l.name.split(' ')[0] : ''));
// 单词表的分组键：“其他”和空都表示没有分组
const listKeyGroup = l => { const g = listGroup(l); return g === '其他' ? '' : g; };
const normGroup = g => { g = cleanGroup(g); return g === '其他' ? '' : g; };
// 分组顺序：按第一次出现的顺序，“其他”排在最后；reorder 把同组的单词表排在一起
function groupOrder(cfg) {
  const gs = [];
  cfg.lists.forEach(l => { const g = listKeyGroup(l); if (!gs.includes(g)) gs.push(g); });
  return gs.filter(g => g).concat(gs.includes('') ? [''] : []);
}
const reorder = (cfg, order) => { cfg.lists = order.flatMap(g => cfg.lists.filter(l => listKeyGroup(l) === g)); };
// 孩子可以练习的单词表组：null = 全部；数组 = 组名（没有分组的单词表算“其他”）
const cleanGroups = gs => (Array.isArray(gs) ? [...new Set(gs.map(g => cleanGroup(g) || '其他'))].slice(0, 50) : null);

const DEFAULT_GOAL = 20;
const DEFAULT_TRIES = 6; // 同一道题最多答错几次后显示正确答案
const DEFAULT_ROUND = 20; // 每轮题数（每个孩子一个设置，所有单词表通用）
const DAYS_KEEP = 400; // 每日答对数保留的天数

function publicConfig(cfg) {
  return {
    children: cfg.children.map(({ id, name, goal, tries, round, groups }) => ({ id, name, goal: goal || DEFAULT_GOAL, tries: tries || DEFAULT_TRIES, round: round || DEFAULT_ROUND, groups: cleanGroups(groups) })),
    lists: cfg.lists.map(l => ({ id: l.id, name: l.name, roundSize: l.roundSize, count: l.count, group: listGroup(l) })),
  };
}

// ---------- 口令校验与连续输错锁定 ----------
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async text => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

// slot：锁定记录的名字（pin_<孩子id> 或 admin）；isRight：判断口令是否正确
async function checkSecret(s, slot, isRight, lockMin, wrongMsg) {
  const now = Date.now();
  const cur0 = ((await readJSON(s, LOCKS_KEY)) || {})[slot];
  if (cur0 && cur0.until > now) bad('输错次数太多，已锁定，请 ' + Math.ceil((cur0.until - now) / 60000) + ' 分钟后再试', 429);
  if (await isRight()) {
    if (cur0) await clearLocks(s, [slot]);
    return;
  }
  // 错误次数用条件更新累加，同时从多台设备尝试也不会少算
  let msg = '', status = 401;
  await updateJSON(s, LOCKS_KEY, locks => {
    locks = locks || {};
    const cur = Object.assign({ fails: 0, until: 0 }, locks[slot]);
    if (cur.until > now) { // 别的请求刚刚已经触发了锁定
      msg = '输错次数太多，已锁定，请 ' + Math.ceil((cur.until - now) / 60000) + ' 分钟后再试'; status = 429;
      return null;
    }
    cur.fails = (cur.until ? 0 : cur.fails) + 1; // 锁定到期后重新计数
    cur.until = 0;
    if (cur.fails >= MAX_FAILS) {
      cur.until = now + lockMin * 60000; cur.fails = 0;
      msg = '连续输错 ' + MAX_FAILS + ' 次，已锁定 ' + lockMin + ' 分钟'; status = 429;
    } else {
      msg = wrongMsg + '（还可以再试 ' + (MAX_FAILS - cur.fails) + ' 次）'; status = 401;
    }
    locks[slot] = cur;
    return locks;
  });
  bad(msg, status);
}

async function clearLocks(s, slots) {
  if (!slots.length) return;
  await updateJSON(s, LOCKS_KEY, locks => {
    if (!locks || !slots.some(k => locks[k])) return null;
    slots.forEach(k => delete locks[k]);
    return locks;
  });
}

async function verifyChild(s, cfg, id, pin) {
  const child = cfg.children.find(c => c.id === id);
  if (!child) bad('找不到这个孩子，请重新选择', 404);
  await checkSecret(s, 'pin_' + child.id, async () => String(pin) === child.pin, PIN_LOCK_MIN, 'PIN 不对');
  return child;
}

async function verifyAdmin(s, env, password) {
  const auth = await readJSON(s, AUTH_KEY);
  const isRight = async () => (auth && auth.hash
    ? (await sha256(auth.salt + String(password))) === auth.hash
    : String(password) === env.password);
  await checkSecret(s, 'admin', isRight, ADMIN_LOCK_MIN, '密码错误');
}

// ---------- 答题记录 ----------
// 记录编号：<开始时间 YYYYMMDDTHHMMSS>_<单词表id>_<随机串>，同一轮多次提交用同一编号，seq 递增
const RECORD_ID_RE = /^(\d{8}T\d{6})_([a-z0-9_]+)_([a-z0-9]{4,10})$/;

async function saveRecord(s, cfg, body) {
  const child = await verifyChild(s, cfg, body.child, body.pin);
  const r = body.record;
  if (!r || typeof r !== 'object') bad('记录格式错误');
  if (JSON.stringify(r).length > 60000) bad('记录太大');
  const m = RECORD_ID_RE.exec(r.id || '');
  if (!m) bad('记录编号错误');
  const list = cfg.lists.find(l => l.id === m[2]) || (VIRTUAL_LISTS[m[2]] && { id: m[2], name: VIRTUAL_LISTS[m[2]] });
  if (!list) bad('单词表不存在', 404);
  const seq = Number(r.seq);
  if (!Number.isInteger(seq) || seq < 1) bad('记录序号错误');
  const events = Array.isArray(r.events) ? r.events.slice(0, 2000) : [];

  const key = recordPrefix(child.id) + r.id + '.json';
  const prev = await readJSON(s, key);
  if (prev && prev.seq >= seq) return { ok: true, duplicate: true }; // 重复提交，忽略

  const now = new Date().toISOString();
  if (events.length) {
    await readStats(s, child.id); // 确保每日答对数已建立（需要时补算历史）
    await updateJSON(s, statsKey(child.id), st => {
      st = st || { words: {}, days: {}, daysInit: true };
      for (const ev of events) {
        const en = typeof ev.en === 'string' ? ev.en.slice(0, 80) : '';
        if (!en) continue;
        const w = st.words[en] || (st.words[en] = { score: 0, wrong: 0, right: 0, lastWrong: null });
        const at = typeof ev.at === 'string' && !isNaN(Date.parse(ev.at)) ? ev.at.slice(0, 40) : now;
        WordLib.applyAnswer(w, !!ev.ok, at, !!ev.ns); // 熟练度 + 间隔复习，规则见 wordlib.js；ns：本题第 3 次及以后的答错，不再加分
        if (ev.ok) addDayCount(st, WordLib.bjDate(at), 1);
      }
      st.updated = now;
      return st;
    });
  }

  const wrongWords = {};
  if (r.wrongWords && typeof r.wrongWords === 'object') {
    for (const [en, n] of Object.entries(r.wrongWords).slice(0, 500)) wrongWords[String(en).slice(0, 80)] = int(n, 0, 999, 0);
  }
  await s.setJSON(key, {
    id: r.id,
    seq,
    child: child.id,
    childName: child.name,
    list: list.id,
    listName: list.name,
    start: typeof r.start === 'string' ? r.start.slice(0, 40) : now,
    durationSec: int(r.durationSec, 0, 86400, 0),
    planned: int(r.planned, 0, 10000, 0),
    correct: int(r.correct, 0, 10000, 0),
    wrong: int(r.wrong, 0, 10000, 0),
    wrongWords,
    skipped: Array.isArray(r.skipped) ? r.skipped.slice(0, 500).map(x => String(x).slice(0, 80)) : [],
    status: r.status === 'complete' ? 'complete' : 'incomplete',
    savedAt: now,
  });
  return { ok: true };
}

async function listRecordNames(s, childId) {
  const prefix = recordPrefix(childId);
  const { blobs } = await s.list({ prefix });
  return blobs
    .map(b => b.key.startsWith(prefix) ? b.key.slice(prefix.length) : b.key)
    .filter(k => k.endsWith('.json'))
    .map(k => k.slice(0, -5));
}

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

async function clearChild(s, childId) {
  let deleted;
  if (s.deletePrefix) {
    deleted = await s.deletePrefix(recordPrefix(childId)); // 数据库可按条件一次删除
  } else {
    const names = await listRecordNames(s, childId);
    await inBatches(names, 10, n => s.delete(recordPrefix(childId) + n + '.json'));
    deleted = names.length;
  }
  await s.delete(statsKey(childId));
  return deleted;
}

// 按键排序分页读取某个孩子的答题记录；fromName：只读编号 ≥ 它的（编号以开始时间开头，相当于按时间筛选）
async function readRecords(s, childId, offset, limit, fromName) {
  const prefix = recordPrefix(childId);
  if (s.listValues) {
    const rows = await s.listValues(prefix, offset, limit, fromName ? prefix + fromName : undefined);
    return rows.map(r => { try { return JSON.parse(r.value); } catch (e) { return null; } }).filter(Boolean);
  }
  const names = (await listRecordNames(s, childId)).filter(n => !fromName || n >= fromName).sort().slice(offset, offset + limit);
  return (await inBatches(names, 10, n => readJSON(s, prefix + n + '.json'))).filter(Boolean);
}

// ---------- 每日打卡 ----------
function addDayCount(st, day, n) {
  st.days = st.days || {};
  st.days[day] = (st.days[day] || 0) + n;
  const keys = Object.keys(st.days);
  if (keys.length > DAYS_KEEP) keys.sort().slice(0, keys.length - DAYS_KEEP).forEach(k => delete st.days[k]);
}

// 读取熟练度；如果还没有每日答对数（功能上线前的数据），根据全部答题记录补算一次
async function readStats(s, childId) {
  const st = (await readJSON(s, statsKey(childId))) || { words: {} };
  if (st.daysInit) return st;
  const tmp = {};
  for (let offset = 0; ; offset += 500) {
    const page = await readRecords(s, childId, offset, 500);
    page.forEach(r => { if (r.correct) addDayCount(tmp, WordLib.bjDate(r.start), r.correct); });
    if (page.length < 500) break;
  }
  let result = null;
  await updateJSON(s, statsKey(childId), cur => {
    cur = cur || { words: {} };
    if (cur.daysInit) { result = cur; return null; } // 别的请求已经补算过
    cur.days = Object.assign({}, tmp.days);
    cur.daysInit = true;
    result = cur;
    return cur;
  });
  return result;
}

// 合并熟练度：逐个单词保留答题次数（答对+答错）更多的一份，重复导入同一份备份不会叠加
const answered = w => (Number(w && w.right) || 0) + (Number(w && w.wrong) || 0);
function cleanStat(w) {
  const out = { score: int(w.score, 0, 100000, 0), wrong: int(w.wrong, 0, 100000, 0), right: int(w.right, 0, 100000, 0),
    lastWrong: typeof w.lastWrong === 'string' ? w.lastWrong.slice(0, 40) : null };
  if (w.lvl) { out.lvl = int(w.lvl, 1, 6, 1); out.due = /^\d{4}-\d{2}-\d{2}$/.test(w.due) ? w.due : null; }
  if (w.mastered) out.mastered = true;
  return out;
}

// ---------- 管理 ----------
async function admin(s, env, body) {
  const action = body.action;
  if (action === 'verify') return { ok: true };

  const cfg = await loadConfig(s, env);
  if (action === 'config') {
    // 附带各孩子 PIN 的锁定到期时间，管理页用来显示“锁定中”
    const locks = (await readJSON(s, LOCKS_KEY)) || {};
    const now = Date.now();
    const pinLocks = {};
    cfg.children.forEach(c => { const l = locks['pin_' + c.id]; if (l && l.until > now) pinLocks[c.id] = l.until; });
    return Object.assign({}, cfg, { pinLocks, lists: cfg.lists.map(l => Object.assign({}, l, { group: listGroup(l) })) });
  }

  if (action === 'changePassword') {
    const pw = String(body.newPassword || '');
    if (pw.length < 4 || pw.length > 64) bad('新密码需要 4–64 个字符');
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    await s.setJSON(AUTH_KEY, { salt, hash: await sha256(salt + pw), updated: new Date().toISOString() });
    return { ok: true };
  }

  if (action === 'saveList') {
    const input = body.list || {};
    const name = String(input.name || '').trim().slice(0, 30);
    if (!name) bad('请填写单词表名称');
    const roundSize = int(input.roundSize, 1, 500, 20);
    const text = body.text;
    if (typeof text !== 'string' || !text.trim()) bad('单词表不能为空');
    if (text.length > MAX_TEXT) bad('单词表太大了');
    const count = WordLib.parse(text).length;
    if (!count) bad('单词表里没有可用的单词');

    let list = null;
    if (input.id) {
      list = cfg.lists.find(l => l.id === input.id);
      if (!list) bad('单词表不存在', 404);
    }
    if (cfg.lists.some(l => l !== list && l.name === name)) bad('已经有同名的单词表了');
    if (!list) {
      list = { id: newId('l') };
      cfg.lists.push(list);
    }
    Object.assign(list, { name, roundSize, count });
    list.group = input.group !== undefined ? normGroup(input.group) : listGroup(list);
    await s.set(listKey(list.id), text);
    await s.setJSON(CONFIG_KEY, cfg);
    return { ok: true, id: list.id, config: cfg };
  }

  if (action === 'deleteList') {
    const id = checkId(body.id);
    if (!cfg.lists.some(l => l.id === id)) bad('单词表不存在', 404);
    if (cfg.lists.length <= 1) bad('至少要保留一个单词表');
    cfg.lists = cfg.lists.filter(l => l.id !== id);
    await s.setJSON(CONFIG_KEY, cfg);
    await s.delete(listKey(id));
    return { ok: true, config: cfg };
  }

  // 在同一分组里上移 / 下移
  if (action === 'moveList') {
    const i = cfg.lists.findIndex(l => l.id === body.id);
    if (i < 0) bad('单词表不存在', 404);
    const g = listKeyGroup(cfg.lists[i]);
    const step = body.dir === 'up' ? -1 : 1;
    let j = i + step;
    while (j >= 0 && j < cfg.lists.length && listKeyGroup(cfg.lists[j]) !== g) j += step;
    if (j >= 0 && j < cfg.lists.length) {
      [cfg.lists[i], cfg.lists[j]] = [cfg.lists[j], cfg.lists[i]];
      reorder(cfg, groupOrder(cfg));
      await s.setJSON(CONFIG_KEY, cfg);
    }
    return { ok: true, config: cfg };
  }

  // ----- 按分组管理（group 为分组名，“其他”表示没有分组）-----
  if (action === 'moveGroup') {
    const g = normGroup(body.group);
    const order = groupOrder(cfg);
    const i = order.indexOf(g);
    if (i < 0) bad('分组不存在', 404);
    const j = i + (body.dir === 'up' ? -1 : 1);
    if (g && j >= 0 && j < order.length && order[j]) { // “其他”固定在最后
      [order[i], order[j]] = [order[j], order[i]];
      reorder(cfg, order);
      await s.setJSON(CONFIG_KEY, cfg);
    }
    return { ok: true, config: cfg };
  }

  // 改分组名：组里所有单词表改到新分组；名称以旧组名开头的一起改；孩子的分组分配跟着改
  if (action === 'renameGroup') {
    const from = normGroup(body.from), to = normGroup(body.to);
    const lists = cfg.lists.filter(l => listKeyGroup(l) === from);
    if (!lists.length) bad('分组不存在', 404);
    if (from === to) return { ok: true, config: cfg };
    const names = new Map();
    lists.forEach(l => {
      let name = l.name;
      if (from && name.startsWith(from + ' ')) name = (to ? to + ' ' : '') + name.slice(from.length + 1);
      if (name.length > 30) bad('改名后“' + name + '”超过 30 个字');
      names.set(l, name);
    });
    const all = cfg.lists.map(l => (names.has(l) ? names.get(l) : l.name));
    const dup = all.find((n, k) => all.indexOf(n) !== k);
    if (dup) bad('改名后会出现同名的单词表：' + dup);
    const order = groupOrder(cfg).map(g => (g === from ? to : g));
    lists.forEach(l => { l.name = names.get(l); l.group = to; });
    const fk = from || '其他', tk = to || '其他';
    cfg.children.forEach(c => { if (Array.isArray(c.groups)) c.groups = cleanGroups(c.groups.map(x => (x === fk ? tk : x))); });
    reorder(cfg, [...new Set(order)].filter(g => g).concat(order.includes('') ? [''] : []));
    await s.setJSON(CONFIG_KEY, cfg);
    return { ok: true, config: cfg };
  }

  // 删除整组：删除组里所有单词表（学习记录保留），孩子的分组分配里去掉这个分组
  if (action === 'deleteGroup') {
    const g = normGroup(body.group);
    const del = cfg.lists.filter(l => listKeyGroup(l) === g);
    if (!del.length) bad('分组不存在', 404);
    if (del.length >= cfg.lists.length) bad('至少要保留一个单词表，不能删除唯一的分组');
    cfg.lists = cfg.lists.filter(l => !del.includes(l));
    const gk = g || '其他';
    cfg.children.forEach(c => { if (Array.isArray(c.groups)) c.groups = c.groups.filter(x => x !== gk); });
    await s.setJSON(CONFIG_KEY, cfg);
    await inBatches(del, 10, l => s.delete(listKey(l.id)));
    return { ok: true, deleted: del.length, config: cfg };
  }

  if (action === 'saveChildren') {
    const input = Array.isArray(body.children) ? body.children : [];
    if (!input.length) bad('至少要有一个孩子');
    if (input.length > 20) bad('孩子太多了');
    const names = new Set();
    const children = input.map(c => {
      const name = String(c.name || '').trim().slice(0, 12);
      if (!name) bad('孩子的名字不能为空');
      if (names.has(name)) bad('名字重复了：' + name);
      names.add(name);
      const pin = String(c.pin || '');
      if (!/^\d{4}$/.test(pin)) bad(name + ' 的 PIN 必须是 4 位数字');
      const id = c.id && cfg.children.some(o => o.id === c.id) ? c.id : newId('c');
      const old = cfg.children.find(o => o.id === id);
      return { id, name, pin, goal: int(c.goal, 1, 500, (old && old.goal) || DEFAULT_GOAL), tries: int(c.tries, 1, 10, (old && old.tries) || DEFAULT_TRIES), round: int(c.round, 1, 100, (old && old.round) || DEFAULT_ROUND), groups: cleanGroups(c.groups) };
    });
    const removed = cfg.children.filter(o => !children.some(c => c.id === o.id));
    // 修改了 PIN 或被删除的孩子，解除锁定
    const unlock = children.filter(c => { const o = cfg.children.find(x => x.id === c.id); return o && o.pin !== c.pin; })
      .concat(removed).map(c => 'pin_' + c.id);
    cfg.children = children;
    await s.setJSON(CONFIG_KEY, cfg);
    await clearLocks(s, unlock);
    for (const c of removed) await clearChild(s, c.id);
    return { ok: true, config: cfg };
  }

  if (action === 'records') {
    const childId = checkId(body.child, '孩子编号');
    const listId = body.list ? checkId(body.list, '单词表编号') : '';
    const limit = int(body.limit, 1, 100, 30);
    let names = await listRecordNames(s, childId);
    if (listId) names = names.filter(n => { const m = RECORD_ID_RE.exec(n); return m && m[2] === listId; });
    names.sort().reverse();
    if (body.before) names = names.filter(n => n < body.before);
    const page = names.slice(0, limit);
    const records = (await inBatches(page, 10, n => readJSON(s, recordPrefix(childId) + n + '.json'))).filter(Boolean);
    return { records, next: names.length > limit ? page[page.length - 1] : null };
  }

  if (action === 'stats') {
    const childId = checkId(body.child, '孩子编号');
    if (!cfg.children.some(c => c.id === childId)) return { words: {} };
    return readStats(s, childId);
  }

  // ----- 导出（分两步，适应免费版 3 秒上限）-----
  if (action === 'exportBase') {
    const wordlists = {};
    const texts = await inBatches(cfg.lists, 10, l => s.get(listKey(l.id)));
    cfg.lists.forEach((l, i) => { wordlists[l.id] = texts[i] || ''; });
    const stats = {};
    const sts = await inBatches(cfg.children, 10, c => readJSON(s, statsKey(c.id)));
    cfg.children.forEach((c, i) => { if (sts[i]) stats[c.id] = sts[i]; });
    return { config: cfg, wordlists, stats };
  }

  if (action === 'exportRecords') {
    const childId = checkId(body.child, '孩子编号');
    const offset = int(body.offset, 0, 1e7, 0);
    const limit = int(body.limit, 1, 500, 300);
    const records = await readRecords(s, childId, offset, limit);
    return { records, done: records.length < limit };
  }

  // ----- 合并导入（第 1 步：单词表和孩子；按名字对应，同名更新、没有就新增）-----
  // 客户端把备份里的全部单词表和孩子都发过来：apply=true 的会写入；apply=false 的只按名字找对应关系
  if (action === 'importConfig') {
    const listMap = {}, childMap = {}, unlockSlots = [];
    const sum = { listsAdded: 0, listsUpdated: 0, childrenAdded: 0, childrenUpdated: 0, skipped: [] };
    const writes = [];
    for (const l of Array.isArray(body.lists) ? body.lists.slice(0, 200) : []) {
      const name = String(l.name || '').trim().slice(0, 30);
      if (!name) continue;
      let t = cfg.lists.find(x => x.name === name);
      if (l.apply) {
        const text = typeof l.text === 'string' ? l.text : '';
        const count = text.length <= MAX_TEXT ? WordLib.parse(text).length : 0;
        if (!count) { sum.skipped.push('单词表“' + name + '”没有可用的单词'); if (t) listMap[l.id] = t.id; continue; }
        if (!t) {
          const id = typeof l.id === 'string' && ID_RE.test(l.id) && !cfg.lists.some(x => x.id === l.id) ? l.id : newId('l');
          t = { id };
          cfg.lists.push(t);
          sum.listsAdded++;
        } else sum.listsUpdated++;
        Object.assign(t, { name, roundSize: int(l.roundSize, 1, 500, t.roundSize || 20), count });
        t.group = l.group !== undefined ? normGroup(l.group) : listGroup(t);
        writes.push([listKey(t.id), text]);
      }
      if (t) listMap[l.id] = t.id;
    }
    for (const c of Array.isArray(body.children) ? body.children.slice(0, 100) : []) {
      const name = String(c.name || '').trim().slice(0, 12);
      if (!name) continue;
      let t = cfg.children.find(x => x.name === name);
      if (c.apply) {
        const pin = String(c.pin || '');
        if (!/^\d{4}$/.test(pin)) { sum.skipped.push(name + ' 的 PIN 格式不对'); if (t) childMap[c.id] = t.id; continue; }
        if (!t) {
          if (cfg.children.length >= 20) { sum.skipped.push(name + '：孩子已达 20 个上限'); continue; }
          const id = typeof c.id === 'string' && ID_RE.test(c.id) && !cfg.children.some(x => x.id === c.id) ? c.id : newId('c');
          t = { id, name, pin, goal: int(c.goal, 1, 500, DEFAULT_GOAL), tries: int(c.tries, 1, 10, DEFAULT_TRIES), round: int(c.round, 1, 100, DEFAULT_ROUND), groups: cleanGroups(c.groups) };
          cfg.children.push(t);
          sum.childrenAdded++;
        } else {
          if (t.pin !== pin) unlockSlots.push('pin_' + t.id);
          t.pin = pin;
          if (c.goal !== undefined) t.goal = int(c.goal, 1, 500, t.goal || DEFAULT_GOAL);
          if (c.tries !== undefined) t.tries = int(c.tries, 1, 10, t.tries || DEFAULT_TRIES);
          if (c.round !== undefined) t.round = int(c.round, 1, 100, t.round || DEFAULT_ROUND);
          if (c.groups !== undefined) t.groups = cleanGroups(c.groups);
          sum.childrenUpdated++;
        }
      }
      if (t) childMap[c.id] = t.id;
    }
    await inBatches(writes, 10, ([k, v]) => s.set(k, v));
    await s.setJSON(CONFIG_KEY, cfg);
    await clearLocks(s, unlockSlots);
    return { ok: true, listMap, childMap, summary: sum, config: cfg };
  }

  // ----- 合并导入（第 2 步：答题记录，分批；按记录编号去重）-----
  if (action === 'importRecords') {
    const childId = checkId(body.child, '孩子编号');
    const child = cfg.children.find(c => c.id === childId);
    if (!child) bad('找不到这个孩子', 404);
    const existing = new Set(await listRecordNames(s, childId));
    const todo = [];
    let skipped = 0;
    for (const r of Array.isArray(body.records) ? body.records.slice(0, 200) : []) {
      if (!r || typeof r !== 'object' || !RECORD_ID_RE.test(r.id || '') || JSON.stringify(r).length > 60000) { skipped++; continue; }
      if (existing.has(r.id)) { skipped++; continue; }
      existing.add(r.id);
      todo.push(Object.assign({}, r, { child: childId, childName: child.name, list: RECORD_ID_RE.exec(r.id)[2] }));
    }
    await inBatches(todo, 10, r => s.setJSON(recordPrefix(childId) + r.id + '.json', r));
    // 每日答对数已经建立时，把新导入记录的答对数也算进去（还没建立的，以后首次读取时会根据全部记录补算）
    if (todo.length) {
      await updateJSON(s, statsKey(childId), st => {
        if (!st || !st.daysInit) return null;
        todo.forEach(r => { if (r.correct) addDayCount(st, WordLib.bjDate(r.start), int(r.correct, 0, 10000, 0)); });
        return st;
      });
    }
    return { ok: true, added: todo.length, skipped };
  }

  // ----- 合并导入（第 3 步：熟练度）-----
  if (action === 'importStats') {
    const childId = checkId(body.child, '孩子编号');
    if (!cfg.children.some(c => c.id === childId)) bad('找不到这个孩子', 404);
    const incoming = body.words && typeof body.words === 'object' ? body.words : {};
    let changed = 0;
    await updateJSON(s, statsKey(childId), st => {
      st = st || { words: {} };
      changed = 0;
      for (const [en, w] of Object.entries(incoming).slice(0, 20000)) {
        if (!w || typeof w !== 'object' || !en || en.length > 80) continue;
        if (!st.words[en] || answered(w) > answered(st.words[en])) { st.words[en] = cleanStat(w); changed++; }
      }
      if (!changed) return null;
      st.updated = new Date().toISOString();
      return st;
    });
    return { ok: true, changed };
  }

  // ----- 学习报表：最近 7 天或 30 天（北京时间）-----
  if (action === 'report') {
    const childId = checkId(body.child, '孩子编号');
    const days = Number(body.days) === 30 ? 30 : 7;
    const today = WordLib.bjDate();
    const startDay = WordLib.addDays(today, -(days - 1));
    // 北京时间 startDay 0 点对应的 UTC 时间，编码成记录编号开头的格式
    const fromName = new Date(Date.parse(startDay + 'T00:00:00+08:00')).toISOString().replace(/[-:]/g, '').slice(0, 15);
    const records = [];
    for (let offset = 0; ; offset += 500) {
      const page = await readRecords(s, childId, offset, 500, fromName);
      records.push(...page);
      if (page.length < 500) break;
    }
    const byDay = {};
    for (let d = startDay; d <= today; d = WordLib.addDays(d, 1)) byDay[d] = { date: d, rounds: 0, sec: 0, answered: 0, correct: 0 };
    const byList = {};
    const totals = { rounds: 0, sec: 0, answered: 0, correct: 0 };
    for (const r of records) {
      const day = byDay[WordLib.bjDate(r.start)];
      if (!day) continue;
      const answered = (r.correct || 0) + (r.wrong || 0);
      for (const t of [day, totals]) { t.rounds++; t.sec += r.durationSec || 0; t.answered += answered; t.correct += r.correct || 0; }
      const cur = cfg.lists.find(l => l.id === r.list);
      const l = byList[r.list] || (byList[r.list] = { id: r.list, name: cur ? cur.name : (VIRTUAL_LISTS[r.list] || r.listName || r.list), answered: 0, correct: 0 });
      l.answered += answered; l.correct += r.correct || 0;
    }
    // 复习概况：只统计现有单词表里的单词（与练习页的计算一致）
    const texts = await inBatches(cfg.lists, 10, l => s.get(listKey(l.id)));
    const pool = new Set();
    texts.forEach(t => WordLib.parse(t || '').forEach(w => pool.add(w.en)));
    const stAll = await readStats(s, childId);
    const st = stAll.words;
    const child = cfg.children.find(c => c.id === childId);
    const goal = (child && child.goal) || DEFAULT_GOAL;
    let checkinDays = 0;
    for (let d = startDay; d <= today; d = WordLib.addDays(d, 1)) if ((stAll.days[d] || 0) >= goal) checkinDays++;
    const summary = WordLib.checkin(stAll.days, goal, today);
    const review = { mastered: 0, learning: 0, due: 0 };
    for (const en of pool) {
      const w = st[en];
      if (!w) continue;
      if (w.mastered) review.mastered++;
      else if (w.lvl) { review.learning++; if (WordLib.isDue(w, today)) review.due++; }
    }
    const checkin = { goal, days: checkinDays, streak: summary.streak, best: summary.best, total: summary.total };
    return { days: Object.values(byDay), totals, lists: Object.values(byList), review, checkin, from: startDay, to: today };
  }

  if (action === 'clearRecords') {
    const childId = checkId(body.child, '孩子编号');
    if (!cfg.children.some(c => c.id === childId)) bad('找不到这个孩子', 404);
    return { ok: true, deleted: await clearChild(s, childId) };
  }

  bad('未知操作');
}

// ---------- 入口 ----------
async function handle(fn) {
  try {
    return { status: 200, data: await fn() };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, data: { error: e.message } };
    return { status: 500, data: { error: '存储出错：' + ((e && e.message) || String(e)) } };
  }
}

// params：带 get(name) 的查询参数对象（如 URLSearchParams）；返回 { status, data }
export function handleGet(env, params) {
  return handle(async () => {
    const s = env.store;
    const op = params.get('op');
    if (op === 'config') return publicConfig(await loadConfig(s, env));
    if (op === 'list') {
      const id = checkId(params.get('id') || '', '单词表编号');
      const text = await s.get(listKey(id));
      return { text: text || null };
    }
    if (op === 'stats') {
      const child = checkId(params.get('child') || '', '孩子编号');
      if (!(await loadConfig(s, env)).children.some(c => c.id === child)) return { words: {} };
      return readStats(s, child);
    }
    // “你是谁？”页面上每个孩子的进度：今天答对数 / 每日目标、连续打卡天数、已掌握单词数
    if (op === 'progress') {
      const cfg = await loadConfig(s, env);
      const today = WordLib.bjDate();
      const list = await inBatches(cfg.children, 10, async c => {
        const st = await readStats(s, c.id);
        const ck = WordLib.checkin(st.days, c.goal || DEFAULT_GOAL, today);
        const mastered = Object.values(st.words || {}).filter(w => w && w.mastered).length;
        return { id: c.id, todayCount: ck.todayCount, goal: ck.goal, doneToday: ck.doneToday, streak: ck.streak, mastered };
      });
      return { children: list };
    }
    if (op === 'alltext') {
      const cfg = await loadConfig(s, env);
      const texts = await inBatches(cfg.lists, 10, l => s.get(listKey(l.id)));
      return { lists: cfg.lists.map((l, i) => ({ id: l.id, name: l.name, text: texts[i] || '' })) };
    }
    bad('未知操作');
  });
}

// bodyText：请求体原文；返回 { status, data }
export function handlePost(env, bodyText) {
  return handle(async () => {
    let body;
    try { body = JSON.parse(bodyText); } catch (e) { bad('请求格式错误'); }
    if (!body || typeof body !== 'object') bad('请求格式错误');
    const s = env.store;
    if (body.op === 'pin') {
      const child = await verifyChild(s, await loadConfig(s, env), body.child, body.pin);
      return { ok: true, name: child.name };
    }
    if (body.op === 'record') return saveRecord(s, await loadConfig(s, env), body);
    if (body.op === 'admin') {
      await verifyAdmin(s, env, body.password);
      return admin(s, env, body);
    }
    bad('未知操作');
  });
}
