// 词库解析：练习页、管理页和云函数共用
// 每行一个，采用课本格式：英文 词性. 中文，例如
//   school n. （中、小）学校
//   play sports 运动                （词性可省略）
//   leaf (pl. leaves) n. 叶子       （英文后的括号是补充说明，不用拼写）
//   What's wrong? 出什么事了？      （短语、句子：只挖字母，标点直接显示）
//   school n. 学校 | I go to school every day. | 我每天去上学。   （可选：| 例句 | 例句翻译）
//   Children, this is *James. 孩子们，这是詹姆斯。   （词前加 * ：人名、地名等不挖空，* 不显示）
// # 开头为注释；旧格式行末的 emoji 会被忽略
(() => {
  const isLetter = c => /^[A-Za-z]$/.test(c);
  const hasCJK = s => /[　-〿㐀-鿿＀-￯]/.test(s);
  const POS_RE = /^(n|v|vt|vi|adj|adv|prep|conj|pron|num|art|interj|aux|abbr)\.$/i;
  const EN_TOKEN = /^\*?[A-Za-z0-9'’.,!?…\-]+$/; // 开头的 * 表示这个词不挖空
  const EN_FULL = /^[A-Za-z][A-Za-z0-9'’.,!?…\- ]*$/;

  function parseLine(raw) {
    const full = String(raw).trim();
    if (!full || full.startsWith('#')) return null;
    const parts = full.split('|').map(x => x.trim());
    const line = parts[0];
    const ex = parts[1] || '', exCn = parts.slice(2).join(' ').trim();
    if (!line) return { error: '“|”前面要先写单词' };
    const tokens = line.split(/\s+/);
    // 去掉行末的 emoji（旧格式）
    while (tokens.length > 1 && !hasCJK(tokens[tokens.length - 1]) && !/[A-Za-z0-9]/.test(tokens[tokens.length - 1])) tokens.pop();

    const en = [], notes = [];
    let i = 0;
    for (; i < tokens.length; i++) {
      const t = tokens[i];
      if (POS_RE.test(t) || hasCJK(t)) break;
      if (t.startsWith('(')) {                       // 括号说明，如 (pl. leaves)
        const parts = [t];
        while (!parts[parts.length - 1].endsWith(')') && i + 1 < tokens.length && !hasCJK(tokens[i + 1])) parts.push(tokens[++i]);
        notes.push(parts.join(' '));
        continue;
      }
      if (!EN_TOKEN.test(t)) break;
      en.push(t);
    }
    // 去掉 * 标记，记下这些词里字母的位置（fixed：练习时不挖空）
    const fixed = [];
    let at = 0;
    const clean = en.map(t => {
      const star = t.startsWith('*');
      if (star) t = t.slice(1);
      if (star) [...t].forEach((c, k) => { if (isLetter(c)) fixed.push(at + k); });
      at += t.length + 1;
      return t;
    });
    const word = clean.join(' ');
    if (!word || !EN_FULL.test(word)) return { error: '英文部分只能包含字母、空格和常用标点，并且要以字母开头（* 只能加在词的开头）' };
    let pos = '';
    if (i < tokens.length && POS_RE.test(tokens[i])) pos = tokens[i++];
    const w = { en: word, pos, cn: tokens.slice(i).join(' '), note: notes.join(' '), ex, exCn };
    if (fixed.length) w.fixed = fixed;
    return w;
  }

  function parse(text) {
    return analyze(text).words;
  }

  // 返回解析出的单词，以及每行的问题（错误的行会被跳过，警告的行仍会使用）
  function analyze(text) {
    const words = [], problems = [], seen = new Map();
    String(text || '').replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
      const w = parseLine(raw);
      if (!w) return;
      const line = i + 1;
      if (w.error) { problems.push({ line, level: 'error', msg: w.error, text: raw.trim() }); return; }
      if (seen.has(w.en)) {
        problems.push({ line, level: 'warn', msg: '与第 ' + seen.get(w.en) + ' 行重复，练习时会忽略', text: raw.trim() });
        return;
      }
      if (!w.cn) problems.push({ line, level: 'warn', msg: '缺少中文释义', text: raw.trim() });
      if (w.fixed && [...w.en].every((c, k) => !isLetter(c) || w.fixed.includes(k))) {
        problems.push({ line, level: 'warn', msg: '所有词都加了 *，没有可以挖空的字母（练习时会忽略 *）', text: raw.trim() });
        delete w.fixed;
      }
      if (w.ex && !w.ex.toLowerCase().includes(w.en.toLowerCase())) problems.push({ line, level: 'warn', msg: '例句里没有出现这个单词（答对后无法高亮）', text: raw.trim() });
      if (!w.ex && w.exCn) problems.push({ line, level: 'warn', msg: '只有例句翻译，没有英文例句', text: raw.trim() });
      seen.set(w.en, line);
      words.push(w);
    });
    return { words, problems };
  }

  // ---------- 挖空规则（练习页用；rnd 可替换，方便测试） ----------
  // 单个单词：字母数 ≤2 空 1 个；否则空 2 个，其中至少 1 个元音（无 aeiou 时用 y，再没有就随机）
  // 短语/句子（含空格）：约每 4 个字母空 1 个，最少 2 个、最多 8 个，至少一半是元音，尽量不相邻
  // 难度：easy 简单（上面的规则）/ medium 进阶（挖一半字母）/ dictation 听写（全部字母）
  // fixed：单词表里加了 * 的词（人名、地名等）的字母位置，任何难度都不挖空
  let rnd = Math.random;
  const rand = n => Math.floor(rnd() * n);
  const pick = arr => arr[rand(arr.length)];
  const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = rand(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  const isVowel = c => 'aeiou'.includes(c.toLowerCase());
  function pickSpread(pool, k, chosen) {
    const near = i => chosen.some(j => Math.abs(i - j) <= 1);
    const order = shuffle(pool.filter(i => !chosen.includes(i)));
    for (const i of order) if (k > 0 && !near(i)) { chosen.push(i); k--; }
    for (const i of order) if (k > 0 && !chosen.includes(i)) { chosen.push(i); k--; }
  }
  const letterIdx = (word, fixed) => [...word].map((c, i) => isLetter(c) && !(fixed && fixed.includes(i)) ? i : -1).filter(i => i >= 0);
  // 挖 n 个空：至少一半是元音，尽量不相邻
  function pickN(word, letters, n) {
    let vowels = letters.filter(i => isVowel(word[i]));
    if (!vowels.length) vowels = letters.filter(i => word[i].toLowerCase() === 'y');
    const chosen = [];
    pickSpread(vowels, Math.ceil(n / 2), chosen);
    pickSpread(letters, n - chosen.length, chosen);
    return chosen.sort((a, b) => a - b);
  }
  function pickBlanks(word, letters, cap) {
    if (letters.length <= 2) return [pick(letters)];
    if (word.includes(' ')) return pickN(word, letters, Math.min(cap, 8, Math.max(2, Math.round(letters.length / 4))));
    let vowels = letters.filter(i => isVowel(word[i]));
    if (!vowels.length) vowels = letters.filter(i => word[i].toLowerCase() === 'y');
    const first = vowels.length ? pick(vowels) : pick(letters);
    if (cap < 2) return [first];
    const second = pick(letters.filter(i => i !== first));
    return [first, second].sort((a, b) => a - b);
  }
  // 返回要挖空的字符位置（升序）
  // maxBlanks：每道题最多挖几个字母（每个孩子可以设置），只对简单和进阶起作用，听写不限
  function blanksFor(word, lv, fixed, maxBlanks) {
    const letters = letterIdx(word, fixed);
    if (lv === 'dictation') return letters;
    const cap = maxBlanks >= 1 ? maxBlanks : Infinity;
    if (lv === 'medium') return letters.length <= 2 ? [pick(letters)] : pickN(word, letters, Math.min(cap, Math.ceil(letters.length / 2)));
    return pickBlanks(word, letters, cap);
  }
  // “自动”难度：还不熟（熟练度分数 > 0）用简单；累计答对 dict 次以上用听写，med 次以上用进阶（默认 2、4，每个孩子可以设置）
  function autoLevel(st, opts) {
    st = st || {};
    const med = (opts && opts.med) || 2, dict = (opts && opts.dict) || 4;
    if (st.score) return 'easy';
    if ((st.right || 0) >= dict) return 'dictation';
    if ((st.right || 0) >= med) return 'medium';
    return 'easy';
  }

  // ---------- 熟练度与间隔复习（练习页和云函数共用，保证两边算法一致） ----------
  // 每个单词的统计：{ score, wrong, right, lastWrong, lvl, due, mastered }
  //   score：熟练度分数，答错 +2、答对 -1（最低 0）
  //   lvl：复习等级 1–6（0 或没有表示还没进入复习计划）；due：下次复习日期（北京时间 YYYY-MM-DD）
  //   到期答对升一级；答错退 2 级（最低第 1 级）、明天复习
  //   mastered：通过第 6 级复习后为 true，不再提醒
  //   first：第一次答这个词的日期；last：最近一次答的日期（北京时间，用于“学新词”计算当天的计划）
  const INTERVALS = [1, 2, 4, 7, 15, 30];
  const bjDate = t => new Date((t == null ? Date.now() : new Date(t).getTime()) + 8 * 3600e3).toISOString().slice(0, 10);
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

  // noScore：同一道题第 3 次及以后的答错只记次数、不再加熟练度分数（每题最多 +4）
  // repeat：同一道题第 2 次及以后的答错，复习等级不再往下退（每道题最多退 2 级）
  function applyAnswer(w, ok, at, noScore, repeat) {
    const day = bjDate(at);
    if (!w.first && !(w.right || 0) && !(w.wrong || 0)) w.first = day;
    w.last = day;
    if (ok) {
      w.right = (w.right || 0) + 1;
      w.score = Math.max(0, (w.score || 0) - 1);
      if (w.mastered) return w;
      if (!w.lvl) { w.lvl = 1; w.due = addDays(day, INTERVALS[0]); }        // 第一次答对：进入复习计划
      else if (w.due && w.due <= day) {                                        // 到期答对：升级
        if (w.lvl >= INTERVALS.length) { w.mastered = true; w.due = null; }
        else { w.lvl += 1; w.due = addDays(day, INTERVALS[w.lvl - 1]); }
      }
    } else {
      w.wrong = (w.wrong || 0) + 1;
      if (!noScore) w.score = (w.score || 0) + 2;
      w.lastWrong = at || new Date().toISOString();
      // 答错：退 2 级（最低第 1 级；已掌握的按第 6 级算，退到第 4 级），明天复习
      if (!repeat) w.lvl = Math.max(1, (w.mastered ? INTERVALS.length : (w.lvl || 0)) - 2);
      w.lvl = w.lvl || 1;
      w.due = addDays(day, INTERVALS[0]); w.mastered = false;
    }
    return w;
  }
  const isDue = (w, today) => !!(w && w.lvl && !w.mastered && w.due && w.due <= (today || bjDate()));

  // ---------- 学新词：今天学几个、学哪几个 ----------
  // pool：孩子能练的单词（按单词表顺序去重）；stats：熟练度；opts：{ target 每天题量, cap 每天新词上限, today }
  // 今天的复习数 = 还没做的复习 + 今天已经做过的复习（以前学过、今天答过的词）；今天学过的新词 = first 是今天的词
  // 今天还能学的新词 = min(上限, 每天题量 − 今天的复习数) − 今天学过的新词，最少 0
  // 一天中途刷新页面、换设备，结果都一样
  const isNewWord = st => !st || (!(st.right || 0) && !(st.wrong || 0));
  function planNewWords(pool, stats, opts) {
    const today = opts.today || bjDate();
    const target = opts.target == null ? 30 : opts.target, cap = opts.cap == null ? 5 : opts.cap;
    let dueNow = 0, reviewedToday = 0, newToday = 0;
    const fresh = [];
    for (const w of pool) {
      const st = stats[w.en];
      if (isNewWord(st)) { fresh.push(w); continue; }
      if (st.first === today) newToday++;
      else if (isDue(st, today)) dueNow++;
      else if (st.last === today) reviewedToday++;
    }
    const reviews = dueNow + reviewedToday;
    const quota = Math.max(0, Math.min(cap, target - reviews) - newToday);
    let status;
    if (!cap) status = 'paused';                 // 上限为 0：暂停学新词
    else if (!fresh.length) status = 'all-done'; // 新词都学完了
    else if (dueNow) status = 'review-first';    // 先完成今日复习
    else if (quota) status = 'ready';
    else if (newToday) status = 'today-done';    // 今天的新词学完了
    else status = 'review-only';                 // 今天复习已经够量，只复习
    return { status, quota: status === 'ready' ? quota : 0, plannedQuota: quota, dueNow, reviews, newToday, remaining: fresh.length,
      words: status === 'ready' ? fresh.slice(0, quota) : [] };
  }

  // ---------- 每日打卡 ----------
  // days：{ 'YYYY-MM-DD'（北京时间）: 当天答对题数 }；goal：每日目标（按当前目标评估每一天）
  //   streak：连续打卡天数（今天已完成则包含今天；今天还没完成，就看到昨天为止是否连续）
  //   best：历史最长连续天数；total：累计打卡天数
  function checkin(days, goal, today) {
    days = days || {};
    goal = goal || 20;
    today = today || bjDate();
    const done = d => (days[d] || 0) >= goal;
    let streak = 0;
    for (let d = done(today) ? today : addDays(today, -1); done(d); d = addDays(d, -1)) streak++;
    const dates = Object.keys(days).filter(done).sort();
    let best = 0, run = 0, prev = null;
    for (const d of dates) {
      run = prev && addDays(prev, 1) === d ? run + 1 : 1;
      best = Math.max(best, run);
      prev = d;
    }
    return { todayCount: days[today] || 0, goal, doneToday: done(today), streak, best, total: dates.length };
  }
  const STREAK_BADGES = [3, 7, 14, 30, 100];
  const MASTER_BADGES = [10, 50, 100, 200];

  (typeof window !== 'undefined' ? window : globalThis).WordLib = { parse, analyze, parseLine, isLetter, blanksFor, planNewWords, isNewWord, autoLevel, setRandom: f => { rnd = f || Math.random; }, applyAnswer, isDue, bjDate, addDays, INTERVALS, checkin, STREAK_BADGES, MASTER_BADGES };
})();
