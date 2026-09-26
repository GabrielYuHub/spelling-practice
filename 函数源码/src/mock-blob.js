// 本地测试用的 Blob 模拟实现（数据存在内存里）
const mem = globalThis.__blobMem || (globalThis.__blobMem = new Map());
export function getStore(opts) {
  const name = typeof opts === 'string' ? opts : opts.name;
  const k = key => name + '/' + key;
  const decode = (v, type) => (v == null ? null : type === 'json' ? JSON.parse(v) : v);
  return {
    get: async (key, o) => decode(mem.has(k(key)) ? mem.get(k(key)) : null, o && o.type),
    set: async (key, v, o) => {
      if (o && o.onlyIfNew && mem.has(k(key))) throw Object.assign(new Error('exists'), { code: 'PRECONDITION_FAILED' });
      mem.set(k(key), String(v));
    },
    setJSON: async function (key, v, o) { return this.set(key, JSON.stringify(v), o); },
    delete: async key => { mem.delete(k(key)); },
    list: async o => ({
      blobs: [...mem.keys()].filter(x => x.startsWith(name + '/' + ((o && o.prefix) || '')))
        .map(x => ({ key: x.slice(name.length + 1), etag: '' })),
    }),
  };
}
