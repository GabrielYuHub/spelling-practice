// 共用词库 wordlib.js：词条解析、挖空规则、熟练度与复习、打卡
const test = require('node:test');
const assert = require('node:assert/strict');
require('../../网站发布/wordlib.js');
const W = globalThis.WordLib;

test('解析：课本格式、词性、说明、例句', () => {
  assert.deepEqual(W.parseLine('school n. （中、小）学校'), { en: 'school', pos: 'n.', cn: '（中、小）学校', note: '', ex: '', exCn: '' });
  assert.equal(W.parseLine('play sports 运动').en, 'play sports');
  assert.equal(W.parseLine('play sports 运动').pos, '');
  const leaf = W.parseLine('leaf (pl. leaves) n. 叶子');
  assert.equal(leaf.en, 'leaf');
  assert.equal(leaf.note, '(pl. leaves)');
  const ex = W.parseLine('school n. 学校 | I go to school every day. | 我每天去上学。');
  assert.equal(ex.ex, 'I go to school every day.');
  assert.equal(ex.exCn, '我每天去上学。');
  assert.equal(W.parseLine("What's wrong? 出什么事了？").en, "What's wrong?");
  assert.equal(W.parseLine('Walk straight for 200 meters, then turn left. 直走 200 米').en, 'Walk straight for 200 meters, then turn left.');
  assert.equal(W.parseLine('cat 猫 🐱').cn, '猫'); // 旧格式行末的 emoji 被忽略
  assert.equal(W.parseLine('# 注释'), null);
  assert.equal(W.parseLine('   '), null);
});

test('解析：* 标记的词不挖空，* 不算进英文', () => {
  const w = W.parseLine("He's from *New *Zealand. 他来自新西兰。");
  assert.equal(w.en, "He's from New Zealand.");
  assert.equal(w.fixed.map(i => w.en[i]).join(''), 'NewZealand');
  assert.equal(W.parseLine('school n. 学校').fixed, undefined);
  assert.ok(W.parseLine('a*b 错').error);
});

test('格式检查：错误、重复、缺中文、例句问题', () => {
  const { words, problems } = W.analyze([
    'apple n. 苹果 | I like bananas. | 我喜欢香蕉。',
    'apple 苹果',
    'pear',
    '苹果 apple',
    'cat 猫 | | 只有翻译',
    '*James 詹姆斯',
  ].join('\n'));
  assert.deepEqual(words.map(w => w.en), ['apple', 'pear', 'cat', 'James']);
  const msg = n => problems.filter(p => p.line === n).map(p => p.msg).join('；');
  assert.match(msg(1), /例句里没有出现这个单词/);
  assert.match(msg(2), /与第 1 行重复/);
  assert.match(msg(3), /缺少中文释义/);
  assert.equal(problems.find(p => p.line === 4).level, 'error');
  assert.match(msg(5), /只有例句翻译/);
  assert.match(msg(6), /所有词都加了 \*/);
  assert.equal(words[3].fixed, undefined); // 整条都加 * 时忽略 *
  assert.equal(W.parse('﻿dog 狗').length, 1); // 去掉 BOM
});

// 用固定的随机序列多试几次，覆盖不同的随机结果
function repeat(n, fn) {
  let seed = 1;
  W.setRandom(() => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; });
  try { for (let i = 0; i < n; i++) fn(i); } finally { W.setRandom(); }
}
const letters = s => [...s].map((c, i) => (W.isLetter(c) ? i : -1)).filter(i => i >= 0);

test('挖空：单个单词挖 2 个，至少 1 个元音；很短的词挖 1 个', () => {
  repeat(200, () => {
    const b = W.blanksFor('school', 'easy');
    assert.equal(b.length, 2);
    assert.ok(b.some(i => 'aeiou'.includes('school'[i])));
    assert.deepEqual(b, [...b].sort((x, y) => x - y));
    assert.equal(W.blanksFor('go', 'easy').length, 1);
    const y = W.blanksFor('dry', 'easy');
    assert.ok(y.includes(2)); // 没有 aeiou 时用 y
  });
});

