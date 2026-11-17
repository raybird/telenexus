/**
 * issue 0030：面板伺服器、PanelController 與 tunnel-manager 共用的路徑與服務名稱。
 * tunnel-manager 以公開網址打 HEALTH_PATH，確認回應的是這個面板（PANEL_SERVICE）才算 Tunnel 通了。
 */
export const PANEL_PATH = '/panel/';
export const HEALTH_PATH = '/panel/health';
export const PANEL_SERVICE = 'telenexus-panel';
