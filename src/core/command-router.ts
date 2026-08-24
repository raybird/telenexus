import type { Connector, UnifiedMessage } from '../types/index.js';
import type { MemoryManager } from './memory.js';
import type { Scheduler } from './scheduler.js';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { parseBool } from '../utils/env.js';
import { resolveProjectDir } from '../utils/paths.js';
import { runProcess } from './process-runner.js';

type CommandContext = {
  msg: UnifiedMessage;
  userId: string;
  content: string;
  connector: Connector;
  memory: MemoryManager;
  scheduler: Scheduler;
  requestNewSession: (userId: string) => void;
};

type CommandDefinition = {
  name: string;
  match: (content: string) => boolean;
  execute: (context: CommandContext) => Promise<void>;
};

export class CommandRouter {
  private commands: CommandDefinition[] = [];
  private readonly maxSendFileBytes = 45 * 1024 * 1024;
  private readonly sendFileStrictTempOnly = parseBool(
    process.env.SEND_FILE_STRICT_TEMP_ONLY,
    false
  );
  private defaultPassthroughCommandWhitelist: Set<string> = new Set([
    '/compress',
    '/compact',
    '/clear'
  ]);

  constructor() {
    this.registerDefaultCommands();
  }

  registerCommand(command: CommandDefinition): void {
    this.commands.push(command);
  }

  async handleMessage(
    msg: UnifiedMessage,
    deps: {
      connector: Connector;
      memory: MemoryManager;
      scheduler: Scheduler;
      requestNewSession: (userId: string) => void;
    }
  ): Promise<boolean> {
    // 清理訊息內容，移除可能導致 shell 錯誤的特殊字元
    const content = msg.content.trim().replace(/[`'"]/g, '');

    // 檢查是否為指令（以 / 開頭）
    const isCommand = content.startsWith('/');
    const userId = msg.sender.id;

    // 互動進行中時，只允許白名單指令
    const { interactionGuard } = await import('../services/interaction-guard.js');
    const guardState = interactionGuard.getState(userId);
    if (guardState && isCommand && !interactionGuard.isCommandAllowed(userId, content)) {
      await deps.connector.sendMessage(
        msg.chatId || userId,
        `⏳ 你目前正在「${guardState.kind}」流程中，請先完成或輸入 /abort 取消後再試。`
      );
      return true;
    }

    for (const command of this.commands) {
      if (command.match(content)) {
        await command.execute({
          msg,
          userId,
          content,
          connector: deps.connector,
          memory: deps.memory,
          scheduler: deps.scheduler,
          requestNewSession: deps.requestNewSession
        });
        return true;
      }
    }

    // 白名單指令：保留給底層 CLI/Agent 處理，不在 CommandRouter 擋下
    if (isCommand && this.isPassthroughCommand(content)) {
      return false;
    }

    // 如果是指令但沒有匹配到任何已註冊的指令，回傳錯誤訊息
    if (isCommand) {
      await deps.connector.sendMessage(
        msg.sender.id,
        '❌ 未知指令。請使用 /start 查看可用指令列表。'
      );
      return true;
    }

    return false;
  }

  isPassthroughCommand(content: string): boolean {
    const token = content.split(/\s+/)[0] || '';
    const baseCommand = token.split('@')[0] || '';
    const whitelist = this.loadPassthroughCommandWhitelist();
    return whitelist.has(baseCommand);
  }

  private loadPassthroughCommandWhitelist(): Set<string> {
    try {
      if (!fs.existsSync('ai-config.yaml')) {
        return this.defaultPassthroughCommandWhitelist;
      }

      const fileContent = fs.readFileSync('ai-config.yaml', 'utf8');
      const config = yaml.load(fileContent) as
        | {
            passthrough_commands?: unknown;
          }
        | undefined;
      const commands = config?.passthrough_commands;

      if (!Array.isArray(commands) || commands.length === 0) {
        return this.defaultPassthroughCommandWhitelist;
      }

      const normalized = commands
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.startsWith('/'));

      return normalized.length > 0 ? new Set(normalized) : this.defaultPassthroughCommandWhitelist;
    } catch {
      return this.defaultPassthroughCommandWhitelist;
    }
  }

  private registerDefaultCommands(): void {
    this.registerCommand({
      name: 'start',
      match: (content) => content === '/start',
      execute: async ({ userId, connector }) => {
        const helpMessage = `
🤖 **歡迎使用 TeleNexus!**

我是您的 AI 助理，隨時準備協助您。

🛠 **基本指令**
- \`/reset\`: 清除 AI 短期記憶 (Context Window)
- \`/new\`: 下一則訊息使用新會話（不接續 CLI 舊 session）
- \`/send_file 路徑 | 說明\`: 回傳伺服器上的檔案到 Telegram
- \`/start\`: 顯示此說明訊息

🤖 **模型管理**
- \`/model\`: 顯示目前使用的模型
- \`/models\`: 列出所有可用模型
- \`/models opencode\`: 只列出 opencode 模型
- \`/set_model <model-id>\`: 切換使用模型（寫入 override）
- \`/reset_model\`: 清除 override，恢復 base config 設定

📅 **排程管理功能**
目前的系統內建了強大的排程系統，您可以設定定時任務讓 AI 主動執行。

**1. 新增排程**
格式：\`/add_schedule 名稱 | Cron表達式 | 提示詞\`
範例：
\`\`\`
/add_schedule 早安問候 | 0 9 * * * | 跟我說早安並報告天氣
\`\`\`

**2. 查看排程**
指令：\`/list_schedules\`

**3. 刪除排程**
指令：\`/remove_schedule [ID]\`
範例：\`/remove_schedule 1\`

若有任何問題，直接跟我說即可！
`.trim();
        await connector.sendMessage(userId, helpMessage);
      }
    });

