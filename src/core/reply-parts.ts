import type { ReplyParts } from './agent-result.js';

type StepText = { text: string; reason?: string };

const THINK_CLOSE = /<\/think>/gi;
const THINK_TAG = /<\/?think>/gi;

/** 段落裡最後一個 think 結束標籤之前是模型的推理文字;實際資料只有結束標籤、沒有開頭標籤。 */
function splitReasoning(text: string): { reasoning?: string; rest: string } {
  const last = [...text.matchAll(THINK_CLOSE)].pop();
  if (!last) {
    return { rest: text };
  }
  return {
    reasoning: text.slice(0, last.index),
    rest: text.slice(last.index + last[0].length)
  };
}

/**
 * 依 opencode 的 step 分出過程與結論(issue 0028)。
 *
 * 分界只看 step 結構,不看文字內容:以 `tool-calls` 結束的 step 講的話是過程,最後一個 step
 * 的文字是結論。2026-11-16 盤點正式部署 85 個有過程的回合,結論最短 103 字,沒有「先寫結論、
 * 再呼叫工具、最後只補一句」的情況(docs/issues/issue-0028/evidence/step1-inventory.md)。
 * 最後一個 step 之前有文字、卻不是以 `tool-calls` 結束的回合不分段(同一份快照 2,144 個中 1 個)。
 */
export class StepTextCollector {
  private readonly steps: StepText[] = [];
  private current = '';

  addText(text: string): void {
    this.current += text;
  }

  finishStep(reason: unknown): void {
    this.steps.push({
      text: this.current,
      ...(typeof reason === 'string' ? { reason } : {})
    });
    this.current = '';
  }

  /**
   * `clean` 逐段套用(與全文相同的清洗規則);清洗後是空的段落不算。
   *
   * `shownText` 是清洗後的全文。有些清洗只有對全文才做得到(跨 step 的 `<thinking>` 區塊、
   * 工具呼叫外洩的警示),所以每一段都要出現在全文裡才分段,摺疊版面不顯示全文沒有的文字。
   */
  build(clean: (text: string) => string, shownText: string): ReplyParts | undefined {
    const steps = this.current ? [...this.steps, { text: this.current }] : this.steps;
    const last = steps[steps.length - 1];
    if (!last || last.reason === 'tool-calls') {
      return undefined;
    }

    const process: string[] = [];
    const tidy = (raw: string): string => clean(raw.replace(THINK_TAG, '')).trim();
    const pushProcess = (raw: string | undefined): void => {
      const segment = raw === undefined ? '' : tidy(raw);
      if (segment) process.push(segment);
    };

    for (const step of steps.slice(0, -1)) {
      if (step.reason !== 'tool-calls' && tidy(step.text)) {
        return undefined;
      }
      const { reasoning, rest } = splitReasoning(step.text);
      pushProcess(reasoning);
      pushProcess(rest);
    }
    const { reasoning, rest } = splitReasoning(last.text);
    pushProcess(reasoning);
    const conclusion = tidy(rest);

    if (!conclusion || process.length === 0) {
      return undefined;
    }
    const shown = shownText.replace(THINK_TAG, '');
    if (![...process, conclusion].every((segment) => shown.includes(segment))) {
      return undefined;
    }
    return { process, conclusion };
  }
}
