#!/bin/bash
# 双击启动本地服务器，在电脑浏览器中打开；同一 Wi-Fi 下的 iPad 也可访问
cd "$(dirname "$0")/网站发布"
PORT=8000
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
echo "========================================"
echo " 单词拼写练习 已启动"
echo " 电脑访问： http://localhost:$PORT"
[ -n "$IP" ] && echo " iPad 访问（同一 Wi-Fi）： http://$IP:$PORT"
echo " 关闭此窗口即可停止"
echo "========================================"
(sleep 1; open "http://localhost:$PORT") &
python3 -m http.server $PORT