    this.registerCommand({
      name: 'reset',
      match: (content) => content === '/reset',
      execute: async ({ userId, connector, memory }) => {
        memory.clear(userId);
        await connector.sendMessage(userId, '🧹 記憶已清除。');
      }
    });

    this.registerCommand({
      name: 'new',
      match: (content) => content === '/new',
      execute: async ({ userId, connector, requestNewSession }) => {
        requestNewSession(userId);
        await connector.sendMessage(
          userId,
          '🆕 已建立新會話。下一則訊息將使用新的 CLI session（不接續上一段對話）。'
        );
      }
    });

    this.registerCommand({
      name: 'send_file',
      match: (content) => content.startsWith('/send_file '),
      execute: async ({ userId, connector, content }) => {
        const raw = content.replace('/send_file ', '').trim();
        if (!raw) {
          await connector.sendMessage(
            userId,
            '❌ 格式錯誤。使用：/send_file 路徑 | 說明（可省略）'
          );
          return;
        }

        const [rawPathPart, rawCaptionPart] = raw.split('|');
        const pathPart = (rawPathPart || '').trim();
        const caption = (rawCaptionPart || '').trim();

        if (!pathPart) {
          await connector.sendMessage(userId, '❌ 請提供檔案路徑。');
          return;
        }

        const projectDir = resolveProjectDir();
        const resolvedPath = path.isAbsolute(pathPart)
          ? path.resolve(pathPart)
          : path.resolve(projectDir, pathPart);
        const normalizedProjectDir = path.resolve(projectDir);
        const normalizedTempDir = path.resolve(normalizedProjectDir, 'workspace', 'temp');

        if (!resolvedPath.startsWith(normalizedProjectDir + path.sep)) {
          await connector.sendMessage(userId, '❌ 安全限制：只能傳送專案目錄內的檔案。');
          return;
        }

        if (
          this.sendFileStrictTempOnly &&
          !(
            resolvedPath === normalizedTempDir ||
            resolvedPath.startsWith(normalizedTempDir + path.sep)
          )
        ) {
          await connector.sendMessage(
            userId,
            '❌ 目前為嚴格模式：僅允許傳送 workspace/temp/ 內檔案。'
          );
          return;
        }

        if (!fs.existsSync(resolvedPath)) {
          await connector.sendMessage(userId, `❌ 找不到檔案：${resolvedPath}`);
          return;
        }

        const stat = fs.statSync(resolvedPath);
        if (!stat.isFile()) {
          await connector.sendMessage(userId, '❌ 指定路徑不是檔案。');
          return;
        }

        if (stat.size > this.maxSendFileBytes) {
          await connector.sendMessage(
            userId,
            `❌ 檔案過大（${Math.ceil(stat.size / 1024 / 1024)}MB）。目前上限為 ${Math.floor(this.maxSendFileBytes / 1024 / 1024)}MB。`
          );
          return;
        }

        await connector.sendFile(userId, resolvedPath, caption || undefined);
      }
    });

