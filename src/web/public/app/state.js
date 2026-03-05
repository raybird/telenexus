const STORAGE_TOKEN_KEY = 'telenexus_web_token';
const STORAGE_THEME_KEY = 'telenexus_theme';

function getInitialTheme() {
  const saved = window.localStorage.getItem(STORAGE_THEME_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function createState(config = {}) {
  const state = {
    route: 'chat',
    token: window.localStorage.getItem(STORAGE_TOKEN_KEY) || '',
    theme: getInitialTheme(),
    health: { online: false, updatedAt: 0 },
    config: {
      errorThreshold: Number.isFinite(config.alertErrorThreshold)
        ? Number(config.alertErrorThreshold)
        : 1,
      runnerWarnThreshold: Number.isFinite(config.alertRunnerSuccessWarnThreshold)
        ? Number(config.alertRunnerSuccessWarnThreshold)
        : 80
    }
  };

  return {
    get() {
      return state;
    },
    setRoute(route) {
      state.route = route;
    },
    setToken(token) {
      state.token = token.trim();
      if (state.token) {
        window.localStorage.setItem(STORAGE_TOKEN_KEY, state.token);
      } else {
        window.localStorage.removeItem(STORAGE_TOKEN_KEY);
      }
    },
    getToken() {
      return state.token;
    },
    setTheme(theme) {
      state.theme = theme === 'dark' ? 'dark' : 'light';
      window.localStorage.setItem(STORAGE_THEME_KEY, state.theme);
      document.documentElement.setAttribute('data-theme', state.theme);
    },
    getTheme() {
      return state.theme;
    },
    toggleTheme() {
      const next = state.theme === 'dark' ? 'light' : 'dark';
      this.setTheme(next);
      return next;
    },
    setHealth(online) {
      state.health.online = online;
      state.health.updatedAt = Date.now();
    }
  };
}
