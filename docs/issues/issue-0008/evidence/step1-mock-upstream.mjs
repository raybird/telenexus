#!/usr/bin/env node
// 本機假上游:依模型名 s<狀態碼> 回對應的 HTTP 錯誤,用來觀察 opencode 對各狀態碼的行為。
// 只聽 127.0.0.1;每個請求記一行到 stdout。
import http from 'node:http';

const BODIES = {
  426: { type: 'error', error: { type: 'UpgradeRequired', message: 'mock: client upgrade required' } },
  429: { type: 'error', error: { type: 'RateLimitError', message: 'mock: rate limit exceeded' } },
  410: { title: 'Gone', status: 410, detail: 'mock: model has reached its end of life' },
  404: { error: { message: 'mock: not found' } },
  401: { error: { message: 'mock: invalid api key' } },
  500: { error: { message: 'mock: internal error' } }
};

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let model = '';
    try {
      model = JSON.parse(raw).model || '';
    } catch {
      // 非 JSON 就當成未知模型
    }
    // n429 = 真實 nvidia 429 的 body 形狀(沒有 error.message),用來看 opencode 退回哪種訊息文字
    const status = Number.parseInt(model.replace(/^[sn]/, ''), 10) || 500;
    const body = model === 'n429' ? { status: 429, title: 'Too Many Requests' } : BODIES[status] || BODIES[500];
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} model=${model} -> ${status}`);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});
server.listen(Number(process.env.PORT || 18426), '127.0.0.1', () => {
  console.log(`listening ${server.address().port}`);
});
