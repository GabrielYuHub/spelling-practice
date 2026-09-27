// 把网页文件打包成云函数里的 site-assets 模块（build.sh 和测试共用）
// 用法：node tools/make-assets.js <网站目录> <输出文件>
const fs = require('fs');
const path = require('path');

// 内置进云函数的网页文件：文件名 → 类型
const FILES = {
  'index.html': 'text/html; charset=utf-8',
  'editor.html': 'text/html; charset=utf-8',
  'wordlib.js': 'text/javascript; charset=utf-8',
  'words.js': 'text/javascript; charset=utf-8',
  'sw.js': 'text/javascript; charset=utf-8',
  'manifest.json': 'application/manifest+json; charset=utf-8',
  'icon-192.png': 'image/png',
  'icon-512.png': 'image/png',
  'apple-touch-icon.png': 'image/png',
};

function makeAssets(siteDir) {
  const assets = {};
  for (const [name, type] of Object.entries(FILES)) {
    const file = path.join(siteDir, name);
    // 图片等二进制文件存成 base64，返回时让 HTTP 网关解码
    assets[name] = type.startsWith('image/')
      ? { type, body: fs.readFileSync(file).toString('base64'), base64: true }
      : { type, body: fs.readFileSync(file, 'utf8') };
  }
  return assets;
}

function writeAssets(siteDir, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, 'export default ' + JSON.stringify(makeAssets(siteDir)) + ';\n');
}

module.exports = { FILES, makeAssets, writeAssets };
if (require.main === module) writeAssets(process.argv[2], process.argv[3]);
