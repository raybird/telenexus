import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

test('optional Memoria UI shares memory and preserves upstream loopback-only mode', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  for (const file of ['docker-compose.yml', 'docker-compose.release.yml']) {
    const compose = yaml.load(fs.readFileSync(path.join(root, file), 'utf8')) as {
      services: Record<
        string,
        {
          profiles?: string[];
          network_mode?: string;
          command?: string[];
          environment?: Record<string, unknown>;
          volumes?: string[];
          ports?: unknown[];
          read_only?: boolean;
          depends_on?: Record<string, unknown>;
        }
      >;
    };
    const ui = compose.services['memoria-ui'];
    assert.ok(ui, `${file} must offer the UI service`);
    assert.deepEqual(ui.profiles, ['memory-ui']);
    assert.equal(ui.network_mode, 'host');
    assert.deepEqual(ui.command, ['memoria', 'serve', '--ui']);
    assert.equal(ui.environment?.MEMORIA_VECTOR_ENABLED, '0');
    assert.equal(ui.environment?.MEMORIA_PORT, '${MEMORIA_UI_PORT:-3918}');
    assert.deepEqual(ui.volumes, ['memoria_data:/data']);
    assert.equal(ui.read_only, true);
    assert.equal(ui.ports, undefined);
    assert.ok(ui.depends_on?.memoria);
    assert.ok(!compose.services.memoria?.command?.includes('--ui'));
  }
});