test('挖空：短语约每 4 个字母 1 个（2–8 个），只挖字母，尽量不相邻', () => {
  repeat(200, () => {
    const w = 'Make a plan and follow it.';
    const b = W.blanksFor(w, 'easy');
    assert.equal(b.length, Math.min(8, Math.max(2, Math.round(letters(w).length / 4))));
    b.forEach(i => assert.ok(W.isLetter(w[i])));
    assert.equal(W.blanksFor('A very very very long sentence with lots and lots of letters in it.', 'easy').length, 8);
  });
});

test('挖空：进阶挖一半，听写挖全部', () => {
  repeat(50, () => {
    assert.equal(W.blanksFor('teacher', 'medium').length, 4);
    assert.deepEqual(W.blanksFor("What's wrong?", 'dictation'), letters("What's wrong?"));
  });
});

test('挖空：* 标记的字母在任何难度都不挖', () => {
  const w = W.parseLine('Children, this is *James. 孩子们，这是詹姆斯。');
  const james = new Set(w.fixed);
  repeat(300, i => {
    const lv = ['easy', 'medium', 'dictation'][i % 3];
    const b = W.blanksFor(w.en, lv, w.fixed);
    assert.ok(b.length > 0);
    b.forEach(k => assert.ok(!james.has(k), lv + ' 挖到了 James'));
  });
});

test('挖空上限：简单和进阶最多挖 maxBlanks 个，听写不限', () => {
  const s = 'Walk straight for 200 meters, then turn left.';
  repeat(100, () => {
    assert.equal(W.blanksFor(s, 'medium', null, 4).length, 4);
    assert.equal(W.blanksFor(s, 'easy', null, 3).length, 3);
    assert.equal(W.blanksFor(s, 'easy', null, 30).length, 8, '简单难度本来最多 8 个');
    assert.equal(W.blanksFor(s, 'dictation', null, 2).length, letters(s).length);
    const one = W.blanksFor('school', 'easy', null, 1);
    assert.equal(one.length, 1);
    assert.ok('aeiou'.includes('school'[one[0]]), '只挖 1 个时挖元音');
    assert.equal(W.blanksFor('school', 'easy').length, 2, '不设上限时和原来一样');
  });
});

test('自动难度：按熟练度选择', () => {
  assert.equal(W.autoLevel(undefined), 'easy');
  assert.equal(W.autoLevel({ right: 1 }), 'easy');
  assert.equal(W.autoLevel({ right: 2 }), 'medium');
  assert.equal(W.autoLevel({ right: 5 }), 'dictation');
  assert.equal(W.autoLevel({ right: 5, score: 2 }), 'easy'); // 最近还在错
  // 每个孩子可以设置升级次数
  assert.equal(W.autoLevel({ right: 2 }, { med: 3, dict: 6 }), 'easy');
  assert.equal(W.autoLevel({ right: 3 }, { med: 3, dict: 6 }), 'medium');
  assert.equal(W.autoLevel({ right: 6 }, { med: 3, dict: 6 }), 'dictation');
  assert.equal(W.autoLevel({ right: 1 }, { med: 1, dict: 2 }), 'medium');
});

test('熟练度与间隔复习：1、2、4、7、15、30 天', () => {
  const at = d => d + 'T02:00:00.000Z'; // 北京时间上午 10 点
  const w = {};
  W.applyAnswer(w, true, at('2026-01-01'));
  assert.deepEqual([w.right, w.score, w.lvl, w.due], [1, 0, 1, '2026-01-02']);
  W.applyAnswer(w, true, at('2026-01-01')); // 没到期答对：不升级
  assert.equal(w.lvl, 1);
  const days = ['2026-01-02', '2026-01-04', '2026-01-08', '2026-01-15', '2026-01-30'];
  const expect = ['2026-01-04', '2026-01-08', '2026-01-15', '2026-01-30', '2026-03-01'];
  days.forEach((d, i) => { W.applyAnswer(w, true, at(d)); assert.equal(w.due, expect[i]); assert.equal(w.lvl, i + 2); });
  W.applyAnswer(w, true, at('2026-03-01'));
  assert.equal(w.mastered, true);
  assert.equal(W.isDue(w, '2026-12-31'), false);
  W.applyAnswer(w, false, at('2026-03-02')); // 已掌握的按第 6 级算，退 2 级
  assert.deepEqual([w.mastered, w.lvl, w.due, w.score], [false, 4, '2026-03-03', 2]);
  W.applyAnswer(w, false, at('2026-03-02'), true, true); // 同一题再错：只记次数，不加分、不退级
  assert.deepEqual([w.score, w.wrong, w.lvl], [2, 2, 4]);
  assert.equal(W.isDue(w, '2026-03-03'), true);
  W.applyAnswer(w, true, at('2026-03-03')); // 明天答对：升回第 5 级，15 天后复习
  assert.deepEqual([w.lvl, w.due], [5, '2026-03-18']);
});

