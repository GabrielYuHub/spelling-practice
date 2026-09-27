// 离线缓存（Service Worker）：让网页在没有网络时也能打开
// 网页文件“先网络后缓存”：在线时总是取最新版本并更新缓存，4 秒没有回应或断网时用缓存里的版本
// 接口数据（/api/app）不经过这里，由练习页自己在本机保存（见 index.html 的离线数据）
const CACHE = 'spell-pages-v1';
const FILES = ['./', 'index.html', 'editor.html', 'wordlib.js', 'words.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const TIMEOUT = 4000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || /\/api\/app\/?$/.test(url.pathname)) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const net = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  net.catch(() => {}); // 超时后网络才失败时，不算未处理的错误
  const timeout = new Promise(resolve => setTimeout(resolve, TIMEOUT));
  try {
    const res = await Promise.race([net, timeout]);
    if (res) return res;
  } catch (err) { /* 断网：用缓存 */ }
  const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await cache.match('./'));
  if (hit) return hit;
  return net; // 没有缓存：继续等网络（可能报错）
}
