// 本地测试用：@cloudbase/node-sdk 文档型数据库的内存模拟（只实现本项目用到的方法）
const colls = globalThis.__tcbMem || (globalThis.__tcbMem = new Map());
const table = name => colls.get(name) || colls.set(name, new Map()).get(name);
const clone = o => JSON.parse(JSON.stringify(o));
// 设置环境变量 MOCK_JITTER=1 时，每次数据库调用随机等待 0–15ms，模拟网络延迟，让并发请求真正交错
const jitter = () => (typeof process !== 'undefined' && process.env.MOCK_JITTER ? new Promise(r => setTimeout(r, Math.random() * 15)) : null);
const match = (doc, cond) => Object.entries(cond).every(([k, v]) => (v && v.$gte !== undefined ? doc[k] >= v.$gte : doc[k] === v));

function query(name, cond, opts = {}) {
  return {
    field(f) { return query(name, cond, { ...opts, field: f }); },
    orderBy(k, dir) { return query(name, cond, { ...opts, order: [k, dir] }); },
    limit(n) { return query(name, cond, { ...opts, limit: n }); },
    skip(n) { return query(name, cond, { ...opts, skip: n }); },
    async get() { await jitter();
      let rows = [...table(name).values()].filter(d => match(d, cond));
      if (opts.order) rows.sort((a, b) => (a[opts.order[0]] > b[opts.order[0]] ? 1 : -1) * (opts.order[1] === 'desc' ? -1 : 1));
      rows = rows.slice(opts.skip || 0, (opts.skip || 0) + Math.min(opts.limit || 100, 1000));
      if (opts.field) rows = rows.map(d => Object.fromEntries(Object.keys(opts.field).concat('_id').map(k => [k, d[k]])));
      return { data: clone(rows) };
    },
    async update(data) { await jitter();
      let n = 0;
      for (const d of table(name).values()) if (match(d, cond)) { Object.assign(d, clone(data)); n++; }
      return { updated: n };
    },
    async remove() { await jitter();
      let n = 0;
      for (const [id, d] of table(name)) if (match(d, cond)) { table(name).delete(id); n++; }
      return { deleted: n };
    },
  };
}

const db = {
  command: { gte: v => ({ $gte: v }) },
  collection(name) {
    return {
      doc(id) {
        return {
          async get() { await jitter(); const d = table(name).get(id); return { data: d ? [clone(d)] : [] }; },
          async set(data) { await jitter(); table(name).set(id, { ...clone(data), _id: id }); return { updated: 1 }; },
          async remove() { await jitter(); table(name).delete(id); return { deleted: 1 }; },
        };
      },
      async add(data) { await jitter();
        if (table(name).has(data._id)) throw Object.assign(new Error('duplicate key'), { code: 'DATABASE_REQUEST_FAILED' });
        table(name).set(data._id, clone(data));
        return { id: data._id };
      },
      where(cond) { return query(name, cond); },
    };
  },
};

export default { SYMBOL_CURRENT_ENV: Symbol('env'), init: () => ({ database: () => db }) };
