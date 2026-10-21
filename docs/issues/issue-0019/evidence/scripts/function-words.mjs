// 中文疑問詞與虛詞。只收語法功能詞，不收任何主題詞，也不依評估集的題目挑選。
// 多字詞先比對（依長度由長到短），單字只收疑問詞「哪」「幾」「誰」、句尾語氣詞與「的」「了」。
export const FUNCTION_WORDS = [
  '為什麼', '怎麼樣', '怎麼辦', '是不是', '有沒有', '要不要', '能不能', '會不會', '可不可以',
  '什麼', '怎麼', '怎樣', '如何', '多少', '何時', '是否', '能否',
  '可以', '應該', '一下', '之前', '後來', '現在', '目前', '已經', '還是', '或是', '但是',
  '所以', '因為', '如果', '這個', '那個', '這些', '那些', '這樣', '那樣', '我們', '你們',
  '他們', '自己', '一個', '有點', '比較',
  '哪', '幾', '誰',
  '的', '了', '嗎', '呢', '吧', '啊', '呀', '喔', '哦'
];

// 第二版加入的單字虛詞：代名詞、助動詞、介系詞、副詞。拆開內容詞的風險較高（例如「會議」少了「會」），
// 所以另列一份，量測時與第一份分開比較。
export const SINGLE_CHAR_FUNCTION_WORDS = [
  '我', '你', '他', '她', '它', '要', '在', '是', '有', '會', '就', '都', '也', '還', '再', '很',
  '把', '被', '讓', '給', '對', '從', '到', '和', '跟', '與'
];

const sorted = [...FUNCTION_WORDS].sort((a, b) => b.length - a.length);

export function stripFunctionWords(query, { singleChars = false } = {}) {
  let out = query;
  for (const word of sorted) out = out.split(word).join(' ');
  if (singleChars) for (const word of SINGLE_CHAR_FUNCTION_WORDS) out = out.split(word).join(' ');
  return out.replace(/\s+/g, ' ').trim();
}
