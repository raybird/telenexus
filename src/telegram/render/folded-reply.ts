import type { FoldedReply } from '../../types/index.js';
import { chunkMarkdownV2 } from './chunker.js';
import { escapeMarkdownV2 } from './escape.js';

/** 一則要送出的訊息；plain 是 MarkdownV2 被拒收時改送的純文字，沒有時沿用連接器原本的退回。 */
export type FoldedMessage = { markdownV2: string; plain?: string };

const TELEGRAM_MESSAGE_LIMIT = 4096;
const PROCESS_TITLE = '過程';
const FENCE = /^(\s*)(`{3,}|~{3,})/;

/**
 * 把回覆排成結論在前、過程收進可展開引言的訊息（issue 0028）。寫法依步驟 2 實測定案：
 * 第一行 `**>過程`，每行前加 `>`，段落之間一個空的引言行，最後一行結尾加 `||`。
 *
 * 結論加過程在一則以內時一起送；超過時結論照 chunkMarkdownV2 切段（與變更前相同），
 * 過程另起一或多則，每則都是完整的引言。沒有過程時只送結論。
 */
export function buildFoldedMessages(
  reply: FoldedReply,
  render: (markdown: string) => string,
  limit: number = TELEGRAM_MESSAGE_LIMIT
): FoldedMessage[] {
  const headMarkdownV2 = reply.header ? `${escapeMarkdownV2(reply.header)}\n\n` : '';
  const headPlain = reply.header ? `${reply.header}\n\n` : '';
  const conclusionMarkdownV2 = headMarkdownV2 + render(reply.conclusion);
  const conclusionPlain = headPlain + reply.conclusion;
  const process = reply.process.map((segment) => segment.trim()).filter(Boolean);
  const conclusionMessages = (): FoldedMessage[] =>
    chunkMarkdownV2(conclusionMarkdownV2, limit).map((markdownV2) => ({ markdownV2 }));

  if (process.length === 0) {
    return conclusionMessages();
  }

  const combined = `${conclusionMarkdownV2}\n\n${quote(process.map(render))}`;
  if (combined.length <= limit) {
    return [{ markdownV2: combined, plain: `${conclusionPlain}\n\n${processPlain(process)}` }];
  }

  const fits = (segments: string[]): boolean => quote(segments.map(render)).length <= limit;
  const pieces = process.flatMap((segment) =>
    fits([segment]) ? [segment] : splitSegment(segment, (piece) => fits([piece]), limit)
  );
  const groups: string[][] = [];
  for (const piece of pieces) {
    const last = groups.at(-1);
    if (last && fits([...last, piece])) {
      last.push(piece);
    } else {
      groups.push([piece]);
    }
  }
  return [
    ...conclusionMessages(),
    ...groups.map((group) => ({
      markdownV2: quote(group.map(render)),
      plain: processPlain(group)
    }))
  ];
}

function quote(renderedSegments: string[]): string {
  const lines = [PROCESS_TITLE];
  renderedSegments.forEach((segment, i) => {
    if (i > 0) lines.push('');
    lines.push(...segment.split('\n'));
  });
  // 過程裡的 Markdown 引言攤平進摺疊引言(同 #27 把巢狀引言攤平成一層),不送出 `>>`;
  // 程式碼區塊裡以 > 開頭的行是內容,照原樣保留。
  let inCode = false;
  const quoted = lines.map((line) => {
    if (line.startsWith('```')) {
      inCode = !inCode;
    } else if (!inCode && line.startsWith('>')) {
      return line;
    }
    return `>${line}`;
  });
  quoted[0] = `**${quoted[0]}`;
  quoted[quoted.length - 1] = `${quoted[quoted.length - 1]}||`;
  return quoted.join('\n');
}

function processPlain(segments: string[]): string {
  return [PROCESS_TITLE, ...segments].join('\n\n');
}

/**
 * 單一段過程放不進一則時，依行切成幾段原文。切在程式碼區塊裡時補上結尾 fence，
 * 下一段以同一個開頭 fence 接續，兩邊都還是程式碼。單行就放不下時依字元切。
 */
function splitSegment(segment: string, fits: (piece: string) => boolean, limit: number): string[] {
  type Fence = { line: string; close: string };
  const pieces: string[] = [];
  let openFence: Fence | undefined;
  let current: string[] = [];
  // current 開頭補上的 fence 行數；只有這些行時不算有內容。
  let reopened = 0;

  const withClosing = (lines: string[], fence: Fence | undefined): string =>
    (fence ? [...lines, fence.close] : lines).join('\n');
  const push = (text: string) => {
    if (text.trim()) pieces.push(text);
  };
  const restart = () => {
    current = openFence ? [openFence.line] : [];
    reopened = current.length;
  };

  for (const line of segment.split('\n')) {
    const nextFence = toggleFence(openFence, line);
    const fitsWithLine = () => fits(withClosing([...current, line], nextFence));
    if (current.length > reopened && !fitsWithLine()) {
      push(withClosing(current, openFence));
      restart();
    }
    if (fitsWithLine()) {
      current.push(line);
      openFence = nextFence;
      continue;
    }
    // 單行（加上接續的 fence）就超過一則：依字元切成渲染後必定放得下的長度。
    const chars = Array.from(line);
    const sliceLength = Math.max(1, Math.floor((limit - 64) / 3));
    for (let i = 0; i < chars.length; i += sliceLength) {
      push(withClosing([...current, chars.slice(i, i + sliceLength).join('')], openFence));
    }
    openFence = nextFence;
    restart();
  }
  if (current.length > reopened) {
    push(current.join('\n'));
  }
  return pieces;
}

function toggleFence(
  open: { line: string; close: string } | undefined,
  line: string
): { line: string; close: string } | undefined {
  const match = FENCE.exec(line);
  if (!match) return open;
  const marker = match[2]!;
  if (open) {
    return line.trim().startsWith(open.close.trim()) ? undefined : open;
  }
  return { line, close: `${match[1]}${marker}` };
}
