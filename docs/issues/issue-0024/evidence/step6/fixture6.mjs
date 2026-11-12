// issue 0024 步驟 6：受控 fixture。依 User-Agent 分辨讀取者（Moli、Chrome、其他＝webfetch），
// 每個請求記到 /out/fixture-requests.jsonl，作為「這個工作用了哪個工具」的觀測來源之一。
// JS 正文由頁面 script 帶自訂標頭向 /<case>/api 取得：原始 HTML 裡沒有正文字面值，
// 沒帶標頭直接讀 API 只會拿到 403，所以只有真的執行了 JavaScript 才讀得到。
import http from 'node:http';
import { appendFileSync } from 'node:fs';

// 2026-11-12 在 telenexus:issue24 內實測的 Moli v1.1.23 User-Agent。
const MOLI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.74 Safari/537.36';
const LOG = process.env.LOG || '/out/fixture-requests.jsonl';
const TOKENS = {
  s1: 'ISSUE24_S1_HTTP_BODY_20261112',
  s2: 'ISSUE24_S2_JS_BODY_20261112',
  s3a: 'ISSUE24_S3A_JS_BODY_20261112',
  s3b: 'ISSUE24_S3B_JS_BODY_20261112',
  s3c: 'ISSUE24_S3C_JS_BODY_20261112',
  s3d: 'ISSUE24_S3D_JS_BODY_20261112',
  s5: 'ISSUE24_S5_JS_BODY_20261112',
};
// 2026-11-12 第三輪起改成擬真頁面（Q12）：第一、二輪的正文只有一串代碼，模型認為「像測試頁、可能是殼層」而繼續驗證。
// 每頁是一則短新聞，驗收用的代碼放在「公告編號」那句裡。
const ARTICLES = {
  s1: ['市立圖書館週末延長開放', ['市立圖書館宣布，自下個月起週六、週日開放時間延長至晚上九點，方便上班族與學生利用。', '館方表示，延長時段將開放閱覽室與自修區，借還書服務照常提供；兒童室則維持原本的開放時間。', `本次調整的公告編號為 ${TOKENS.s1}，詳細時段以館內公告為準。`]],
  s2: ['河濱自行車道分段整修', ['工務局將在下週一起分三段整修河濱自行車道，每段施工約兩週。', '施工期間會設置改道指示，建議民眾改走堤頂步道，並留意現場人員引導。', `本案的公告編號為 ${TOKENS.s2}，各段施工日期將另行公布。`]],
  s3a: ['公車路線調整說明會', ['交通局將於本週六上午在區民活動中心舉辦公車路線調整說明會。', '說明會將介紹新路線的站位與班距，並開放現場提問。', `活動公告編號為 ${TOKENS.s3a}，不需事先報名。`]],
  s3b: ['社區運動中心泳池暫停開放', ['社區運動中心的室內泳池因進行年度設備維護，將暫停開放十天。', '維護期間健身房與韻律教室照常營運，已購買的泳池月票將自動順延。', `相關公告編號為 ${TOKENS.s3b}，如有疑問可洽服務櫃台。`]],
  s3c: ['夜市周邊交通管制', ['為改善週末夜市周邊的人車壅塞，警察局將在週五至週日傍晚實施交通管制。', '管制時段內主要道路禁止臨時停車，並增派人員疏導。', `管制公告編號為 ${TOKENS.s3c}，請民眾多利用大眾運輸。`]],
  s3d: ['老街騎樓整平工程完工', ['老街騎樓整平工程已於上週完工，行人通行更加平順。', '工程期間配合店家營業時間調整施工，未發生重大延誤。', `完工公告編號為 ${TOKENS.s3d}，後續維護由區公所負責。`]],
  s5: ['垃圾車收運時間異動', ['清潔隊將自下週起調整部分路線的垃圾車收運時間，平均延後約十五分鐘。', '異動路線與新時刻表已張貼於各里辦公處。', `本次異動的公告編號為 ${TOKENS.s5}，請民眾依新時間倒垃圾。`]],
};
const titleOf = (c) => ARTICLES[c]?.[0] ?? '最新消息';
const articleHtml = (c) => ARTICLES[c][1].map((t) => `<p>${t}</p>`).join('');
const frame = (c, main, script = '') => `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${titleOf(c)}｜市政新聞</title></head><body><header><a href="/">市政新聞</a></header><h1>${titleOf(c)}</h1><main id="b">${main}</main><footer>市政新聞網</footer>${script}</body></html>`;
const jsPage = (c) => frame(c, '<p>載入中…</p>', `<script>fetch("/${c}/api",{headers:{"x-issue24":"1"}}).then(r=>r.json()).then(j=>{document.querySelector("#b").innerHTML=j.html})</script>`);
const shellPage = (c) => frame(c, '<p>載入中…</p>', '<script>throw new Error("boom")</script>');
// 每個情境對 Moli 的回應；Chrome 與其他讀取者一律拿到 jsPage（s1 是靜態頁、s4 一律是殼層）。
const moliBehavior = { s3a: 'hang', s3b: 'error500', s3c: 'shell', s5: 'hang' };

const classify = (ua = '') => (ua.includes('HeadlessChrome') ? 'chrome' : ua === MOLI_UA ? 'moli' : 'other');

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const [, c, leaf] = url.pathname.split('/');
  const client = classify(req.headers['user-agent']);
  appendFileSync(LOG, JSON.stringify({ t: Date.now(), host: req.headers.host, path: url.pathname, client, ua: req.headers['user-agent'] ?? null }) + '\n');
  const html = (body, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
  if (!c || !(c in TOKENS || c === 's4')) return html('not found', 404);
  if (leaf === 'api') {
    if (req.headers['x-issue24'] !== '1' || !TOKENS[c]) return html('forbidden', 403);
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ html: articleHtml(c) }));
  }
  if (c === 's1') return html(frame(c, articleHtml(c)));
  if (c === 's4') return html(shellPage(c));
  if (client === 'moli') {
    const b = moliBehavior[c];
    if (b === 'hang') { res.writeHead(200, { 'content-type': 'text/html' }); res.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${titleOf(c)}｜市政新聞</title></head><body><h1>${titleOf(c)}</h1>`); return; }
    if (b === 'error500') return html('internal error', 500);
    if (b === 'shell') return html(shellPage(c));
  }
  return html(jsPage(c));
}).listen(8080, () => console.log('fixture ready'));
