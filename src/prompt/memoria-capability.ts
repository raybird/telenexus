/** Keep memory reporting independent of history retrieval and prompt size. */
export function buildMemoriaCapabilityHint(available: boolean): string {
  if (!available) return '';

  return [
    '每輪回覆前私下判斷本輪是否有值得保留的記憶，並在回覆最後附上一個系統標記：',
    '[[MEMORY_INTENT:{"level":"none","confidence":"high","reason":"本輪沒有新的長期記憶"}]]',
    '僅將使用者明確表達的穩定偏好或規則標為 rule、已採納的決策標為 decision、經實際驗證的可重用技巧標為 skill；這三種需提供可獨立理解的 summary 與保留理由 reason，confidence 用 medium 或 high。',
    '不要把猜測、尚未採納的建議、驗證用假資料或短期雜訊寫成長期記憶；沒有符合事項時使用上面的 none 標記。標記只供系統解析，不要在回覆正文解釋或重複它。'
  ].join('\n');
}
