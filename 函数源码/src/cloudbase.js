// 腾讯云 CloudBase 适配层：一个普通云函数，通过 HTTP 网关挂在域名根路径 “/”
//   …/api/app                  → 接口（业务逻辑见 core.js）
//   / index.html editor.html wordlib.js words.js → 网页文件（打包时内置，不依赖静态网站托管）
// 数据存在文档型数据库的集合 spell_kv 中，每条记录是一个“键 → 文本”，与 EdgeOne Blob 的用法一致
// PASSWORD 在打包时通过文件开头的配置注入；ASSETS 由打包脚本生成
import tcb from '@cloudbase/node-sdk';
import ASSETS from 'site-assets';
import { handleGet, handlePost } from './core.js';

// SDK 在凭证出错时会产生未处理的 Promise 拒绝，这里只记录日志，避免整个函数崩溃
process.on('unhandledRejection', e => console.error('unhandledRejection:', e && e.message));

const COLL = 'spell_kv';

// 键 → 文档 _id：只保留字母数字，其余字符转成 _xx（十六进制），保证一一对应
const docId = key => key.replace(/[^A-Za-z0-9]/g, c => '_' + c.charCodeAt(0).toString(16).padStart(2, '0'));
const dirOf = key => (key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '');

let db = null;
function coll() {
  if (!db) db = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV }).database();
  return db.collection(COLL);
}

const store = {
  async get(key, opts) {
    const r = await coll().doc(docId(key)).get();
    const doc = r.data && r.data[0];
    if (!doc || typeof doc.v !== 'string') return null;
    return opts && opts.type === 'json' ? JSON.parse(doc.v) : doc.v;
  },
  async set(key, value, opts) {
    const data = { k: key, dir: dirOf(key), v: String(value), t: Date.now() };
    if (opts && opts.onlyIfNew) {
      try {
        await coll().add(Object.assign({ _id: docId(key) }, data));
      } catch (e) {
        if (await this.get(key) != null) throw Object.assign(new Error('已存在'), { code: 'PRECONDITION_FAILED' });
        throw e;
      }
      return;
    }
    await coll().doc(docId(key)).set(data);
  },
  // 条件更新（乐观锁）：读出当前内容 → mutate 算出新内容 → 仅当这期间没有别人改过时才写入，否则重新读取再算
  // mutate(当前文本或 null) 返回新文本，返回 null 表示不需要修改。多台设备同时提交时不会互相覆盖
  async update(key, mutate) {
    const c = coll(), id = docId(key);
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await c.doc(id).get();
      const doc = r.data && r.data[0];
      const next = mutate(doc && typeof doc.v === 'string' ? doc.v : null);
      if (next == null) return false;
      const data = { k: key, dir: dirOf(key), v: String(next), t: Date.now(), ver: Math.random().toString(36).slice(2) };
      if (!doc) {
        try { await c.add(Object.assign({ _id: id }, data)); return true; } catch (e) { continue; } // 别人刚好先创建了
      }
      // 以读取时的版本号为条件；旧数据没有版本号时，用写入时间代替
      const cond = doc.ver !== undefined ? { _id: id, ver: doc.ver } : { _id: id, t: doc.t };
      const u = await c.where(cond).update(data);
      if (Number(u.updated) === 1) return true;
      await new Promise(res => setTimeout(res, 10 + Math.random() * 40));
    }
    throw new Error('数据正在被其他设备修改，请稍后再试');
  },
  setJSON(key, value, opts) {
    return this.set(key, JSON.stringify(value), opts);
  },
  async delete(key) {
    await coll().doc(docId(key)).remove();
  },
  // 只支持以 “/” 结尾的目录前缀（业务里只有 records/<孩子>/ 这一种用法）
  async list({ prefix }) {
    const dir = prefix.replace(/\/$/, '');
    const blobs = [];
    for (let skip = 0; ; skip += 1000) {
      const r = await coll().where({ dir }).field({ k: true }).limit(1000).skip(skip).get();
      const rows = r.data || [];
      rows.forEach(d => blobs.push({ key: d.k }));
      if (rows.length < 1000) break;
    }
    return { blobs };
  },
  // 按键排序，连内容一起分页读取（导出用，一次查询代替逐条读取）
  async listValues(prefix, offset, limit, fromKey) {
    const c = coll(); // 先初始化 db，下面要用 db.command
    const cond = { dir: prefix.replace(/\/$/, '') };
    if (fromKey) cond.k = db.command.gte(fromKey);
    const r = await c.where(cond).orderBy('k', 'asc').skip(offset).limit(limit).field({ k: true, v: true }).get();
    return (r.data || []).map(d => ({ key: d.k, value: d.v }));
  },
  async deletePrefix(prefix) {
    const r = await coll().where({ dir: prefix.replace(/\/$/, '') }).remove();
    return Number(r.deleted) || 0;
  },
};

function defaultWords() {
  const f = ASSETS['words.js'];
  const m = f && f.body.match(/WORDS\s*=\s*`([\s\S]*)`/);
  return m ? m[1].replace(/^\s*\n/, '') : null;
}

const env = { store, password: PASSWORD, loadDefaultWords: async () => defaultWords() };

const reply = (statusCode, contentType, body, extra) => ({
  statusCode,
  headers: Object.assign({ 'content-type': contentType, 'cache-control': 'no-store' }, extra),
  body,
  isBase64Encoded: false,
});

// 打包为 CommonJS 后即 exports.main，执行方法填 index.main
export async function main(event) {
  const method = String((event && event.httpMethod) || 'GET').toUpperCase();
  const path = String((event && event.path) || '/');

  if (/(^|\/)api\/app\/?$/.test(path)) {
    let res;
    if (method === 'GET') {
      res = await handleGet(env, new URLSearchParams(event.queryStringParameters || {}));
    } else if (method === 'POST') {
      let body = event.body || '';
      if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
      res = await handlePost(env, body);
    } else if (method === 'OPTIONS') {
      return reply(204, 'text/plain', '');
    } else {
      res = { status: 405, data: { error: '不支持的请求方法' } };
    }
    return reply(res.status, 'application/json; charset=utf-8', JSON.stringify(res.data));
  }

  // 网页文件：按路径最后一段匹配，路径透传开或关都能用
  const name = path.split('/').pop() || 'index.html';
  const file = ASSETS[name];
  if (file && (method === 'GET' || method === 'HEAD')) return reply(200, file.type, method === 'HEAD' ? '' : file.body, { 'cache-control': 'no-cache' });
  if (!path.split('/').pop() || !name.includes('.')) {
    // 目录形式的地址（如 /、/spell/）返回练习页
    return reply(200, ASSETS['index.html'].type, ASSETS['index.html'].body, { 'cache-control': 'no-cache' });
  }
  return reply(404, 'text/plain; charset=utf-8', '404 Not Found');
}
