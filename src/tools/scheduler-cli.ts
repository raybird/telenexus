#!/usr/bin/env node
import { Command } from 'commander';
import { MemoryManager } from '../core/memory.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

type SchedulerHealth = {
  updatedAt?: number;
  lastReloadAt?: number;
  lastLoadedScheduleCount?: number;
  trigger?: string;
  pid?: number;
};

function resolveHealthPath(): string {
  const explicitPath = process.env.DB_PATH?.trim();
  if (explicitPath) {
    return path.resolve(path.dirname(explicitPath), 'scheduler-health.json');
  }

  const dbDir = process.env.DB_DIR?.trim();
  if (dbDir) {
    return path.resolve(dbDir, 'scheduler-health.json');
  }

  return path.resolve(process.cwd(), 'scheduler-health.json');
}

function readSchedulerHealth(): SchedulerHealth | null {
  try {
    const healthPath = resolveHealthPath();
    if (!fs.existsSync(healthPath)) {
      return null;
    }
    const content = fs.readFileSync(healthPath, 'utf8');
    return JSON.parse(content) as SchedulerHealth;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryHttpReload(): Promise<boolean> {
  const webPort = process.env.WEB_PORT?.trim() || '3030';
  const explicitUrl = process.env.SCHEDULER_RELOAD_URL?.trim();
  const candidates = [
    explicitUrl,
    `http://telenexus:${webPort}/api/schedules/reload`,
    `http://127.0.0.1:${webPort}/api/schedules/reload`
  ].filter((item): item is string => typeof item === 'string' && item.length > 0);

  const authToken =
    process.env.SCHEDULER_RELOAD_TOKEN?.trim() || process.env.WEB_AUTH_TOKEN?.trim();

  for (const endpoint of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text();
        console.log(`⚠️  HTTP reload failed at ${endpoint}: ${response.status} ${text}`);
        continue;
      }

      console.log(`✅ Reload requested via HTTP: ${endpoint}`);
      return true;
    } catch (error: any) {
      const message = error?.message || String(error);
      console.log(`⚠️  HTTP reload unavailable at ${endpoint}: ${message}`);
    }
  }

  return false;
}

async function verifyReloadDelivery(previousReloadAt?: number): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    const health = readSchedulerHealth();
    const currentReloadAt = health?.lastReloadAt;
    if (
      typeof currentReloadAt === 'number' &&
      (!previousReloadAt || currentReloadAt > previousReloadAt)
    ) {
      const ts = new Date(currentReloadAt).toLocaleString('zh-TW');
      const scheduleCount = health?.lastLoadedScheduleCount;
      const countInfo = typeof scheduleCount === 'number' ? `, loaded=${scheduleCount}` : '';
      console.log(`🩺 Reload confirmed at ${ts}${countInfo}.`);
      return true;
    }
    await sleep(250);
  }

  console.log('⚠️  Reload signal was sent but no fresh health marker was detected.');
  console.log(`💡 Tip: Check main service logs and health file: ${resolveHealthPath()}`);
  return false;
}

const program = new Command();

program
  .name('scheduler-cli')
  .description('CLI tool for managing TeleNexus schedules')
  .version('2.2.0');

/**
 * 尋找主程序的 PID 並發送 SIGUSR1 信號
 */
