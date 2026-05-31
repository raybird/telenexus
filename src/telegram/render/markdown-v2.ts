import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, Content, PhrasingContent, ListItem } from 'mdast';
import { escapeMarkdownV2, escapeMarkdownV2Code, escapeMarkdownV2Link } from './escape.js';

const parser = unified().use(remarkParse);

export function renderMarkdownV2(input: string): string {
  try {
    const tree = parser.parse(input) as Root;
    return tree.children.map(renderBlock).filter(Boolean).join('\n\n');
  } catch {
    return escapeMarkdownV2(input);
  }
}

function renderBlock(node: Content): string {
  switch (node.type) {
    case 'heading':
      return `*${renderInlineChildren(node.children)}*`;
    case 'paragraph':
      return renderInlineChildren(node.children);
    case 'code': {
      const lang = node.lang ?? '';
      const safe = escapeMarkdownV2Code(node.value);
      return '```' + lang + '\n' + safe + '\n```';
    }
    case 'list':
      return node.children
        .map((item) => renderListItem(item as ListItem))
        .join('\n');
    case 'blockquote':
      return node.children
        .map((c) => {
          if (c.type === 'paragraph') {
            return '>' + renderInlineChildren(c.children);
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    case 'thematicBreak':
      return '\\-\\-\\-';
    default:
      return '';
  }
}

function renderListItem(item: ListItem): string {
  return '• ' + item.children
    .map((child) =>
      child.type === 'paragraph' ? renderInlineChildren(child.children) : ''
    )
    .filter(Boolean)
    .join('\n');
}

function renderInlineChildren(children: PhrasingContent[]): string {
  return children.map(renderInline).join('');
}

function renderInline(node: PhrasingContent): string {
  switch (node.type) {
    case 'text':
      return escapeMarkdownV2(node.value);
    case 'strong':
      return `*${renderInlineChildren(node.children)}*`;
    case 'emphasis':
      return `_${renderInlineChildren(node.children)}_`;
    case 'inlineCode':
      return '`' + escapeMarkdownV2Code(node.value) + '`';
    case 'link': {
      const label = renderInlineChildren(node.children);
      const url = escapeMarkdownV2Link(node.url);
      return `[${label}](${url})`;
    }
    case 'break':
      return '\n';
    default:
      return '';
  }
}