test('答错退 2 级：最低第 1 级；同一道题只退一次；没学过的词进入第 1 级', () => {
  const at = '2026-05-01T02:00:00.000Z';
  const lv = (lvl, repeat) => W.applyAnswer({ lvl, due: '2026-05-01', score: 0, wrong: 0, right: 0 }, false, at, false, repeat);
  assert.equal(lv(6).lvl, 4);
  assert.equal(lv(3).lvl, 1);
  assert.equal(lv(2).lvl, 1);
  assert.equal(lv(1).lvl, 1);
  assert.equal(lv(5, true).lvl, 5, '同一题第 2 次答错不再退级');
  const fresh = W.applyAnswer({}, false, at);
  assert.deepEqual([fresh.lvl, fresh.due, fresh.score], [1, '2026-05-02', 2]);
  const freshRepeat = W.applyAnswer({}, false, at, false, true);
  assert.equal(freshRepeat.lvl, 1);
});

test('北京时间日期', () => {
  assert.equal(W.bjDate('2026-01-01T15:59:59Z'), '2026-01-01');
  assert.equal(W.bjDate('2026-01-01T16:00:00Z'), '2026-01-02');
  assert.equal(W.addDays('2026-02-28', 1), '2026-03-01');
});

test('打卡：连续天数、最长、累计', () => {
  const days = { '2026-01-01': 20, '2026-01-02': 25, '2026-01-03': 5, '2026-01-04': 20, '2026-01-05': 30 };
  let c = W.checkin(days, 20, '2026-01-05');
  assert.deepEqual([c.todayCount, c.doneToday, c.streak, c.best, c.total], [30, true, 2, 2, 4]);
  c = W.checkin(days, 20, '2026-01-06'); // 今天还没完成：看到昨天为止
  assert.deepEqual([c.doneToday, c.streak], [false, 2]);
  c = W.checkin(days, 5, '2026-01-05'); // 目标改小后重新评估每一天
  assert.deepEqual([c.streak, c.best, c.total], [5, 5, 5]);
});

test('答题时记下第一次和最近一次的日期', () => {
  const w = {};
  W.applyAnswer(w, false, '2026-05-01T02:00:00Z');
  W.applyAnswer(w, true, '2026-05-03T02:00:00Z');
  assert.deepEqual([w.first, w.last], ['2026-05-01', '2026-05-03']);
  const old = { right: 3, wrong: 0, lvl: 2, due: '2026-05-01' }; // 旧数据没有 first：不补
  W.applyAnswer(old, true, '2026-05-03T02:00:00Z');
  assert.deepEqual([old.first, old.last], [undefined, '2026-05-03']);
});

