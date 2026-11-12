// issue 0024 步驟 1：受控 fixture。正文是預先寫好的字面值，探測只比對這些字串。
import http from 'node:http';

const port = Number(process.env.PORT || 8080);
const pages = {
  '/static': '<!doctype html><title>static</title><main>ISSUE24_HTTP_BODY_20261112</main>',
  // 正文只在 inline script 執行後出現。
  '/js': '<!doctype html><title>js</title><main id="b">WAITING</main><script>document.querySelector("#b").textContent="ISSUE24_JS_BODY_20261112"</script>',
  // 正文要等計時器與 fetch 回來才出現。
  '/js-async': '<!doctype html><title>js-async</title><main id="b">WAITING</main><script>setTimeout(()=>fetch("/api").then(r=>r.json()).then(j=>{document.querySelector("#b").textContent=j.text}),800)</script>',
  // ES module 寫入正文。
  '/js-module': '<!doctype html><title>js-module</title><main id="b">WAITING</main><script type="module">import {text} from "/mod.js"; document.querySelector("#b").textContent=text;</script>',
  // script 拋錯，正文永遠是殼層。
  '/shell': '<!doctype html><title>shell</title><main id="b">WAITING</main><script>throw new Error("boom")</script>',
  // 使用 IndexedDB 與 localStorage：檢查沒有 --profile-dir 時寫到哪裡。
  '/idb': '<!doctype html><title>idb</title><main id="b">WAITING</main><script>localStorage.setItem("k","v");const r=indexedDB.open("issue24",1);r.onupgradeneeded=()=>r.result.createObjectStore("s");r.onsuccess=()=>{const tx=r.result.transaction("s","readwrite");tx.objectStore("s").put("x".repeat(200000),"k");tx.oncomplete=()=>{document.querySelector("#b").textContent="ISSUE24IDBBODY"}}</script>',
  // 正文在 3 秒後才出現，中間沒有網路活動。
  '/js-late': '<!doctype html><title>js-late</title><main id="b">WAITING</main><script>setTimeout(()=>{document.querySelector("#b").textContent="ISSUE24LATEBODY"},3000)</script>',
  // 一直變動的頁面：每 100ms 更新一次計數。
  '/ticker': '<!doctype html><title>ticker</title><main>ISSUE24TICKERBODY <span id="n">0</span></main><script>let i=0;setInterval(()=>{document.querySelector("#n").textContent=++i},100)</script>',
  // 寫入 IndexedDB 後持續變動，讓 Moli 在暫存檔存在時被中斷。
  '/idb-hold': '<!doctype html><title>idb-hold</title><main id="b">WAITING</main><script>const r=indexedDB.open("issue24",1);r.onupgradeneeded=()=>r.result.createObjectStore("s");r.onsuccess=()=>{const tx=r.result.transaction("s","readwrite");tx.objectStore("s").put("x".repeat(200000),"k");tx.oncomplete=()=>{let i=0;setInterval(()=>{document.querySelector("#b").textContent="ISSUE24IDBHOLD "+(++i)},100)}}</script>',
  // body 為空：檢查 Markdown 輸出是否為空。
  '/empty': '<!doctype html><title></title><body></body>',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ text: 'ISSUE24_JS_ASYNC_BODY_20261112' }));
  }
  if (url.pathname === '/mod.js') {
    res.setHeader('content-type', 'text/javascript');
    return res.end('export const text = "ISSUE24_JS_MODULE_BODY_20261112";');
  }
  if (url.pathname === '/hang') {
    // 送出標頭與部分內容後永不結束。
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<!doctype html><title>hang</title><main>PARTIAL');
    return;
  }
  if (url.pathname === '/slow-api') {
    // 4 秒後才回應的 API。
    setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: 'ISSUE24SLOWAPIBODY' })); }, 4000);
    return;
  }
  if (url.pathname === '/js-slow-api') {
    res.setHeader('content-type', 'text/html');
    return res.end('<!doctype html><title>js-slow-api</title><main id="b">WAITING</main><script>fetch("/slow-api").then(r=>r.json()).then(j=>{document.querySelector("#b").textContent=j.text})</script>');
  }
  if (url.pathname === '/hang-js') {
    // 文件完整，但 script 持續發出永不回應的請求。
    res.setHeader('content-type', 'text/html');
    return res.end('<!doctype html><title>hang-js</title><main id="b">WAITING</main><script>fetch("/hang").then(()=>{document.querySelector("#b").textContent="never"})</script>');
  }
  const body = pages[url.pathname];
  if (!body) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(body);
}).listen(port, '0.0.0.0', () => console.log(`fixture listening on ${port}`));
