import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, Content, PhrasingContent, List, ListItem, Blockquote } from 'mdast';
import { escapeMarkdownV2, escapeMarkdownV2Code, escapeMarkdownV2Link } from './escape.js';

const parser = unified().use(remarkParse);

/** 每多一層清單，行首多的空白數。 */
const INDENT_PER_LEVEL = 2;
/** 無序清單依層級使用的符號；超過的層級沿用最後一個。 */
const BULLETS = ['•', '◦', '▪'] as const;
/** 模型推理結束的標記（issue 0027 AC-4）：只拿掉標籤本身，前後文字照常輸出。 */
const THINK_TAG = /<\/?think>/gi;

export function renderMarkdownV2(input: string): string {
  try {
    const tree = parser.parse(input) as Root;
    const renderer = new Renderer(input);
    return tree.children
      .map((node) => renderer.block(node))
      .filter(Boolean)
      .join('\n\n');
  } catch {
    return escapeMarkdownV2(input);
  }
}

class Renderer {
  constructor(private readonly source: string) {}

  block(node: Content): string {
    switch (node.type) {
      case 'heading': {
        const text = this.inlineChildren(node.children);
        return node.depth <= 2 ? `*__${text}__*` : `*${text}*`;
      }
      case 'paragraph':
        return this.inlineChildren(node.children);
      case 'code':
        return '```' + (node.lang ?? '') + '\n' + escapeMarkdownV2Code(node.value) + '\n```';
      case 'list':
        return this.list(node, 0);
      case 'blockquote':
        return this.blockquote(node);
      case 'thematicBreak':
        return '\\-\\-\\-';
      case 'html':
        return this.html(node.value);
      default:
        return this.fallback(node);
    }
  }

  private list(list: List, depth: number): string {
    const start = list.start ?? 1;
    return list.children
      .map((item, index) => {
        const marker = list.ordered
          ? `${start + index}\\.`
          : (BULLETS[Math.min(depth, BULLETS.length - 1)] as string);
        return this.listItem(item, marker, depth);
      })
      .join('\n');
  }

  private listItem(item: ListItem, marker: string, depth: number): string {
    const indent = ' '.repeat(depth * INDENT_PER_LEVEL);
    const lines: string[] = [];
    let markerUsed = false;

    for (const child of item.children) {
      if (child.type === 'list') {
        if (!markerUsed) {
          lines.push(`${indent}${marker}`);
          markerUsed = true;
        }
        lines.push(this.list(child, depth + 1));
        continue;
      }
      const rendered = this.block(child);
      if (!rendered) continue;
      // 程式碼區塊與引言的符號必須在行首，不能縮排，也不能接在清單符號後面。
      const needsLineStart = child.type === 'code' || child.type === 'blockquote';
      if (!markerUsed) {
        lines.push(needsLineStart ? `${indent}${marker}` : `${indent}${marker} ${rendered}`);
        markerUsed = true;
        if (!needsLineStart) continue;
      }
      lines.push(needsLineStart ? rendered : indentLines(rendered, indent));
    }

    if (!markerUsed) lines.push(`${indent}${marker} `);
    return lines.join('\n');
  }

  private blockquote(node: Blockquote): string {
    return node.children
      .map((child) => {
        if (child.type === 'paragraph') {
          return '>' + this.inlineChildren(child.children);
        }
        // Telegram 的引言裡不能放程式碼區塊，改成跳脫後的純文字。
        const rendered = child.type === 'code' ? escapeMarkdownV2(child.value) : this.block(child);
        if (!rendered) return '';
        return rendered
          .split('\n')
          .map((line) => '>' + line)
          .join('\n');
      })
      .filter(Boolean)
      .join('\n');
  }

  private inlineChildren(children: PhrasingContent[]): string {
    return children.map((node) => this.inline(node)).join('');
  }

  private inline(node: PhrasingContent): string {
    switch (node.type) {
      case 'text':
        return escapeMarkdownV2(node.value);
      case 'strong':
        return `*${this.inlineChildren(node.children)}*`;
      case 'emphasis':
        return `_${this.inlineChildren(node.children)}_`;
      case 'inlineCode':
        return '`' + escapeMarkdownV2Code(node.value) + '`';
      case 'link': {
        const label = this.inlineChildren(node.children);
        const url = escapeMarkdownV2Link(node.url);
        return `[${label}](${url})`;
      }
      case 'break':
        return '\n';
      case 'html':
        return this.html(node.value);
      default:
        return this.fallback(node);
    }
  }

  private html(value: string): string {
    return escapeMarkdownV2(value.replace(THINK_TAG, '').trim());
  }

  /** 不認得的節點以原文跳脫後輸出，不讓內容消失（issue 0027 AC-4）。 */
  private fallback(node: Content | PhrasingContent): string {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return '';
    return escapeMarkdownV2(this.source.slice(start, end));
  }
}

function indentLines(text: string, indent: string): string {
  if (!indent) return text;
  return text
    .split('\n')
    .map((line) => indent + line)
    .join('\n');
}
