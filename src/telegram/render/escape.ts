const MD_V2_SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MD_V2_SPECIAL, (m) => `\\${m}`);
}

export function escapeMarkdownV2Code(text: string): string {
  return text.replace(/[`\\]/g, (m) => `\\${m}`);
}

export function escapeMarkdownV2Link(url: string): string {
  return url.replace(/[)\\]/g, (m) => `\\${m}`);
}
