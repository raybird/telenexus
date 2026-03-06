export function createMemoryService(api, state) {
  return {
    async getRecent(limit = 12) {
      return api.request(`/api/memory/recent?limit=${encodeURIComponent(String(limit))}`);
    },
    async search(query, limit = 20) {
      const q = (query || '').trim();
      if (!q) {
        return { ok: true, items: [] };
      }
      return api.request(
        `/api/memory/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`
      );
    },
    async getHistory(offset = 0, limit = 12) {
      return api.request(
        `/api/memory/history?offset=${encodeURIComponent(String(offset))}&limit=${encodeURIComponent(String(limit))}`
      );
    },
    async getHistoryBefore(beforeTimestamp, limit = 12) {
      const base = `/api/memory/history?limit=${encodeURIComponent(String(limit))}`;
      if (!Number.isFinite(beforeTimestamp) || beforeTimestamp <= 0) {
        return api.request(base);
      }
      return api.request(
        `${base}&beforeTimestamp=${encodeURIComponent(String(Math.floor(beforeTimestamp)))}`
      );
    },
    streamUpdates(handlers) {
      return api.openSse('/api/memory/stream', handlers);
    },
    exportUrl(format) {
      const token = state.getToken();
      const extra = token ? `&token=${encodeURIComponent(token)}` : '';
      return `/api/memory/export?format=${encodeURIComponent(format)}${extra}`;
    }
  };
}