    this.registerCommand({
      name: 'list_schedules',
      match: (content) => content === '/list_schedules',
      execute: async ({ userId, connector, scheduler }) => {
        const schedules = scheduler.listSchedules(userId);
        if (schedules.length === 0) {
          await connector.sendMessage(userId, '📋 目前沒有任何排程。');
          return;
        }

        const list = schedules
          .map(
            (schedule, idx) =>
              `${idx + 1}. [ID: ${schedule.id}] ${schedule.name}\n   ⏰ Cron: ${schedule.cron}\n   📝 Prompt: ${schedule.prompt}\n   ${schedule.is_active ? '✅ 啟用中' : '❌ 已停用'}`
          )
          .join('\n\n');
        await connector.sendMessage(userId, `📋 您的排程列表：\n\n${list}`);
      }
    });

    this.registerCommand({
      name: 'remove_schedule',
      match: (content) => content.startsWith('/remove_schedule '),
      execute: async ({ userId, connector, scheduler, content }) => {
        const parts = content.split(' ');
        if (parts.length !== 2) {
          await connector.sendMessage(userId, '❌ 格式錯誤。使用範例：/remove_schedule 1');
          return;
        }
        const id = Number.parseInt(parts[1]!, 10);
        if (Number.isNaN(id)) {
          await connector.sendMessage(userId, '❌ ID 必須是數字。');
          return;
        }
        try {
          scheduler.removeSchedule(id);
          await connector.sendMessage(userId, `✅ 已刪除排程 #${id}`);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          await connector.sendMessage(userId, `❌ 刪除失敗：${errMsg}`);
        }
      }
    });

    this.registerCommand({
      name: 'add_schedule',
      match: (content) => content.startsWith('/add_schedule '),
      execute: async ({ userId, connector, scheduler, content }) => {
        const { interactionGuard } = await import('../services/interaction-guard.js');
        const raw = content.replace('/add_schedule ', '').trim();
        const parts = raw.split('|').map((part) => part.trim());
        if (parts.length !== 3) {
          await connector.sendMessage(
            userId,
            '❌ 格式錯誤。使用範例：\n/add_schedule 早安問候|0 9 * * *|早安！今天天氣如何？'
          );
          return;
        }
        const [name, cron, prompt] = parts;
        interactionGuard.start(userId, {
          kind: 'add_schedule',
          expectedInput: 'processing',
          allowedCommands: ['/abort', '/help'],
          expiresInMs: 30_000
        });
        try {
          const id = scheduler.addSchedule(userId, name!, cron!, prompt!);
          await connector.sendMessage(userId, `✅ 成功新增排程 #${id}：${name}`);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          await connector.sendMessage(userId, `❌ 新增失敗：${errMsg}`);
        } finally {
          interactionGuard.clear(userId, 'add_schedule_done');
        }
      }
    });
    this.registerCommand({
      name: 'reflect',
      match: (content) => content === '/reflect',
      execute: async ({ userId, connector, scheduler }) => {
        const msgId = await connector.sendPlaceholder(userId, '🔍 分析中...');
        try {
          // 手動觸發追蹤，並傳入 msgId 以便編輯回應
          await scheduler.triggerReflection(userId, 'manual', msgId);
        } catch (error) {
          console.error('Reflection error:', error);
          if (msgId) {
            await connector.editMessage(userId, msgId, '❌ 追蹤分析失敗，請檢查系統日誌。');
          } else {
            await connector.sendMessage(userId, '❌ 追蹤分析失敗，請檢查系統日誌。');
          }
        }
      }
    });

    this.registerCommand({
      name: 'model',
      match: (content) => content === '/model',
      execute: async ({ userId, connector }) => {
        try {
          const configPath = this.resolveConfigPath();
          const overridePath = this.resolveOverridePath();
          const base = yaml.load(fs.readFileSync(configPath, 'utf8')) as
            | { model?: string }
            | undefined;
          const baseModel = base?.model?.trim();

          let overrideModel: string | undefined;
          if (fs.existsSync(overridePath)) {
            const ov = yaml.load(fs.readFileSync(overridePath, 'utf8')) as
              | { model?: string }
              | undefined;
            overrideModel = ov?.model?.trim() || undefined;
          }

          if (overrideModel) {
            await connector.sendMessage(
              userId,
              `🤖 目前使用模型：\`${overrideModel}\`（override）\n📄 基礎設定：\`${baseModel || '未設定'}\``
            );
          } else {
            await connector.sendMessage(
              userId,
              `🤖 目前使用模型：\`${baseModel || '未設定（使用 opencode 預設）'}\`（base config）`
            );
          }
        } catch {
          await connector.sendMessage(userId, '❌ 無法讀取設定檔。');
        }
      }
    });

