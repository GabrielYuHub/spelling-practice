// 接口：初始化、PIN 与锁定、答题记录、熟练度和打卡、单词表、分组、孩子、密码、报表、网页文件
const test = require('node:test');
const assert = require('node:assert/strict');
const { fresh, record, ev, bjDate, recordId, PASSWORD } = require('./helpers');

const MIN = 60000;

test('首次访问自动初始化：默认孩子和默认单词表', async () => {
  const api = fresh();
  const { status, data } = await api.get('config');
  assert.equal(status, 200);
  assert.deepEqual(data.children, [{ id: 'c_default', name: '小朋友', goal: 20, tries: 6, round: 20, daily: 30, newCap: 5, groups: null, level: 'auto', lvMed: 2, lvDict: 4, maxBlanks: 8, rates: [0.7, 0.85, 1] }]);
  assert.equal(data.lists[0].id, 'l_default');
  assert.equal(data.lists[0].group, '三上');
  assert.ok(data.lists[0].count > 0);
  assert.ok(!JSON.stringify(data).includes('0000'), '公开配置不能带 PIN');
  const list = await api.get('list', { id: 'l_default' });
  assert.match(list.data.text, /school/);
  assert.equal((await api.get('list', { id: 'l_nope' })).data.text, null);
  assert.equal((await api.get('list', { id: 'BAD ID' })).status, 400);
  assert.equal((await api.get('nope')).status, 400);
});

test('PIN：输错提示剩余次数，连续 5 次锁定 10 分钟，改 PIN 立即解锁', async () => {
  const api = fresh();
  await api.get('config');
  assert.equal((await api.post({ op: 'pin', child: 'c_default', pin: '0000' })).status, 200);
  for (let i = 1; i <= 4; i++) {
    const r = await api.post({ op: 'pin', child: 'c_default', pin: '1111' });
    assert.equal(r.status, 401);
    assert.match(r.data.error, new RegExp('还可以再试 ' + (5 - i) + ' 次'));
  }
  assert.equal((await api.post({ op: 'pin', child: 'c_default', pin: '1111' })).status, 429);
  assert.equal((await api.post({ op: 'pin', child: 'c_default', pin: '0000' })).status, 429, '锁定期间输对也不行');
  assert.equal((await record(api, { id: recordId('l_default', 'aaaa'), events: [ev('new', true)] })).status, 429, '锁定期间不能提交记录');
  assert.ok((await api.admin('config')).data.pinLocks.c_default > Date.now(), '管理页能看到锁定');
  api.advance(9 * MIN);
  assert.equal((await api.post({ op: 'pin', child: 'c_default', pin: '0000' })).status, 429, '9 分钟后还锁着');
  api.advance(2 * MIN);
  assert.equal((await api.post({ op: 'pin', child: 'c_default', pin: '0000' })).status, 200, '10 分钟到期自动解锁');
  for (let i = 0; i < 5; i++) await api.post({ op: 'pin', child: 'c_default', pin: '9' });
  await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '4321' }] });
  assert.equal((await api.post({ op: 'pin', child: 'c_default', pin: '4321' })).status, 200, '改 PIN 后立即可用');
});

test('PIN：同时输错 4 次不会多算或少算', async () => {
  const api = fresh();
  await api.get('config');
  process.env.MOCK_JITTER = '1';
  await Promise.all([1, 2, 3, 4].map(() => api.post({ op: 'pin', child: 'c_default', pin: '9999' })));
  delete process.env.MOCK_JITTER;
  assert.equal((await api.post({ op: 'pin', child: 'c_default', pin: '9999' })).status, 429);
});

