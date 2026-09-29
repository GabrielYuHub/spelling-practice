// 帮助页截图：用无界面 Chrome（调试协议）打开本地测试版，按 iPad 横屏尺寸截图。用法见 run.sh
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const OUT = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = fs.mkdtempSync('/tmp/chrome-shot-');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + profile, '--no-first-run', '--no-proxy-server', '--hide-scrollbars', '--lang=zh-CN', 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 50; i++) { try { targets = await (await fetch('http://127.0.0.1:9334/json/list')).json(); if (targets.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: '(async()=>{' + expr + '})()', awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description)); return r.result.result.value; };
const W = 1180, H = 820;
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
const go = async (url, wait = 1500) => { await send('Page.navigate', { url }); await sleep(wait); };
const shot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!clip, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  fs.writeFileSync(OUT + '/' + name + '.png', Buffer.from(r.result.data, 'base64')); console.log('✓', name);
};
const rect = async (sel, maxH) => ev(`const e=${sel}; const r=e.getBoundingClientRect(); return {x:Math.max(0,r.x-10), y:Math.max(0,r.y+scrollY-10), width:Math.min(${W},r.width+20), height:Math.min(${maxH || 4000}, r.height+20)};`);
const B = 'http://localhost:8770/';
const KIDS = await (await fetch(B + 'api/app?op=config')).json();
const hong = KIDS.children.find(c => c.name === '小红').id;
// 屏蔽朗读（无界面浏览器没有语音）
const noSpeech = `speechSynthesis.speak = u => { window.__last = u.text; setTimeout(() => u.onend && u.onend(), 50); }; speechSynthesis.cancel = () => {};`;

// ① 你是谁 ② PIN
await go(B); await ev(`localStorage.clear()`); await go(B, 2000);
await shot('kid-who');
await ev(`[...document.querySelectorAll('#cards .card')].find(c => c.innerText.includes('小明')).click(); await new Promise(r=>setTimeout(r,300)); for (const k of '12') document.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));`);
await sleep(600); await shot('kid-pin');
// ③ 选表页（小明）
await ev(`for (const k of '34') document.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));`); await sleep(2500);
await shot('kid-pick', await rect("document.getElementById('pickView')", 1400));
// ③-2 学单词：列表、翻卡片（小明，课本三上）
await ev(noSpeech + `[...document.querySelectorAll('#cards .card')].find(c => c.innerText.includes('课本三上')).click();`); await sleep(800);
await shot('kid-study-list');
await ev(`document.querySelector('#studyModes button[data-m=card]').click(); await new Promise(r=>setTimeout(r,200)); document.getElementById('fcNext').click(); await new Promise(r=>setTimeout(r,200)); document.getElementById('flash').click();`); await sleep(1000);
await shot('kid-study-card');
// ④ 学新词单词列表（小红） ⑤ 答题 ⑥ 例句
await ev(`localStorage.setItem('spell_session', JSON.stringify({child:${JSON.stringify(hong)},pin:'5678',name:'小红'}))`);
await go(B, 2500);
await ev(noSpeech + `[...document.querySelectorAll('#cards .card')].find(c => c.innerText.includes('学新词')).click();`); await sleep(1200);
await shot('kid-preview');
await ev(noSpeech + `document.getElementById('studyStart').click();`); await sleep(1200);
await ev(`const w=window.__last, chs=[...document.querySelectorAll('#word .ch')]; const slots=chs.map((c,i)=>c.classList.contains('slot')?i:-1).filter(i=>i>=0); document.dispatchEvent(new KeyboardEvent('keydown',{key:w[slots[0]],bubbles:true}));`);
await sleep(500); await shot('kid-game');
await ev(`const w=window.__last, chs=[...document.querySelectorAll('#word .ch')]; chs.forEach((c,i)=>{ if (c.classList.contains('slot') && c.textContent.trim()==='' ) document.dispatchEvent(new KeyboardEvent('keydown',{key:w[i],bubbles:true})); }); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
await sleep(2000); await shot('kid-example');
// ⑦ 答错后的提示
await sleep(2500);
await ev(`const w=window.__last, chs=[...document.querySelectorAll('#word .ch')]; let k=0; chs.forEach((c,i)=>{ if (c.classList.contains('slot')) document.dispatchEvent(new KeyboardEvent('keydown',{key: k++===0 ? w[i] : (w[i]==='z'?'x':'z'),bubbles:true})); }); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
await sleep(1500); await shot('kid-wrong'); // 答错后：填对的保留，填错的标红，出现“看答案”

// 管理页
await go(B + 'editor.html', 1200);
await ev(`const p=document.getElementById('pwd'); p.readOnly=false; p.value='demo-pw'; document.getElementById('gateBtn').click();`); await sleep(1800);
// ⑧ 单词表：分组展开 + 管理菜单
await ev(`const g=name=>[...document.querySelectorAll('#listNav li.grp')].find(li=>li.querySelector('.gtoggle').innerText.includes(' '+name)); g('英孚三上').querySelector('.gmenu-btn').click();`); await sleep(500);
await shot('parent-lists', await rect("document.getElementById('listNav').closest('.card')"));
// ⑨ 选择文件导入预览
await ev(`const dt=new DataTransfer(); dt.items.add(new File(['## 英孚三上 Unit 7 Space\\nplanet n. 行星 | We live on a planet. | 我们住在一颗行星上。\\nrocket n. 火箭\\n## 课本三上 Unit 1\\nnew adj. 新的\\n'],'英孚三上新单元.txt')); dt.items.add(new File(['apple n. 苹果\\nbanana n. 香蕉\\n1234 坏行\\n'],'课外 水果.txt')); const inp=document.getElementById('fileInput'); inp.files=dt.files; inp.dispatchEvent(new Event('change'));`); await sleep(800);
await ev(`document.getElementById('fileBtn').scrollIntoView({block:'start'}); window.scrollBy(0,-20);`); await sleep(300);
await shot('parent-import', await rect("document.getElementById('fileBtn').closest('.card')", 760));
// ⑩ 孩子设置
await ev(`window.scrollTo(0,0); document.querySelector('.tab[data-tab=kids]').click();`); await sleep(600);
await shot('parent-kids', await rect("document.querySelector('#tab-kids .card')"));
// ⑪ 学习报表
await ev(`document.querySelector('.tab[data-tab=records]').click();`); await sleep(1500);
await shot('parent-report', await rect("document.querySelector('#tab-records .card')"));

ws.close(); chrome.kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