async function notifyMainProcess(): Promise<{ ok: boolean; method: 'http' | 'signal' | 'none' }> {
  try {
    const httpReloaded = await tryHttpReload();
    if (httpReloaded) {
      return { ok: true, method: 'http' };
    }

    // 尋找 node dist/main.js 或 tsx src/main.ts 的 PID（含 command line 便於除錯）
    const { stdout } = await execAsync('pgrep -af "dist/main.js|tsx.*src/main.ts"');
    const processes = stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) return null;
        return {
          pid: Number.parseInt(match[1]!, 10),
          command: match[2]!
        };
      })
      .filter((proc): proc is { pid: number; command: string } => proc !== null)
      .filter((proc) => Number.isFinite(proc.pid) && proc.pid > 0)
      .filter((proc) => proc.pid !== process.pid)
      .filter((proc) => !proc.command.includes('pgrep -af'))
      .filter((proc) => !proc.command.includes('scheduler-cli'))
      .filter((proc) => {
        const isProdMain = proc.command.includes('node dist/main.js');
        const isDevMain =
          proc.command.includes('src/main.ts') &&
          !proc.command.includes('tsx watch') &&
          !proc.command.includes('node_modules/.bin/tsx') &&
          !proc.command.startsWith('sh -c');
        return isProdMain || isDevMain;
      });

    if (processes.length === 0) {
      console.log('⚠️  Warning: Main process not found. Schedules will be loaded on next restart.');
      console.log(
        '💡 Tip: In Docker Compose, use `docker compose exec telenexus ...` (avoid `docker compose run ...`).'
      );
      return { ok: false, method: 'none' };
    }

    console.log(`🔎 Found ${processes.length} main process candidate(s):`);
    for (const proc of processes) {
      console.log(`   - PID ${proc.pid}: ${proc.command}`);
    }

    // 發送 SIGUSR1 給所有匹配的程序
    let sentCount = 0;
    let permissionDeniedCount = 0;
    for (const proc of processes) {
      try {
        process.kill(proc.pid, 'SIGUSR1');
        sentCount += 1;
        console.log(`✅ Sent reload signal to process ${proc.pid}`);
      } catch (signalError: any) {
        const code = signalError?.code ? ` (${signalError.code})` : '';
        if (signalError?.code === 'EPERM') {
          permissionDeniedCount += 1;
        }
        console.log(
          `⚠️  Warning: Failed to signal process ${proc.pid}${code}: ${signalError?.message || signalError}`
        );
      }
    }

    if (sentCount === 0) {
      console.log(
        '⚠️  Warning: Could not notify any main process. Schedules will be loaded on next restart.'
      );
      if (permissionDeniedCount === processes.length) {
        console.log(
          '💡 Tip: You may be signaling a process in another namespace/container. Run this command inside the main service container.'
        );
      }
      return { ok: false, method: 'none' };
    }

    return { ok: true, method: 'signal' };
  } catch (error) {
    const err = error as any;
    const code = err?.code ? ` (${err.code})` : '';
    console.log(
      `⚠️  Warning: Could not notify main process${code}. Schedules will be loaded on next restart.`
    );
    if (err?.message) {
      console.log(`   Details: ${err.message}`);
    }
    console.log(
      '💡 Tip: In Docker Compose, run scheduler commands with `docker compose exec telenexus ...`.'
    );
    return { ok: false, method: 'none' };
  }
}

program
  .command('add')
  .description('Add a new schedule')
  .argument('<name>', 'Schedule name')
  .argument('<cron>', 'Cron expression (e.g., "0 9 * * *")')
  .argument('<prompt>', 'Prompt to execute')
  .option('-u, --user <userId>', 'User ID', process.env.ALLOWED_USER_ID || '')
  .action(async (name: string, cron: string, prompt: string, options: { user: string }) => {
    if (!options.user) {
      console.error('❌ Error: User ID is required. Set ALLOWED_USER_ID or use --user flag.');
      process.exit(1);
    }

    try {
      const beforeHealth = readSchedulerHealth();
      const memory = new MemoryManager();
      const id = memory.addSchedule(options.user, name, cron, prompt);
      console.log(`✅ Schedule added successfully!`);
      console.log(`   ID: ${id}`);
      console.log(`   Name: ${name}`);
      console.log(`   Cron: ${cron}`);
      console.log(`   Prompt: ${prompt}`);

      const notified = await notifyMainProcess();
      if (!notified.ok) {
        console.log(
          'ℹ️  Schedule is saved. It will take effect after service restart if reload signal is not delivered.'
        );
      } else if (notified.method === 'signal') {
        await verifyReloadDelivery(beforeHealth?.lastReloadAt);
      } else {
        console.log('🩺 Reload accepted by HTTP endpoint.');
      }
    } catch (error) {
      console.error('❌ Error adding schedule:', error);
      process.exit(1);
    }
  });

