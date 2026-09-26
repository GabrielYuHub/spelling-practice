#!/bin/bash
# 打包 CloudBase 云函数（业务逻辑 src/core.js，平台适配 src/cloudbase.js）
#
# 用法：./build.sh cloudbase <管理密码> [mock <输出文件>]
#   ./build.sh cloudbase 你的密码   → ../CloudBase发布/app.zip（上传到 CloudBase 云函数 app）
#   加 “mock <输出文件>”：用内存模拟数据库打包，仅供本地测试
#
# 第一次运行会自动 npm install（安装 esbuild 和 CloudBase SDK 到 node_modules/，可随时删除）
set -e
cd "$(dirname "$0")"
PLATFORM="$1"; PWD_VAL="$2"; MODE="$3"; MOCK_OUT="$4"
if [ -z "$PLATFORM" ] || [ -z "$PWD_VAL" ]; then
  echo "用法：./build.sh cloudbase <管理密码> [mock <输出文件>]"; exit 1
fi
[ -d node_modules ] || npm install --no-audit --no-fund --silent
ESBUILD=./node_modules/.bin/esbuild
SITE=../网站发布
BANNER="// ============ 配置 ============
// 管理页（editor.html）的密码，修改后需重新部署
const PASSWORD = '${PWD_VAL}';
// ==============================
// 以下为自动生成代码（源码见 函数源码/src/），请勿直接修改"

case "$PLATFORM" in
  cloudbase)
    # 把网页文件内置进云函数（不依赖静态网站托管）
    mkdir -p .build
    python3 - "$SITE" .build/assets.js <<'PY'
import sys, json, os
site, out = sys.argv[1], sys.argv[2]
types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8'}
assets = {}
for name in ['index.html', 'editor.html', 'wordlib.js', 'words.js']:
    assets[name] = {'type': types[os.path.splitext(name)[1]], 'body': open(os.path.join(site, name), encoding='utf-8').read()}
open(out, 'w', encoding='utf-8').write('export default ' + json.dumps(assets, ensure_ascii=False) + ';\n')
PY
    OUT_DIR=../CloudBase发布/app
    OUT=$OUT_DIR/index.js
    TCB="@cloudbase/node-sdk"
    if [ "$MODE" = "mock" ]; then OUT="$MOCK_OUT"; TCB_ALIAS="--alias:@cloudbase/node-sdk=./src/mock-tcb.js"; fi
    mkdir -p "$(dirname "$OUT")"
    $ESBUILD src/cloudbase.js --bundle --format=cjs --platform=node --target=node16 \
      --alias:site-assets=./.build/assets.js $TCB_ALIAS --banner:js="$BANNER" --outfile="$OUT" --log-level=warning
    if [ "$MODE" != "mock" ]; then
      ( cd "$OUT_DIR" && rm -f ../app.zip && zip -q -X ../app.zip index.js )
      rm -rf "$OUT_DIR" .build   # 删掉中间文件，只留 app.zip
      echo "已生成：../CloudBase发布/app.zip（云函数 app，执行方法 index.main）"
    else
      rm -rf .build
      echo "已生成：$OUT"
    fi
    ;;

  *)
    echo "第一个参数请写 cloudbase（EdgeOne 版本已不再支持）"; exit 1 ;;
esac