test('学新词：新词数 = min(上限, 每天题量 − 今天的复习数) − 今天学过的，按顺序挑没答过的词', () => {
  const T = '2026-06-10';
  const pool = Array.from({ length: 40 }, (_, i) => ({ en: 'w' + i }));
  const st = {};
  const learn = (i, first, extra = {}) => { st['w' + i] = { right: 1, wrong: 0, score: 0, lvl: 1, due: '2026-06-11', first, last: first, ...extra }; };
  let p = W.planNewWords(pool, st, { today: T, target: 30, cap: 5 });
  assert.deepEqual([p.status, p.quota, p.words.map(w => w.en).join()], ['ready', 5, 'w0,w1,w2,w3,w4']);
  // 以前学过 27 个，今天到期 27 个：先复习
  for (let i = 0; i < 27; i++) learn(i, '2026-06-01', { due: T });
  p = W.planNewWords(pool, st, { today: T, target: 30, cap: 5 });
  assert.deepEqual([p.status, p.quota, p.dueNow, p.plannedQuota], ['review-first', 0, 27, 3]);
  // 复习做完（last = 今天，下次复习在以后）：可以学 30 − 27 = 3 个，从 w27 开始
  for (let i = 0; i < 27; i++) st['w' + i] = { ...st['w' + i], due: '2026-06-12', last: T, lvl: 2 };
  p = W.planNewWords(pool, st, { today: T, target: 30, cap: 5 });
  assert.deepEqual([p.status, p.quota, p.words.map(w => w.en).join()], ['ready', 3, 'w27,w28,w29']);
  // 今天学了 2 个（答对或答错都算学过）：还能学 1 个；刷新、换设备结果一样
  learn(27, T); st.w28 = { right: 0, wrong: 1, score: 2, lvl: 1, due: '2026-06-11', first: T, last: T };
  p = W.planNewWords(pool, st, { today: T, target: 30, cap: 5 });
  assert.deepEqual([p.status, p.quota, p.words.map(w => w.en).join()], ['ready', 1, 'w29']);
  learn(29, T);
  assert.equal(W.planNewWords(pool, st, { today: T, target: 30, cap: 5 }).status, 'today-done');
  // 复习已经够量：今天只复习
  assert.equal(W.planNewWords(pool, st, { today: '2026-06-12', target: 20, cap: 5 }).status, 'review-first');
  const busy = {}; for (let i = 0; i < 30; i++) busy['w' + i] = { right: 1, wrong: 0, lvl: 2, due: '2026-07-01', first: '2026-06-01', last: T };
  assert.equal(W.planNewWords(pool, busy, { today: T, target: 30, cap: 5 }).status, 'review-only');
  // 上限 0：暂停；没有新词：学完
  assert.equal(W.planNewWords(pool, {}, { today: T, target: 30, cap: 0 }).status, 'paused');
  const all = {}; pool.forEach(w => { all[w.en] = { right: 1, lvl: 3, due: '2026-07-01', first: '2026-06-01' }; });
  assert.equal(W.planNewWords(pool, all, { today: T, target: 30, cap: 5 }).status, 'all-done');
});

test('朗读文字：去掉省略号、括号，sb./sth. 读全称，斜杠读成停顿', () => {
  assert.equal(W.sayText('ask... for help'), 'ask for help');
  assert.equal(W.sayText('help sb. with sth.'), 'help somebody with something');
  assert.equal(W.sayText('a/an (be) good at'), 'a, an be good at');
  assert.equal(W.sayText("It's time for school."), "It's time for school.");
  assert.equal(W.sayText('Walk straight for 200 meters, then turn left.'), 'Walk straight for 200 meters, then turn left.');
});

test('朗读单词：一词多音按词性纠正，过去式和例句不纠正', () => {
  assert.equal(W.sayWord({ en: 'read', pos: 'v.', cn: '阅读' }), 'reed');
  assert.equal(W.sayWord({ en: 'close', pos: 'v.', cn: '关；关闭' }), 'cloze');
  assert.equal(W.sayWord({ en: 'read', pos: 'v.', cn: '读（过去式）' }), 'read');
  assert.equal(W.sayWord({ en: 'close', pos: 'adj.', cn: '近的' }), 'close');
  assert.equal(W.sayWord({ en: 'read books', pos: '', cn: '读书' }), 'read books');
  assert.equal(W.sayWord({ en: 'school', pos: 'n.', cn: '学校' }), 'school');
});