test('答题记录：同一轮按序号增量提交，重复提交被忽略', async () => {
  const api = fresh();
  await api.get('config');
  const id = recordId('l_default', 'ab12');
  assert.equal((await record(api, { id, seq: 1, status: 'incomplete', events: [ev('school', false), ev('new', true)] })).status, 200);
  assert.equal((await record(api, { id, seq: 1, events: [ev('school', false)] })).data.duplicate, true);
  await record(api, { id, seq: 2, events: [ev('school', true)] });
  const st = (await api.get('stats', { child: 'c_default' })).data;
  assert.deepEqual([st.words.school.wrong, st.words.school.right, st.words.school.score], [1, 1, 1]);
  assert.equal(st.days[bjDate()], 2);
  const recs = (await api.admin('records', { child: 'c_default' })).data.records;
  assert.equal(recs.length, 1);
  assert.equal(recs[0].status, 'complete');
  assert.equal(recs[0].listName, '三上 Unit 1');
  assert.equal((await api.admin('records', { child: 'c_default', list: 'l_nope' })).data.records.length, 0);
});

test('难度：按孩子保存；孩子切换要验证 PIN；家长可以设置升级次数', async () => {
  const api = fresh();
  await api.get('config');
  assert.equal((await api.post({ op: 'level', child: 'c_default', pin: '0000', level: 'dictation' })).status, 200);
  assert.equal((await api.get('config')).data.children[0].level, 'dictation');
  assert.equal((await api.post({ op: 'level', child: 'c_default', pin: '1111', level: 'easy' })).status, 401);
  assert.equal((await api.post({ op: 'level', child: 'c_default', pin: '0000', level: 'hard' })).status, 400);
  assert.equal((await api.get('config')).data.children[0].level, 'dictation');
  let c = (await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000', level: 'medium', lvMed: 3, lvDict: 6 }] })).data.config.children[0];
  assert.deepEqual([c.level, c.lvMed, c.lvDict], ['medium', 3, 6]);
  c = (await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000', lvMed: 5, lvDict: 3 }] })).data.config.children[0];
  assert.deepEqual([c.level, c.lvMed, c.lvDict], ['medium', 5, 6], '没传难度时保留原来的；听写次数至少比进阶多 1');
  c = (await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000', level: 'xx' }] })).data.config.children[0];
  assert.equal(c.level, 'auto');
  c = (await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000', maxBlanks: 3 }] })).data.config.children[0];
  assert.equal(c.maxBlanks, 3);
  c = (await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000', maxBlanks: 99 }] })).data.config.children[0];
  assert.equal(c.maxBlanks, 30, '挖空上限 1–30');
  c = (await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000' }] })).data.config.children[0];
  assert.equal(c.maxBlanks, 30, '没传时保留原来的');
  // 朗读语速：慢、中、快三个播放速度，0.5–1.5，保留两位小数，按从慢到快排好
  c = (await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000', rates: [0.5, 0.65, 0.8] }] })).data.config.children[0];
  assert.deepEqual(c.rates, [0.5, 0.65, 0.8]);
  c = (await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000', rates: [2, 0.1, 0.777] }] })).data.config.children[0];
  assert.deepEqual(c.rates, [0.5, 0.78, 1.5], '超出范围的取边界，并排好顺序');
  c = (await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000', rates: [0.5, 'x', 0.8] }] })).data.config.children[0];
  assert.deepEqual(c.rates, [0.5, 0.78, 1.5], '格式不对时保留原来的');
  c = (await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000' }] })).data.config.children[0];
  assert.deepEqual(c.rates, [0.5, 0.78, 1.5], '没传时保留原来的');
  assert.deepEqual((await api.get('config')).data.children[0].rates, [0.5, 0.78, 1.5], '练习页读到的配置里有语速');
  c = (await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000', rates: [0.55, 0.7, 0.85] }] })).data.config.children[0];
  assert.deepEqual(c.rates, [0.7, 0.85, 1], '改成录音以前的默认值，按新的默认值算');
});

test('答题记录：同一题第 3 次及以后的答错不加熟练度分数（ns）', async () => {
  const api = fresh();
  await api.get('config');
  await record(api, { id: recordId('l_default', 'ns01'), events: [ev('new', false), ev('new', false), ev('new', false, { ns: 1 }), ev('new', false, { ns: 1 })] });
  const w = (await api.get('stats', { child: 'c_default' })).data.words.new;
  assert.deepEqual([w.wrong, w.score], [4, 4]);
});

test('答题记录：答错退 2 级，同一道题后面的答错（rp）不再退级', async () => {
  const api = fresh();
  await api.get('config');
  // 先把 school 练到第 4 级：第一次答对 → 1 级；之后每次到期答对升一级
  const DAY = 86400e3;
  let n = 0;
  for (const gap of [0, 1, 2, 4]) {
    api.advance(gap * DAY);
    await record(api, { id: recordId('l_default', 'lv' + String(n++).padStart(2, '0')), events: [ev('school', true)] });
  }
  let w = (await api.get('stats', { child: 'c_default' })).data.words.school;
  assert.equal(w.lvl, 4);
  await record(api, { id: recordId('l_default', 'lvwrong'), events: [ev('school', false), ev('school', false, { rp: 1 }), ev('school', false, { rp: 1, ns: 1 }), ev('school', true)] });
  w = (await api.get('stats', { child: 'c_default' })).data.words.school;
  assert.deepEqual([w.lvl, w.wrong, w.score], [2, 3, 3]);
});

test('答题记录：检查 PIN、编号、单词表；今日复习和错词本是虚拟单词表', async () => {
  const api = fresh();
  await api.get('config');
  assert.equal((await record(api, { id: recordId('l_default', 'aaaa'), pin: '1234' })).status, 401);
  assert.equal((await record(api, { id: 'bad' })).status, 400);
  assert.equal((await record(api, { id: recordId('l_nope', 'aaaa') })).status, 404);
  assert.equal((await record(api, { id: recordId('x_review', 'aaaa'), events: [ev('new', true)] })).status, 200);
  assert.equal((await record(api, { id: recordId('x_new', 'bbbb', Date.now() + 1000), events: [ev('school', true)] })).status, 200);
  const recs = (await api.admin('records', { child: 'c_default' })).data.records;
  assert.deepEqual(recs.map(r => r.listName), ['学新词', '今日复习']);
  // 按单词分组练的今日复习、学新词、错词本：记录里记下分组，报表按分组分开统计；普通单词表不记分组
  await record(api, { id: recordId('x_review', 'cccc', Date.now() + 2000), events: [ev('new', true)], group: '课本三上' });
  await record(api, { id: recordId('x_review', 'dddd', Date.now() + 3000), events: [ev('new', false)], group: '英孚三上' });
  await record(api, { id: recordId('l_default', 'eeee', Date.now() + 4000), events: [ev('new', true)], group: '课本三上' });
  const recs2 = (await api.admin('records', { child: 'c_default' })).data.records;
  assert.deepEqual(recs2.slice(0, 3).map(r => [r.listName, r.group]), [[recs2[0].listName, undefined], ['今日复习 · 英孚三上', '英孚三上'], ['今日复习 · 课本三上', '课本三上']]);
  const rows = (await api.admin('report', { child: 'c_default', days: 7 })).data.lists.map(l => l.name).sort();
  assert.ok(rows.includes('今日复习') && rows.includes('今日复习 · 课本三上') && rows.includes('今日复习 · 英孚三上'), rows.join(','));
  const st = (await api.get('stats', { child: 'c_default' })).data.words.school;
  assert.equal(st.first, bjDate(), '服务器也记下第一次答的日期');
  assert.equal((await api.post(undefined)).status, 400);
  assert.equal((await api.call('POST', {}, '{bad json')).status, 400);
});

test('打卡：没有每日计数的旧记录会被补算；进度接口', async () => {
  const api = fresh();
  await api.get('config');
  // 功能上线前的历史记录：直接写进数据库（没有每日计数）
  const day = n => Date.now() - n * 86400e3;
  for (const [n, c] of [[3, 25], [2, 20], [1, 22]]) {
    const id = recordId('l_default', 'h00' + n, day(n));
    const key = 'records/c_default/' + id + '.json';
    api.db().set(key.replace(/[^A-Za-z0-9]/g, ch => '_' + ch.charCodeAt(0).toString(16).padStart(2, '0')),
      { k: key, dir: 'records/c_default', v: JSON.stringify({ id, start: new Date(day(n)).toISOString(), correct: c, wrong: 0 }) });
  }
  let st = (await api.get('stats', { child: 'c_default' })).data;
  assert.equal(st.daysInit, true);
  assert.equal(st.days[bjDate(day(2))], 20);
  await record(api, { id: recordId('l_default', 'today'), events: Array.from({ length: 20 }, () => ev('new', true)) });
  const p = (await api.get('progress')).data.children[0];
  assert.deepEqual([p.todayCount, p.goal, p.doneToday, p.streak], [20, 20, true, 4]);
  await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000', goal: 30 }] });
  const p2 = (await api.get('progress')).data.children[0];
  assert.deepEqual([p2.goal, p2.doneToday, p2.streak], [30, false, 0]);
});

test('管理密码：输错锁定 15 分钟；修改密码；删除 auth.json 恢复原始密码', async () => {
  const api = fresh();
  await api.get('config');
  assert.equal((await api.admin('verify')).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await api.admin('verify', {}, 'wrong')).status, 401);
  assert.equal((await api.admin('verify', {}, 'wrong')).status, 429);
  assert.equal((await api.admin('verify')).status, 429);
  api.advance(14 * MIN);
  assert.equal((await api.admin('verify')).status, 429, '14 分钟后还锁着');
  api.advance(2 * MIN);
  assert.equal((await api.admin('verify')).status, 200, '15 分钟到期自动解锁');
  assert.equal((await api.admin('changePassword', { newPassword: 'ab' })).status, 400);
  assert.equal((await api.admin('changePassword', { newPassword: 'newpass1' })).status, 200);
  assert.equal((await api.admin('verify')).status, 401);
  assert.equal((await api.admin('verify', {}, 'newpass1')).status, 200);
  api.db().delete('auth_2ejson');
  assert.equal((await api.admin('verify', {}, PASSWORD)).status, 200);
});

test('单词表：新建、重名、格式、删除、至少保留一个', async () => {
  const api = fresh();
  await api.get('config');
  const r = await api.admin('saveList', { list: { name: '课外 水果' }, text: 'apple n. 苹果\n1234 坏行\npear 梨' });
  assert.equal(r.status, 200);
  const l = r.data.config.lists.find(x => x.id === r.data.id);
  assert.deepEqual([l.count, l.group], [2, '课外']);
  assert.equal((await api.admin('saveList', { list: { name: '课外 水果' }, text: 'x 叉' })).status, 400);
  assert.equal((await api.admin('saveList', { list: { name: '空的' }, text: '# 只有注释' })).status, 400);
  assert.equal((await api.admin('saveList', { list: { name: '' }, text: 'cat 猫' })).status, 400);
  const g = await api.admin('saveList', { list: { id: r.data.id, name: '课外 水果', group: '其他' }, text: 'apple 苹果' });
  assert.equal(g.data.config.lists.find(x => x.id === r.data.id).group, '', '“其他”存为没有分组');
  assert.equal((await api.admin('deleteList', { id: r.data.id })).status, 200);
  assert.equal((await api.get('list', { id: r.data.id })).data.text, null);
  assert.equal((await api.admin('deleteList', { id: 'l_default' })).status, 400);
});

test('单词表顺序：▲▼ 只在同一分组里移动', async () => {
  const api = fresh();
  await api.get('config');
  for (const name of ['三上 Unit 2', '英孚三上 Unit 1', '三上 Unit 3']) await api.admin('saveList', { list: { name }, text: 'cat 猫' });
  const names = async () => (await api.get('config')).data.lists.map(l => l.name);
  const id = n => api.get('config').then(r => r.data.lists.find(l => l.name === n).id);
  await api.admin('moveList', { id: await id('三上 Unit 3'), dir: 'up' });
  assert.deepEqual(await names(), ['三上 Unit 1', '三上 Unit 3', '三上 Unit 2', '英孚三上 Unit 1']);
  await api.admin('moveList', { id: await id('英孚三上 Unit 1'), dir: 'up' });
  assert.deepEqual(await names(), ['三上 Unit 1', '三上 Unit 3', '三上 Unit 2', '英孚三上 Unit 1'], '不跨分组');
});

test('按分组管理：上移、改名（名称和孩子分配跟着改、可以合并）、删除', async () => {
  const api = fresh();
  await api.get('config');
  for (const name of ['三上 Unit 2', '英孚三上 Unit 1', '动物']) await api.admin('saveList', { list: { name }, text: 'cat 猫' });
  await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000', groups: ['三上', '其他'] }] });
  const names = async () => (await api.get('config')).data.lists.map(l => l.name);
  await api.admin('moveGroup', { group: '英孚三上', dir: 'up' });
  assert.deepEqual(await names(), ['英孚三上 Unit 1', '三上 Unit 1', '三上 Unit 2', '动物']);
  await api.admin('moveGroup', { group: '其他', dir: 'up' });
  assert.deepEqual((await names()).at(-1), '动物', '“其他”固定在最后');
  let r = await api.admin('renameGroup', { from: '三上', to: '课本三上' });
  assert.deepEqual(await names(), ['英孚三上 Unit 1', '课本三上 Unit 1', '课本三上 Unit 2', '动物']);
  assert.deepEqual(r.data.config.children[0].groups, ['课本三上', '其他']);
  r = await api.admin('renameGroup', { from: '其他', to: '英孚三上' });
  assert.deepEqual(r.data.config.lists.filter(l => l.group === '英孚三上').map(l => l.name), ['英孚三上 Unit 1', '动物']);
  assert.deepEqual(r.data.config.children[0].groups, ['课本三上', '英孚三上']);
  await api.admin('saveList', { list: { name: '课外 ' + 'x'.repeat(27) }, text: 'cat 猫' });
  assert.equal((await api.admin('renameGroup', { from: '课外', to: '课外阅读练习' })).status, 400, '改名后超过 30 个字');
  r = await api.admin('deleteGroup', { group: '英孚三上' });
  assert.equal(r.data.deleted, 2);
  assert.deepEqual(r.data.config.children[0].groups, ['课本三上']);
  await api.admin('deleteGroup', { group: '课外' });
  assert.equal((await api.admin('deleteGroup', { group: '课本三上' })).status, 400, '不能删除唯一的分组');
});

test('孩子：设置、校验、按分组分配、删除孩子同时删除记录', async () => {
  const api = fresh();
  await api.get('config');
  await record(api, { id: recordId('l_default', 'kid1'), events: [ev('new', true)] });
  const r = await api.admin('saveChildren', { children: [
    { name: '小红', pin: '1111', goal: 30, tries: 3, round: 15, groups: ['三上', '三上', '', ' 课外 '] },
    { name: '小明', pin: '2222', goal: 999, tries: 99, round: 0 },
  ] });
  assert.equal(r.status, 200);
  const [hong, ming] = r.data.config.children;
  assert.deepEqual([hong.goal, hong.tries, hong.round, hong.groups], [30, 3, 15, ['三上', '其他', '课外']]);
  assert.deepEqual([ming.goal, ming.tries, ming.round, ming.groups], [500, 10, 1, null], '超出范围时取上下限');
  assert.equal((await api.admin('records', { child: 'c_default' })).data.records.length, 0, '删除孩子时删除记录');
  assert.equal((await api.admin('saveChildren', { children: [] })).status, 400);
  assert.equal((await api.admin('saveChildren', { children: [{ name: 'a', pin: '1' }] })).status, 400);
  assert.equal((await api.admin('saveChildren', { children: [{ name: 'a', pin: '1111' }, { name: 'a', pin: '2222' }] })).status, 400);
  const plan = (await api.admin('saveChildren', { children: [{ id: hong.id, name: '小红', pin: '1111', daily: 40, newCap: 0 }, { id: ming.id, name: '小明', pin: '2222', daily: 5, newCap: 99 }] })).data.config.children;
  assert.deepEqual([plan[0].daily, plan[0].newCap, plan[1].daily, plan[1].newCap], [40, 0, 10, 50], '每天题量 10–200，新词上限 0–50（0 = 暂停）');
  const defaults = (await api.get('config')).data.children;
  assert.equal(defaults[0].newCap, 0);
  await api.admin('saveChildren', { children: [{ name: '小刚', pin: '3333' }] });
  const gang = (await api.get('config')).data.children[0];
  assert.deepEqual([gang.daily, gang.newCap], [30, 5], '默认每天 30 题、新词最多 5 个');
  await api.admin('saveChildren', { children: [{ id: hong.id, name: '小红', pin: '1111', goal: 30, tries: 3, round: 15, groups: ['三上', '其他', '课外'] }] });
  const pub = (await api.get('config')).data.children[0];
  assert.equal(pub.pin, undefined);
  assert.equal(pub.round, 15);
});

test('学习报表与清空记录', async () => {
  const api = fresh();
  await api.get('config');
  await record(api, { id: recordId('l_default', 'rep1'), events: [ev('new', true), ev('school', false)] });
  await record(api, { id: recordId('x_wrong', 'rep2'), events: [ev('school', true)] });
  const old = Date.now() - 20 * 86400e3;
  await record(api, { id: recordId('l_default', 'rep3', old), start: new Date(old).toISOString(), events: [] });
  const r7 = (await api.admin('report', { child: 'c_default', days: 7 })).data;
  assert.equal(r7.days.length, 7);
  assert.deepEqual([r7.totals.rounds, r7.totals.answered, r7.totals.correct], [2, 3, 2]);
  assert.deepEqual(r7.lists.map(l => l.name).sort(), ['三上 Unit 1', '错词本'].sort());
  assert.equal(r7.review.learning, 2);
  assert.equal((await api.admin('report', { child: 'c_default', days: 30 })).data.totals.rounds, 3);
  // 只分配了“课外”分组时，复习概况只统计课外的单词（new、school 在三上里，不算）
  await api.admin('saveList', { list: { name: '课外 水果' }, text: 'apple 苹果\nnew 新的' });
  await api.admin('saveChildren', { children: [{ id: 'c_default', name: '小朋友', pin: '0000', groups: ['课外'] }] });
  const rg = (await api.admin('report', { child: 'c_default', days: 7 })).data;
  assert.equal(rg.review.learning, 1, '只算分配的分组');
  assert.equal(rg.totals.rounds, 2, '练习记录照常统计');
  assert.equal((await api.admin('clearRecords', { child: 'c_default' })).data.deleted, 3);
  assert.equal((await api.admin('records', { child: 'c_default' })).data.records.length, 0);
});

test('网页文件：根路径返回练习页，其他文件按名称返回，未知文件 404', async () => {
  const api = fresh();
  const body = async p => { const r = await api.raw('GET', p); return [r.statusCode, r.headers['content-type'], r.body]; };
  let [s, t, b] = await body('/');
  assert.equal(s, 200); assert.match(t, /text\/html/); assert.match(b, /单词拼写练习/);
  [s, , b] = await body('/editor.html'); assert.match(b, /单词拼写管理/);
  [s, t] = await body('/wordlib.js'); assert.equal(s, 200); assert.match(t, /javascript/);
  [s] = await body('/nope.png'); assert.equal(s, 404);
  const o = await api.raw('OPTIONS', '/api/app'); assert.equal(o.statusCode, 204);
});

test('离线使用需要的文件：Service Worker、manifest、图标（图片用 base64 返回）', async () => {
  const api = fresh();
  const sw = await api.raw('GET', '/sw.js');
  assert.equal(sw.statusCode, 200);
  assert.match(sw.headers['content-type'], /javascript/);
  assert.match(sw.body, /addEventListener\('fetch'/);
  const man = await api.raw('GET', '/manifest.json');
  assert.equal(JSON.parse(man.body).display, 'standalone');
  for (const f of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
    const r = await api.raw('GET', '/' + f);
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.equal(r.isBase64Encoded, true);
    assert.deepEqual([...Buffer.from(r.body, 'base64').subarray(1, 4)], [...Buffer.from('PNG')]);
  }
  // sw.js 里缓存的文件都能取到
  const files = JSON.parse(sw.body.match(/const FILES = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  for (const f of files) assert.equal((await api.raw('GET', '/' + f.replace('./', ''))).statusCode, 200, f);
  // 使用说明和它引用的截图都能取到
  const help = await api.raw('GET', '/help.html');
  assert.equal(help.statusCode, 200);
  const imgs = [...help.body.matchAll(/src="help\/([^"]+)"/g)].map(m => m[1]);
  assert.ok(imgs.length >= 8, '使用说明里有截图');
  for (const f of imgs) {
    const r = await api.raw('GET', '/help/' + f);
    assert.equal(r.statusCode, 200, f);
    assert.equal(r.headers['content-type'], 'image/webp');
    assert.equal(Buffer.from(r.body, 'base64').subarray(8, 12).toString(), 'WEBP');
  }
  const head = await api.raw('HEAD', '/icon-192.png');
  assert.equal(head.isBase64Encoded, false);
});

test('录音：只给单词表里有的；取到后存起来，以后不再去有道；有道没有的也记下来；网络出错不记', async () => {
  const api = fresh();
  await api.get('config');
  await api.admin('saveList', { list: { name: '测试' }, text: 'school n. 学校 | I go to school every day. | 我每天去上学。\nask... for help 请……帮忙' });
  const asked = [];
  globalThis.__fetchAudio = async text => { asked.push(text); return text === 'school' ? 'QUJD' : text === 'ask for help' ? undefined : null; };
  try {
    let r = await api.get('audio', { t: 'school' });
    assert.deepEqual([r.status, r.data.audio], [200, 'QUJD']);
    r = await api.get('audio', { t: 'school' });
    assert.equal(r.data.audio, 'QUJD');
    assert.deepEqual(asked, ['school'], '第二次从数据库取');
    r = await api.get('audio', { t: 'I go to school every day.' });
    assert.equal(r.data.audio, null);
    await api.get('audio', { t: 'I go to school every day.' });
    assert.equal(asked.filter(t => t.startsWith('I go')).length, 1, '有道没有的也记下来');
    api.advance(15 * 86400000);
    await api.get('audio', { t: 'I go to school every day.' });
    assert.equal(asked.filter(t => t.startsWith('I go')).length, 2, '14 天后再问一次');
    r = await api.get('audio', { t: 'ask... for help' });
    assert.deepEqual([r.data.audio, r.data.retry], [null, true], '按朗读时整理过的文字取；网络出错时告诉练习页');
    await api.get('audio', { t: 'ask... for help' });
    assert.equal(asked.filter(t => t === 'ask for help').length, 2, '网络出错不记，下次再试');
    r = await api.get('audio', { t: 'hello world' });
    assert.equal(r.status, 404, '单词表里没有的不去取');
    assert.ok(!asked.includes('hello world'));
    await api.admin('saveList', { list: { name: '测试2' }, text: 'hello world 你好世界' });
    r = await api.get('audio', { t: 'hello world' });
    assert.equal(r.status, 200, '新加的单词表马上能取');
  } finally { delete globalThis.__fetchAudio; }
});

