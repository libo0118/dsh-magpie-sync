import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('current-model button reads the actual page selection and detects switched sessions', async () => {
  let plugin;
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load: row => { plugin = row.factory(() => ({})); } } } });
  let key = 'session-A';
  const binding = {};
  let snapshot = { current: { provider: 'cpa', model: 'gpt-6-astra', reasoningEffort: 'high' }, pending: null, status: 'ready', routable: false };
  let load = async () => {};
  const ctx = { uiSession: { current: { getSnapshot: () => ({ key }) } }, sessions: { binding: () => binding }, modelDirectories: { directoryFor: id => { assert.equal(id, key); return { load: () => load(), store: { getSnapshot: () => snapshot } }; } } };
  const first = await plugin.currentSelection(ctx);
  assert.equal(first.provider, 'cpa'); assert.equal(first.model, 'gpt-6-astra');
  snapshot = { ...snapshot, current: { provider: 'another-magpie', model: 'another-model' } };
  const next = await plugin.currentSelection(ctx);
  assert.equal(next.provider, 'another-magpie'); assert.equal(next.model, 'another-model');
  snapshot = { ...snapshot, pending: { provider: 'cpa', model: 'pending' }, status: 'selecting' };
  await assert.rejects(plugin.currentSelection(ctx), /正在切换/);
  snapshot = { ...snapshot, pending: null, status: 'ready' };
  load = async () => { key = 'session-B'; };
  await assert.rejects(plugin.currentSelection(ctx), /切换或重新连接/);
  key = undefined;
  await assert.rejects(plugin.currentSelection(ctx), /先打开会话/);
});