test('挑声音：只用名单里的声音；联网时 Google US English 最先；美音、高级版和增强版优先；Samantha 放到美音最后；不用搞怪声音', () => {
  const v = (name, lang, voiceURI, localService = true) => ({ name, lang, voiceURI: voiceURI || name, localService });
  const albert = v('Albert', 'en-US'), zarvox = v('Zarvox', 'en-US'), eddy = v('Eddy (English (US))', 'en-US', 'com.apple.eloquence.en-US.Eddy');
  const sam = v('Samantha', 'en-US', 'com.apple.voice.compact.en-US.Samantha');
  const samEnh = v('Samantha (Enhanced)', 'en-US', 'com.apple.voice.enhanced.en-US.Samantha');
  const alex = v('Alex', 'en-US', 'com.apple.speech.synthesis.voice.Alex');
  const avaEnh = v('Ava (Enhanced)', 'en-US', 'com.apple.voice.enhanced.en-US.Ava');
  const daniel = v('Daniel (Enhanced)', 'en-GB', 'com.apple.voice.enhanced.en-GB.Daniel');
  const google = v('Google US English', 'en-US', 'Google US English', false);
  const tingting = v('Tingting', 'zh-CN');
  assert.equal(W.pickVoice([albert, zarvox, eddy, tingting]), null);          // 只有搞怪声音：不指定声音
  assert.equal(W.pickVoice([albert, sam, eddy]), sam);                        // 只有 Samantha 时还是用它
  assert.equal(W.pickVoice([sam, alex]), alex);                               // Samantha 放到美音最后
  assert.equal(W.pickVoice([samEnh, alex]), alex);
  assert.equal(W.pickVoice([sam, avaEnh, daniel]), avaEnh);                   // 增强版优先
  assert.equal(W.pickVoice([daniel, sam]), sam);                              // 美音优先于英音
  assert.equal(W.pickVoice([daniel, albert]), daniel);
  assert.equal(W.pickVoice([sam, avaEnh, google]), google);                  // 联网时 Google US English 最先
  assert.equal(W.pickVoice([sam, avaEnh, google], false), avaEnh);           // 没联网不用在线声音
  assert.equal(W.pickVoice([v('Samantha', 'en_US')]).name, 'Samantha');        // 有的设备写成 en_US
  assert.equal(W.pickVoice([v('Microsoft Aria Online (Natural) - English (United States)', 'en-US')]).name.startsWith('Microsoft Aria'), true);
  assert.equal(W.pickVoice([]), null);
});

test('学新词按分组：从选的分组里挑新词；数量按所有分组合计；先复习只看这个分组', () => {
  const today = '2026-10-05';
  const mk = ens => ens.map(en => ({ en }));
  const book = mk(['b1', 'b2', 'b3', 'b4']), ef = mk(['e1', 'e2', 'e3']);
  const pool = book.concat(ef);
  // 课本：b1 今天该复习；英孚：e1 今天刚学过（新词），其余都没答过
  const stats = {
    b1: { right: 1, wrong: 0, lvl: 1, due: today, first: '2026-10-01', last: '2026-10-04' },
    e1: { right: 1, wrong: 0, lvl: 1, due: '2026-10-06', first: today, last: today },
  };
  const opts = { target: 30, cap: 3, today };
  let p = W.planNewWords(pool, stats, { ...opts, scope: ef });
  assert.equal(p.status, 'ready', '课本有没做的复习，不挡英孚学新词');
  assert.deepEqual(p.words.map(w => w.en), ['e2', 'e3'], '只从英孚挑；今天两个分组一共还能学 3 − 1 = 2 个');
  p = W.planNewWords(pool, stats, { ...opts, scope: book });
  assert.equal(p.status, 'review-first', '课本自己有该复习的，先复习');
  stats.e2 = { right: 1, wrong: 0, lvl: 1, due: '2026-10-06', first: today, last: today };
  stats.e3 = { right: 1, wrong: 0, lvl: 1, due: '2026-10-06', first: today, last: today };
  p = W.planNewWords(pool, stats, { ...opts, scope: ef });
  assert.equal(p.status, 'all-done', '英孚的新词都学完了');
  delete stats.b1;
  p = W.planNewWords(pool, stats, { ...opts, scope: book });
  assert.equal(p.status, 'today-done', '今天在英孚学满了 3 个，课本今天也不能再学');
});

