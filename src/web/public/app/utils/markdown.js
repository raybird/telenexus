import { escapeHtml } from './format.js';

function inlineMarkdownToHtml(text) {
  const inlineCodes = [];
  const withTokens = String(text || '').replace(/`([^`\n]+)`/g, (_full, code) => {
    const token = `@@INLINE_${inlineCodes.length}@@`;
    inlineCodes.push(`<code>${escapeHtml(String(code || ''))}</code>`);
    return token;
  });

  let html = escapeHtml(withTokens);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_full, label, url) => {
    const safeUrl = escapeHtml(String(url || ''));
    const safeLabel = escapeHtml(String(label || ''));
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/@@INLINE_(\d+)@@/g, (_full, index) => inlineCodes[Number(index)] || '');
  return html;
}

function parseTable(lines, start) {
  if (start + 1 >= lines.length) {
    return null;
  }
  const header = lines[start] || '';
  const divider = lines[start + 1] || '';
  if (!header.includes('|') || !divider.includes('|')) {
    return null;
  }
  const dividerCompact = divider.replace(/\|/g, '').replace(/:/g, '').replace(/-/g, '').trim();
  if (dividerCompact.length > 0 || !/-{3,}/.test(divider)) {
    return null;
  }

  const splitCells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

  const headers = splitCells(header);
  const rows = [];
  let cursor = start + 2;
  while (cursor < lines.length) {
    const line = lines[cursor] || '';
    if (!line.includes('|') || line.trim().length === 0) {
      break;
    }
    rows.push(splitCells(line));
    cursor += 1;
  }
  return { headers, rows, end: cursor };
}

export function renderMarkdownToHtml(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const fenced = [];
  const source = normalized.replace(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_full, code) => {
    const token = `@@FENCED_${fenced.length}@@`;
    fenced.push(`<pre><code>${escapeHtml(String(code || ''))}</code></pre>`);
    return token;
  });

  const lines = source.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] || '';
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith('@@FENCED_')) {
      blocks.push(trimmed);
      i += 1;
      continue;
    }

    const table = parseTable(lines, i);
    if (table) {
      const headerHtml = table.headers
        .map((cell) => `<th>${inlineMarkdownToHtml(cell)}</th>`)
        .join('');
      const bodyHtml = table.rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${inlineMarkdownToHtml(cell)}</td>`).join('')}</tr>`
        )
        .join('');
      blocks.push(
        `<div class="md-table-wrap"><table class="md-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`
      );
      i = table.end;
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,6}\s+/, '');
      blocks.push(`<h4>${inlineMarkdownToHtml(heading)}</h4>`);
      i += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(trimmed)) {
      const items = [];
      let cursor = i;
      while (cursor < lines.length && /^\s*[-*]\s+/.test(lines[cursor] || '')) {
        items.push((lines[cursor] || '').replace(/^\s*[-*]\s+/, ''));
        cursor += 1;
      }
      blocks.push(
        `<ul>${items.map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`).join('')}</ul>`
      );
      i = cursor;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(trimmed)) {
      const items = [];
      let cursor = i;
      while (cursor < lines.length && /^\s*\d+\.\s+/.test(lines[cursor] || '')) {
        items.push((lines[cursor] || '').replace(/^\s*\d+\.\s+/, ''));
        cursor += 1;
      }
      blocks.push(
        `<ol>${items.map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`).join('')}</ol>`
      );
      i = cursor;
      continue;
    }

    const paragraphLines = [line];
    let cursor = i + 1;
    while (cursor < lines.length) {
      const candidate = lines[cursor] || '';
      if (!candidate.trim()) {
        break;
      }
      if (candidate.trim().startsWith('@@FENCED_')) {
        break;
      }
      if (/^#{1,6}\s+/.test(candidate.trim())) {
        break;
      }
      if (/^\s*[-*]\s+/.test(candidate) || /^\s*\d+\.\s+/.test(candidate)) {
        break;
      }
      if (parseTable(lines, cursor)) {
        break;
      }
      paragraphLines.push(candidate);
      cursor += 1;
    }
    blocks.push(
      `<p>${paragraphLines.map((item) => inlineMarkdownToHtml(item)).join('<br />')}</p>`
    );
    i = cursor;
  }

  return blocks
    .join('')
    .replace(/@@FENCED_(\d+)@@/g, (_full, index) => fenced[Number(index)] || '');
}
