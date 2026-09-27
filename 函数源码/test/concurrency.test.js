// 多台设备同时提交（T3）：用 MOCK_JITTER 让数据库调用随机延迟、请求真正交错，更新不能丢
const test = require('node:test');
const assert = require('node:assert/strict');
const { fresh, record, ev, bjDate, recordId } = require('./helpers');

test('10 台设备同时为同一个孩子提交，熟练度和打卡一次都不丢', async () => {
  const api = fresh();
  await api.get('config');
  await api.get('stats', { child: 'c_default' }); // 先建立每日计数
  process.env.MOCK_JITTER = '1';
  const res = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    record(api, { id: recordId('l_default', 'd' + String(i).padStart(3, '0')), events: [ev('new', true), ev('new', true), ev('new', true)] })));
  delete process.env.MOCK_JITTER;
  assert.ok(res.every(r => r.status === 200));
  const st = (await api.get('stats', { child: 'c_default' })).data;
  assert.equal(st.words.new.right, 30);
  assert.equal(st.days[bjDate()], 30);
});
