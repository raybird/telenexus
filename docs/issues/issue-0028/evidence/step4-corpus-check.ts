// 步驟 4 的本機語料檢查（SCN-004、SCN-012）：把步驟 1 快照裡的回合跑過新的分段與組版，
// 統計缺字詞、超過 4096 字與引言不完整的則數。原文與輸出都不進 repo，只記數字。
//
// 用法：npx tsx docs/issues/issue-0028/evidence/step4-corpus-check.ts <turns.json>
// turns.json：[{ id, source: 'chat' | 'scheduled', steps: string[] }]，每個 step 是該 assistant
// 訊息的文字，由快照的 message／part 表依 parentID 取出（排除健康探針）。
import { readFileSync } from 'node:fs';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { TelegramConnector } from '../../../../src/connectors/telegram.js';
import { StepTextCollector } from '../../../../src/core/reply-parts.js';
import { buildFoldedMessages } from '../../../../src/telegram/render/folded-reply.js';
import { renderMarkdownV2 } from '../../../../src/telegram/render/markdown-v2.js';

type Turn = { id: string; source: 'chat' | 'scheduled'; steps: string[] };
type MdNode = { type: string; value?: string; alt?: string; url?: string; children?: MdNode[] };

const turns = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Turn[];
const connector = Object.create(TelegramConnector.prototype) as {
  normalizeMarkdownTables(text: string): string;
};
const render = (markdown: string) => renderMarkdownV2(connector.normalizeMarkdownTables(markdown));
const parser = unified().use(remarkParse);
const unescape = (text: string) => text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');

function tokens(markdown: string): string[] {
  const out: string[] = [];
  const visit = (node: MdNode) => {
    for (const value of [node.value, node.alt, node.type === 'link' ? node.url : undefined]) {
      // think 標籤依 #27 不輸出，不算缺。
      if (typeof value === 'string') {
        out.push(
          ...value
            .replace(/<\/?think>/gi, ' ')
            .split(/\s+/)
            .filter(Boolean)
        );
      }
    }
    (node.children ?? []).forEach(visit);
  };
  visit(parser.parse(connector.normalizeMarkdownTables(markdown)) as MdNode);
  return out;
}

const stats = {
  turns: 0,
  scheduled: 0,
  withProcess: 0,
  messages: 0,
  multiMessageTurns: 0,
  lossyTurns: 0,
  missingTokens: 0,
  overLimitMessages: 0,
  brokenQuoteMessages: 0,
  plainWithQuoteMarkup: 0
};

for (const turn of turns) {
  const nonEmpty = turn.steps.filter((step) => step.trim());
  if (nonEmpty.length === 0) continue;
  stats.turns += 1;
  if (turn.source === 'scheduled') stats.scheduled += 1;

  const collector = new StepTextCollector();
  turn.steps.forEach((step, i) => {
    collector.addText(step);
    collector.finishStep(i < turn.steps.length - 1 ? 'tool-calls' : 'stop');
  });
  const parts = collector.build((text) => text);
  const fullText = turn.steps.join('');
  const conclusion = `[Opencode] ${parts?.conclusion ?? fullText.trim()}`;
  const process = parts?.process ?? [];
  if (process.length > 0) stats.withProcess += 1;

  const messages = buildFoldedMessages({ header: '🕐 [排程: 名稱]', conclusion, process }, render);
  stats.messages += messages.length;
  if (messages.length > 1) stats.multiMessageTurns += 1;

  for (const message of messages) {
    if (message.markdownV2.length > 4096) stats.overLimitMessages += 1;
    const quoteStart = message.markdownV2.indexOf('**>');
    if (quoteStart >= 0) {
      const quoteLines = message.markdownV2.slice(quoteStart).split('\n');
      const complete =
        quoteLines.slice(1).every((line) => line.startsWith('>')) &&
        quoteLines.at(-1)!.endsWith('||');
      if (!complete) stats.brokenQuoteMessages += 1;
    }
    if (message.plain && (message.plain.includes('**>') || message.plain.includes('||'))) {
      stats.plainWithQuoteMarkup += 1;
    }
  }

  const shown = unescape(messages.map((message) => message.markdownV2).join('\n'));
  const missing = [conclusion, ...process]
    .flatMap(tokens)
    .filter((token) => !shown.includes(token)).length;
  if (missing > 0) stats.lossyTurns += 1;
  stats.missingTokens += missing;
}

console.log(JSON.stringify(stats));
