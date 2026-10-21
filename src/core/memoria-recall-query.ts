/**
 * Memoria 召回的問句前處理與注入判準(issue 0019)。
 *
 * Memoria 的 confidence 是「問句 token 出現在第一筆結果裡的比例」,中文切成 2 字窗格。
 * 「什麼」「怎麼」「多少」這類疑問詞也算 token,短問句碰巧命中兩三個就超過門檻,
 * 所以先拿掉疑問詞與虛詞再送出,並要求注入的 snippet 至少含 2 個內容 token。
 * 清單與門檻的量測見 docs/issues/issue-0019/evidence/step2-criteria.md。
 */

/** 疑問詞、虛詞與句尾語氣詞。只收語法功能詞,不收主題詞。多字詞依長度由長到短比對。 */
const FUNCTION_WORDS = [
  '為什麼',
  '怎麼樣',
  '怎麼辦',
  '是不是',
  '有沒有',
  '要不要',
  '能不能',
  '會不會',
  '可不可以',
  '什麼',
  '怎麼',
  '怎樣',
  '如何',
  '多少',
  '何時',
  '是否',
  '能否',
  '可以',
  '應該',
  '一下',
  '之前',
  '後來',
  '現在',
  '目前',
  '已經',
  '還是',
  '或是',
  '但是',
  '所以',
  '因為',
  '如果',
  '這個',
  '那個',
  '這些',
  '那些',
  '這樣',
  '那樣',
  '我們',
  '你們',
  '他們',
  '自己',
  '一個',
  '有點',
  '比較',
  '哪',
  '幾',
  '誰',
  '的',
  '了',
  '嗎',
  '呢',
  '吧',
  '啊',
  '呀',
  '喔',
  '哦'
].sort((a, b) => b.length - a.length);

/** 代名詞、助動詞、介系詞與副詞的單字,在多字詞之後才拿掉。 */
const SINGLE_CHAR_FUNCTION_WORDS = [
  '我',
  '你',
  '他',
  '她',
  '它',
  '要',
  '在',
  '是',
  '有',
  '會',
  '就',
  '都',
  '也',
  '還',
  '再',
  '很',
  '把',
  '被',
  '讓',
  '給',
  '對',
  '從',
  '到',
  '和',
  '跟',
  '與'
];

/** 注入的 snippet 至少要含幾個不是純數字的問句 token。 */
export const MIN_MATCHED_TOKENS = 2;

/** 把疑問詞與虛詞換成空白(不是直接刪掉),免得前後的字接成新的 2 字窗格。 */
export function stripFunctionWords(query: string): string {
  let out = query;
  for (const word of FUNCTION_WORDS) out = out.split(word).join(' ');
  for (const word of SINGLE_CHAR_FUNCTION_WORDS) out = out.split(word).join(' ');
  return out.replace(/\s+/g, ' ').trim();
}

// 以下複製自 Memoria 1.28.1 的 tokenizeQuery(src/core/utils.ts)。Memoria 改了切法時要跟著改,
// 否則這裡算的 token 與 confidence 背後的 token 對不上。
const TOKEN_SPLIT_PATTERN = /[^a-z0-9一-鿿]+/;
const CJK_RUN_PATTERN = /[一-鿿]+/g;

function expandCjkRuns(token: string, n: number): string[] {
  if (!/[一-鿿]/.test(token)) return [token];
  const out: string[] = [];
  let cursor = 0;
  for (const match of token.matchAll(CJK_RUN_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) out.push(token.slice(cursor, start));
    const run = match[0];
    if (run.length <= n) {
      out.push(run);
    } else {
      for (let i = 0; i + n <= run.length; i += 1) out.push(run.slice(i, i + n));
    }
    cursor = start + run.length;
  }
  if (cursor < token.length) out.push(token.slice(cursor));
  return out;
}

export function tokenizeQuery(query: string, minLength = 2): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(TOKEN_SPLIT_PATTERN)
        .flatMap((t) => expandCjkRuns(t, minLength))
        .map((t) => t.trim())
        .filter((t) => t.length >= minLength)
    )
  );
}

/** 問句裡不是純數字、而且出現在 snippet 裡的 token 數。數字撞上日期或版本號不算命中。 */
export function countMatchedContentTokens(query: string, snippet: string): number {
  const haystack = snippet.toLowerCase();
  return tokenizeQuery(query).filter((t) => !/^\d+$/.test(t) && haystack.includes(t)).length;
}
