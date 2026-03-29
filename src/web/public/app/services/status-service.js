export function createStatusService(api) {
  return {
    getHealth() {
      return api.request('/api/health');
    },
    getStatus() {
      return api.request('/api/status');
    },
    getMemoryHealth() {
      return api.request('/api/memory-health');
    },
    getBackfillReport(limit = 10) {
      return api.request(`/api/memory-backfill/report?limit=${encodeURIComponent(String(limit))}`);
    }
  };
}
