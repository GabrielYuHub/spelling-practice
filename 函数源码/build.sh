#!/bin/bash
# 打包 CloudBase 云函数（业务逻辑 src/core.js，平台适配 src/cloudbase.js）
#
# 用法：./build.sh cloudbase <管理密码> [mock <输出文件>]
#   ./build.sh cloudbase 你的密码   → ../CloudBase发布/app.zip（上传到 CloudBase 云函数 app）
#   加 “mock <输出文件>”：用内存模拟数据库打包，仅供本地测试
#
# 第一次运行会自动 npm install（安装 esbuild 和 CloudBase SDK 到 node_modules/，可随时删除）
# 打包前会先运行自动化测试（npm test），测试不通过就不生成 app.zip；SKIP_TESTS=1 ./build.sh … 可以跳过
set -e
cd "$(dirname "$0")"
PLATFORM="$1"; PWD_VAL="$2"; MODE="$3"; MOCK_OUT="$4"
if [ -z "$PLATFORM" ] || [ -z "$PWD_VAL" ]; then
  echo "用法：./build.sh cloudbase <管理密码> [mock <输出文件>]"; exit 1
fi
[ -d node_modules ] || npm install --no-audit --no-fund --silent
# 打包正式版之前先跑自动化测试（test/），不通过就不生成 app.zip；紧急时可以用 SKIP_TESTS=1 跳过
if [ "$MODE" != "mock" ] && [ "$PLATFORM" = "cloudbase" ] && [ -z "$SKIP_TESTS" ]; then
  echo "正在运行自动化测试…"
  if ! npm test --silent > .test.log 2>&1; then
    grep -E "^✖|Error|actual|expected" .test.log | head -30
    echo "❌ 自动化测试没有通过，没有生成 app.zip。完整结果见 函数源码/.test.log"
    exit 1
  fi
  echo "✅ $(grep -E '^ℹ pass' .test.log | sed 's/ℹ pass /测试全部通过：/') 项"
  rm -f .test.log
fi
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
    node tools/make-assets.js "$SITE" .build/assets.js
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
