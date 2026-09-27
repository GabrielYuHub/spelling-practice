#!/bin/bash
# 重新生成“使用说明”（网站发布/help.html）里的截图
# 需要：Node.js、Google Chrome（/Applications 下）、Python 3 + Pillow（pip3 install pillow）
# 做法：打包一个用内存数据库的测试版云函数 → 在 8770 端口启动 → 放入虚构的示例数据（孩子“小明”“小红”、课本和英孚单词表、几天的练习记录）
#       → 用无界面 Chrome 按 iPad 横屏尺寸截图 → 转成 WebP 存到 网站发布/help/
# 用法：函数源码/tools/help-shots/run.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
FN="$HERE/../.."            # 函数源码/
ROOT="$FN/.."               # 项目根目录
if curl -s -o /dev/null --max-time 2 http://localhost:8770/; then
  echo "❌ 8770 端口已经被占用（可能是另一个本地测试服务器），请先关掉它"; exit 1
fi
TMP="$(mktemp -d)"
trap 'kill $SERVER 2>/dev/null; rm -rf "$TMP"' EXIT
( cd "$FN" && ./build.sh cloudbase demo-pw mock "$TMP/app.cjs" >/dev/null )
node "$HERE/server.cjs" "$TMP/app.cjs" > "$TMP/server.log" 2>&1 & SERVER=$!
sleep 1
node "$HERE/seed-demo.mjs" "$ROOT" > /dev/null
mkdir -p "$TMP/shots"
node "$HERE/capture.mjs" "$TMP/shots"
python3 - "$TMP/shots" "$ROOT/网站发布/help" <<'PY'
import os, sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
for f in sorted(os.listdir(src)):
    im = Image.open(os.path.join(src, f)).convert('RGB')
    if im.width > 1400: im = im.resize((1400, int(im.height * 1400 / im.width)), Image.LANCZOS)
    out = os.path.join(dst, 'help-' + f.replace('.png', '.webp'))
    im.save(out, 'WEBP', quality=78, method=6)
    print('✓', os.path.basename(out), os.path.getsize(out) // 1024, 'KB')
PY
