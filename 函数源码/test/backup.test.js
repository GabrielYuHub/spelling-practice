// 导出完整备份 → 合并导入（按名字对应、记录去重、熟练度取答题次数多的一份）
const test = require('node:test');
const assert = require('node:assert/strict');
const { fresh, record, ev, recordId } = require('./helpers');

// 按管理页的做法导出：exportBase + 每个孩子分页读取记录
async function exportAll(api) {
  const base = (await api.admin('exportBase')).data;
  const records = {};
  for (const c of base.config.children) {
    records[c.id] = [];
    for (let offset = 0; ; offset += 2) { // 每页 2 条，覆盖分页
      const r = (await api.admin('exportRecords', { child: c.id, offset, limit: 2 })).data;
      records[c.id].push(...r.records);
      if (r.done) break;
    }
  }
  return { ...base, records };
}

// 按管理页的做法导入：先单词表和孩子，再按对应关系导入记录和熟练度
async function importAll(api, d) {
  const r1 = (await api.admin('importConfig', {
    lists: d.config.lists.map(l => ({ id: l.id, name: l.name, roundSize: l.roundSize, group: l.group, text: d.wordlists[l.id], apply: true })),
    children: d.config.children.map(c => ({ ...c, apply: true })),
  })).data;
  for (const c of d.config.children) {
    const to = r1.childMap[c.id];
    const recs = (d.records[c.id] || []).map(r => {
      const m = /^(\d{8}T\d{6})_([a-z0-9_]+)_([a-z0-9]{4,10})$/.exec(r.id);
      return { ...r, id: m[1] + '_' + (r1.listMap[m[2]] || m[2]) + '_' + m[3] };
    });
    await api.admin('importRecords', { child: to, records: recs });
    if (d.stats[c.id]) await api.admin('importStats', { child: to, words: d.stats[c.id].words });
  }
  return r1;
}

test('完整备份导出后合并导入到新环境：数据一致，重复导入不会重复', async () => {
  const api = fresh();
  await api.get('config');
  const fruit = (await api.admin('saveList', { list: { name: '课外 水果' }, text: 'apple 苹果\npear 梨' })).data.id;
  await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000', goal: 15, tries: 4, round: 10, groups: ['课外'], rates: [0.5, 0.6, 0.9] }, { name: '小红', pin: '1111' }] });
  for (let i = 0; i < 3; i++) await record(api, { id: recordId(fruit, 'bk0' + i, Date.now() - i * 1000), events: [ev('apple', i > 0), ev('pear', true)] });
  const backup = JSON.parse(JSON.stringify(await exportAll(api)));
  assert.equal(backup.records.c_default.length, 3);
  assert.equal(backup.config.children[0].pin, '0000', '完整备份含 PIN');

  // 新环境：已经有一个同名单词表（内容不同）和一个同名孩子（PIN 不同）
  const api2 = fresh();
  await api2.get('config');
  await api2.admin('saveList', { list: { name: '课外 水果' }, text: 'banana 香蕉' });
  await api2.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '9999' }] });
  const r1 = await importAll(api2, backup);
  assert.deepEqual([r1.summary.listsAdded, r1.summary.listsUpdated, r1.summary.childrenAdded, r1.summary.childrenUpdated], [0, 2, 1, 1]);

  const cfg = (await api2.admin('config')).data;
  const kid = cfg.children.find(c => c.name === '小朋友');
  assert.deepEqual([kid.pin, kid.goal, kid.tries, kid.round, kid.groups, kid.rates], ['0000', 15, 4, 10, ['课外'], [0.5, 0.6, 0.9]]);
  const newFruit = cfg.lists.find(l => l.name === '课外 水果').id;
  assert.match((await api2.get('list', { id: newFruit })).data.text, /apple/);
  const recs = (await api2.admin('records', { child: kid.id })).data.records;
  assert.equal(recs.length, 3);
  assert.ok(recs.every(r => r.list === newFruit), '记录编号里的单词表换成新环境的编号');
  const st = (await api2.get('stats', { child: kid.id })).data.words;
  assert.deepEqual([st.apple.right, st.apple.wrong, st.pear.right], [2, 1, 3]);

  // 再导入一次：什么都不会重复
  await importAll(api2, backup);
  assert.equal((await api2.admin('records', { child: kid.id })).data.records.length, 3);
  assert.equal((await api2.get('stats', { child: kid.id })).data.words.apple.right, 2);
});

test('合并导入：熟练度逐个单词保留答题次数多的一份；不合格的内容会跳过', async () => {
  const api = fresh();
  await api.get('config');
  await record(api, { id: recordId('l_default', 'st01'), events: [ev('new', true), ev('new', true), ev('school', true)] });
  const r = (await api.admin('importStats', { child: 'c_default', words: {
    new: { right: 1, wrong: 0, score: 0 },             // 次数更少：不覆盖
    school: { right: 5, wrong: 2, score: 3, lvl: 2, first: '2026-01-02', last: '2026-02-03', bad: 'x' },  // 次数更多：覆盖
    bag: { right: 1, wrong: 0, score: 0 },             // 新单词：加入
  } })).data;
  assert.equal(r.changed, 2);
  const st = (await api.get('stats', { child: 'c_default' })).data.words;
  assert.deepEqual([st.new.right, st.school.right, st.bag.right], [2, 5, 1]);
  assert.deepEqual([st.school.first, st.school.last, st.school.bad], ['2026-01-02', '2026-02-03', undefined], '日期保留，其他字段丢掉');
  const c = (await api.admin('importConfig', {
    lists: [{ id: 'l_x', name: '空表', text: '# 空', apply: true }],
    children: [{ id: 'c_x', name: '坏 PIN', pin: '12', apply: true }],
  })).data;
  assert.equal(c.summary.skipped.length, 2);
  const rec = (await api.admin('importRecords', { child: 'c_default', records: [{ id: 'bad' }, null] })).data;
  assert.deepEqual([rec.added, rec.skipped], [0, 2]);
});
