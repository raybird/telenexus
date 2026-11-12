#!/usr/bin/env bash
# issue 0024 步驟 6：觀測器的正負對照，在 runner 容器內執行，不呼叫模型。
# 每一步印一列 JSON（含開始與結束時間），分析時對照採樣紀錄與 fixture 紀錄，確認觀測器抓得到。
PUB=$1
step() { local name=$1; shift; local t0; t0=$(date +%s%3N); "$@" > /dev/null 2>&1; local code=$?; echo "{\"step\":\"$name\",\"t0\":$t0,\"t1\":$(date +%s%3N),\"exit\":$code}"; }
step idle sleep 3                                                        # 負對照：什麼都沒有
step wrapper telenexus-moli-fetch "http://$PUB:8080/s2/page"             # 正對照：wrapper＋moli、fixture 記到 moli
step tmp-leftover bash -c 'mkdir /tmp/tnm-control && sleep 2'            # 正對照：刻意不清理的暫存目錄
step tmp-removed rm -rf /tmp/tnm-control
step zombie bash -c 'sleep 0.2 & exec sleep 3'                           # 正對照：沒人收的子程序成為 zombie
step chrome timeout 20 /opt/telenexus/chrome/chrome-linux64/chrome --headless --no-sandbox --disable-dev-shm-usage --user-data-dir=/tmp/tnb-control --dump-dom "http://$PUB:8080/s2/page"  # 正對照：Chrome 程序、tnb- 目錄、fixture 記到 chrome
step chrome-profile-removed rm -rf /tmp/tnb-control
step curl curl -s "http://$PUB:8080/s2/page"                             # 對照：其他讀取者記成 other
step idle-end sleep 3                                                    # 負對照：全部收乾淨