program
  .command('remove')
  .description('Remove a schedule by ID')
  .argument('<id>', 'Schedule ID to remove')
  .action(async (id: string) => {
    try {
      const beforeHealth = readSchedulerHealth();
      const memory = new MemoryManager();
      const scheduleId = parseInt(id, 10);

      if (isNaN(scheduleId)) {
        console.error('❌ Error: Invalid schedule ID. Must be a number.');
        process.exit(1);
      }

      memory.removeSchedule(scheduleId);
      console.log(`✅ Schedule #${scheduleId} removed successfully!`);

      const notified = await notifyMainProcess();
      if (!notified.ok) {
        console.log(
          'ℹ️  Schedule is removed from DB. Running jobs may persist until next restart/reload.'
        );
      } else if (notified.method === 'signal') {
        await verifyReloadDelivery(beforeHealth?.lastReloadAt);
      } else {
        console.log('🩺 Reload accepted by HTTP endpoint.');
      }
    } catch (error) {
      console.error('❌ Error removing schedule:', error);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List all schedules')
  .option('-u, --user <userId>', 'Filter by user ID', process.env.ALLOWED_USER_ID || '')
  .action((options: { user: string }) => {
    try {
      const memory = new MemoryManager();
      const schedules = options.user
        ? memory.getUserSchedules(options.user)
        : memory.getActiveSchedules();

      if (schedules.length === 0) {
        console.log('📋 No schedules found.');
        return;
      }

      console.log(`📋 Found ${schedules.length} schedule(s):\n`);

      for (const schedule of schedules) {
        const status = schedule.is_active ? '✅ Active' : '❌ Inactive';
        console.log(`ID: ${schedule.id}`);
        console.log(`Name: ${schedule.name}`);
        console.log(`Cron: ${schedule.cron}`);
        console.log(`Prompt: ${schedule.prompt}`);
        console.log(`User: ${schedule.user_id}`);
        console.log(`Status: ${status}`);
        console.log(`Created: ${new Date(schedule.created_at).toLocaleString('zh-TW')}`);
        console.log('---');
      }
    } catch (error) {
      console.error('❌ Error listing schedules:', error);
      process.exit(1);
    }
  });

program
  .command('reload')
  .description('Notify main process to reload schedules')
  .action(async () => {
    const beforeHealth = readSchedulerHealth();
    const notified = await notifyMainProcess();
    if (!notified.ok) {
      process.exit(1);
    }
    if (notified.method === 'signal') {
      await verifyReloadDelivery(beforeHealth?.lastReloadAt);
      console.log('✅ Reload signal sent successfully.');
    } else {
      console.log('✅ Reload requested successfully via HTTP.');
    }
  });

program
  .command('health')
  .description('Show scheduler health marker written by main process')
  .action(() => {
    const healthPath = resolveHealthPath();
    const health = readSchedulerHealth();
    if (!health) {
      console.log(`⚠️  No scheduler health marker found: ${healthPath}`);
      process.exit(1);
    }

    console.log(`📍 Health file: ${healthPath}`);
    if (typeof health.updatedAt === 'number') {
      console.log(`Updated: ${new Date(health.updatedAt).toLocaleString('zh-TW')}`);
    }
    if (typeof health.lastReloadAt === 'number') {
      console.log(`Last Reload: ${new Date(health.lastReloadAt).toLocaleString('zh-TW')}`);
    }
    if (typeof health.lastLoadedScheduleCount === 'number') {
      console.log(`Loaded Schedules: ${health.lastLoadedScheduleCount}`);
    }
    if (health.trigger) {
      console.log(`Trigger: ${health.trigger}`);
    }
    if (typeof health.pid === 'number') {
      console.log(`Main PID: ${health.pid}`);
    }
  });

program.parse();
