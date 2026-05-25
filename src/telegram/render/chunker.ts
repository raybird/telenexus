const CODE_FENCE = /^```/;

export function chunkMarkdownV2(text: string, limit: number = 4096): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const lines = text.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let openFence = false;
  let openFenceLang = '';

  const flush = () => {
    if (current.length === 0) return;
    let out = current.join('\n');
    if (openFence) {
      out += '\n```';
    }
    chunks.push(out);
    current = [];
    currentLen = 0;
    if (openFence) {
      const header = '```' + openFenceLang;
      current.push(header);
      currentLen = header.length + 1;
    }
  };

  for (const line of lines) {
    const fenceMatch = CODE_FENCE.exec(line);
    if (fenceMatch) {
      if (openFence) {
        openFence = false;
        openFenceLang = '';
      } else {
        openFence = true;
        openFenceLang = line.slice(3);
      }
    }

    const newLen = currentLen + (currentLen ? 1 : 0) + line.length;
    if (newLen > limit) {
      flush();
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) {
          chunks.push(line.slice(i, i + limit));
        }
        continue;
      }
    }
    current.push(line);
    currentLen += (currentLen ? 1 : 0) + line.length;
  }

  flush();
  return chunks;
}
