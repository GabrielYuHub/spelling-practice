// 测试工具：把云函数和内存版数据库（src/mock-tcb.js）打包成一个临时文件，再像 HTTP 网关一样调用 main()
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const { writeAssets } = require('../tools/make-assets');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, '..', '网站发布');
const PASSWORD = 'test-pw';

let app = null;
function load() {
  if (app) return app;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spell-test-'));
  const assets = path.join(dir, 'assets.js');
  const out = path.join(dir, 'app.cjs');
  writeAssets(SITE, assets);
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src/cloudbase.js')],
    bundle: true, format: 'cjs', platform: 'node', target: 'node16', outfile: out, logLevel: 'error',
    alias: { 'site-assets': assets, '@cloudbase/node-sdk': path.join(ROOT, 'src/mock-tcb.js') },
    banner: { js: `const PASSWORD = ${JSON.stringify(PASSWORD)};` },
  });
  app = require(out);
  return app;
}

// 可以调整的“当前时间”（测试锁定到期、跨天等）
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(Date.now()); }
  static now() { return realNow() + offset; }
};

// 每个测试开始时调用：清空数据库、恢复时间，返回调用接口的方法
function fresh() {
  const m = load();
  if (globalThis.__tcbMem) globalThis.__tcbMem.clear();
  offset = 0;
  delete process.env.MOCK_JITTER;
  const raw = async (method, pathName, query, body) => {
    const r = await m.main({ path: pathName, httpMethod: method, queryStringParameters: query || {}, body: body === undefined ? '' : body, isBase64Encoded: false });
    return r;
  };
  const call = async (method, query, body) => {
    const r = await raw(method, '/api/app', query, body === undefined ? '' : JSON.stringify(body));
    return { status: r.statusCode, data: JSON.parse(r.body) };
  };
  const get = (op, extra = {}) => call('GET', { op, ...extra });
  const post = body => call('POST', {}, body);
  const admin = (action, extra = {}, password = PASSWORD) => post({ op: 'admin', password, action, ...extra });
  return {
    raw, call, get, post, admin,
    db: () => globalThis.__tcbMem.get('spell_kv'),
    advance: ms => { offset += ms; },
  };
}

// 北京时间日期和记录编号
const bjDate = (t = Date.now()) => new RealDate(t + 8 * 3600e3).toISOString().slice(0, 10);
const recordId = (list, suffix, t = Date.now()) => new RealDate(t).toISOString().replace(/[-:]/g, '').slice(0, 15) + '_' + list + '_' + suffix;

// 提交一轮记录（默认孩子、默认 PIN）
function record(api, { id, seq = 1, events = [], status = 'complete', child = 'c_default', pin = '0000', start, correct, wrong } = {}) {
  const now = new RealDate(Date.now()).toISOString();
  return api.post({
    op: 'record', child, pin,
    record: {
      id, seq, status, events, start: start || now, durationSec: 60,
      correct: correct === undefined ? events.filter(e => e.ok).length : correct,
      wrong: wrong === undefined ? events.filter(e => !e.ok).length : wrong,
    },
  });
}
const ev = (en, ok, extra = {}) => ({ en, ok, at: new RealDate(Date.now()).toISOString(), ...extra });

module.exports = { fresh, record, ev, bjDate, recordId, PASSWORD, SITE };
