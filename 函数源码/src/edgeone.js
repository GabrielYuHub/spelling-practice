// EdgeOne Pages 适配层：云函数 /api/app，数据存 Blob（空间 spelling）
// PASSWORD 在打包时通过文件开头的配置注入
import { getStore } from 'pages-blob';
import { handleGet, handlePost } from './core.js';

function env(request) {
  return {
    store: getStore({ name: 'spelling', consistency: 'strong' }),
    password: PASSWORD,
    // 首次初始化时读取本站的 words.js
    async loadDefaultWords() {
      try {
        const r = await fetch(new URL('/words.js', request.url));
        if (!r.ok) return null;
        const m = (await r.text()).match(/WORDS\s*=\s*`([\s\S]*)`/);
        return m ? m[1].replace(/^\s*\n/, '') : null;
      } catch (e) {
        return null;
      }
    },
  };
}

function respond({ status, data }) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function onRequestGet({ request }) {
  return respond(await handleGet(env(request), new URL(request.url).searchParams));
}

export async function onRequestPost({ request }) {
  return respond(await handlePost(env(request), await request.text()));
}