    this.registerCommand({
      name: 'models',
      match: (content) => content === '/models' || content.startsWith('/models '),
      execute: async ({ userId, connector, content }) => {
        const providerFilter = content.slice('/models'.length).trim();
        const msgId = await connector.sendPlaceholder(userId, '🔍 載入模型清單中...');
        const send = async (text: string) => {
          if (msgId) await connector.editMessage(userId, msgId, text);
          else await connector.sendMessage(userId, text);
        };
        try {
          const args = providerFilter ? ['models', providerFilter] : ['models'];
          const { stdout } = await runProcess('opencode', args, { timeoutMs: 15000 });
          const models = stdout.trim().split('\n').filter(Boolean);
          if (models.length === 0) {
            await send(
              providerFilter
                ? `❌ 找不到 provider「${providerFilter}」的模型。`
                : '❌ 無法取得模型清單。'
            );
            return;
          }
          const MAX_DISPLAY = 40;
          const displayed = models.slice(0, MAX_DISPLAY);
          const hasMore = models.length > MAX_DISPLAY;
          const list = displayed.map((m) => `• \`${m}\``).join('\n');
          const header = providerFilter
            ? `📋 **${providerFilter}** 模型列表（共 ${models.length} 個）`
            : `📋 可用模型列表（共 ${models.length} 個）`;
          const footer = hasMore
            ? `\n\n_...還有 ${models.length - MAX_DISPLAY} 個。使用 \`/models <provider>\` 篩選，例如 \`/models opencode\`_`
            : '';
          await send(`${header}\n\n${list}${footer}`);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          await send(`❌ 無法取得模型清單：${errMsg}`);
        }
      }
    });

    this.registerCommand({
      name: 'set_model',
      match: (content) => content.startsWith('/set_model '),
      execute: async ({ userId, connector, content }) => {
        const modelId = content.slice('/set_model '.length).trim();
        if (!modelId) {
          await connector.sendMessage(
            userId,
            '❌ 格式錯誤。使用範例：`/set_model nvidia/deepseek-ai/deepseek-v4-flash`'
          );
          return;
        }
        try {
          const overridePath = this.resolveOverridePath();
          let oldModel: string | undefined;
          if (fs.existsSync(overridePath)) {
            const ov = yaml.load(fs.readFileSync(overridePath, 'utf8')) as
              | { model?: string }
              | undefined;
            oldModel = ov?.model?.trim() || undefined;
          }
          fs.writeFileSync(overridePath, `model: ${modelId}\n`, 'utf8');
          const fromStr = oldModel ? `\`${oldModel}\`` : '（base config）';
          await connector.sendMessage(
            userId,
            `✅ 模型已切換：${fromStr} → \`${modelId}\`\n下一則訊息生效。`
          );
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          await connector.sendMessage(userId, `❌ 更新失敗：${errMsg}`);
        }
      }
    });

    this.registerCommand({
      name: 'reset_model',
      match: (content) => content === '/reset_model',
      execute: async ({ userId, connector }) => {
        try {
          const overridePath = this.resolveOverridePath();
          if (!fs.existsSync(overridePath)) {
            await connector.sendMessage(
              userId,
              'ℹ️ 目前沒有 override，已使用 base config 的模型設定。'
            );
            return;
          }
          const ov = yaml.load(fs.readFileSync(overridePath, 'utf8')) as
            | { model?: string }
            | undefined;
          const oldModel = ov?.model?.trim();
          fs.unlinkSync(overridePath);
          await connector.sendMessage(
            userId,
            `✅ 已清除模型 override（\`${oldModel || '?'}\`），恢復使用 base config 設定。`
          );
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          await connector.sendMessage(userId, `❌ 清除失敗：${errMsg}`);
        }
      }
    });

    this.registerCommand({
      name: 'abort',
      match: (content) => /^\/abort(\s|$)/i.test(content),
      execute: async ({ userId, connector, msg }) => {
        const { executionQueue } = await import('./execution-queue.js');
        const { interactionGuard } = await import('../services/interaction-guard.js');
        interactionGuard.clear(userId, 'abort');
        const ok = executionQueue.cancel(userId);
        const reply = ok ? '⏹️ 已中止當前任務並清空佇列。' : 'ℹ️ 目前沒有正在執行的任務。';
        await connector.sendMessage(msg.chatId || userId, reply);
      }
    });
  }

  private resolveConfigPath(): string {
    const projectDir = resolveProjectDir();
    const absPath = path.resolve(projectDir, 'ai-config.yaml');
    return fs.existsSync(absPath) ? absPath : 'ai-config.yaml';
  }

  private resolveOverridePath(): string {
    const projectDir = resolveProjectDir();
    return path.resolve(projectDir, 'data', 'ai-config.override.yaml');
  }
}
