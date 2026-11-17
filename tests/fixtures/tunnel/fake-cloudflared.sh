#!/bin/sh
# issue 0030：測試用的假 cloudflared。FAKE_MODE 決定行為，FAKE_LOG 記錄每次啟動的參數。
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$FAKE_MODE" in
  exit-early) echo "ERR failed to request quick Tunnel" >&2; exit 1 ;;
  no-url) exec sleep 30 ;;
  url-then-exit) echo "INF |  https://fake-$$.trycloudflare.com  |" >&2; sleep 0.3; exit 0 ;;
  *) echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2
     echo "INF |  https://fake-$$.trycloudflare.com  |" >&2
     exec sleep 30 ;;
esac
