import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';
import { readListing, buildPlan } from '../lib/core.js';

const metadata = { data: [{ id: 'fixture-model', context_window: 872000, max_output_tokens: 128000, reasoning: true, reasoning_levels: ['low', 'high', 'max'], native_endpoints: ['/v1/messages'] }] };

test('Messages effort metadata reaches actual pi-ai output_config.effort', async () => {
  const rows = readListing(metadata);
  const profile = { api: 'anthropic-messages', models: [{ id: 'fixture-model', compat: { allowEmptySignature: true } }] };
  const configured = buildPlan(profile, rows).models[0];
  assert.equal(configured.compat.forceAdaptiveThinking, true);
  assert.equal(configured.compat.allowEmptySignature, true);
  const explicitBudget = buildPlan({ ...profile, compat: { forceAdaptiveThinking: false } }, rows).models[0];
  assert.equal(explicitBudget.compat.forceAdaptiveThinking, undefined);
  const runtimeDir = process.env.DSH_IMPLEMENTATION_DIR ?? 'D:/develop/deepseek/resources/app/dsh';
  const { streamSimple } = await import(new URL(`file:///${runtimeDir.replace(/\\/g, '/')}/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`).href);
  const captured = [];
  const model = { ...configured, api: 'anthropic-messages', provider: 'fixture', baseUrl: 'https://fixture.test', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: configured.reasoningEfforts };
  for (const reasoning of ['high', 'max']) {
    const stream = streamSimple(model, { messages: [{ role: 'user', content: 'fixture', timestamp: 0 }] }, { apiKey: 'fixture-key', reasoning, fetch: async (_input, init) => { captured.push(JSON.parse(init.body)); return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'end fixture' } }, { status: 400 }); } });
    await stream.result();
  }
  assert.deepEqual(captured.map(x => x.output_config?.effort), ['high', 'max']);
  assert.ok(captured.every(x => x.thinking?.type === 'adaptive'));
});

test('manual mode performs no background work and syncs only the selected model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'magpie-manual-test-'));
  const originalFetch = globalThis.fetch;
  const originalInterval = globalThis.setInterval;
  const originalTimeout = globalThis.setTimeout;
  let scheduled = 0;
  let reads = 0;
  globalThis.setInterval = () => { scheduled++; return { unref() {} }; };
  globalThis.setTimeout = () => { scheduled++; return { unref() {} }; };
  const effects = [];
  const listeners = new Map();
  const other = { id: 'other-model', contextWindow: 12345, maxTokens: 2345, input: ['text'], reasoningEfforts: { low: 'custom' }, compat: { supportsTemperature: false } };
  const profile = { baseURL: 'https://fixture.test/magpie/v1', api: 'openai-responses', models: [{ id: 'fixture-model', contextWindow: 1000000 }, structuredClone(other), { id: 'missing-model', contextWindow: 777 }] };
  let revision = 0;
  let writes = 0;
  let route;
  // A persisted legacy autoSync:true must have no effect in the manual release.
  const config = { autoSync: true, intervalMinutes: 5, providerIds: [], preserveNames: true, ultraAsMax: false };
  const ctx = { profileContext: { home, dir: join(home, 'profile') }, fiber: { entry: { options: { id: 'magpie-model-sync' } } }, on: (name, fn) => listeners.set(name, fn), effect: fn => effects.push(fn()), credentials: { resolve: async () => undefined }, settings: {
    describe: () => [{ ns: 'pi', revision, value: { providers: { cpa: structuredClone(profile) } } }, { ns: 'magpie-model-sync', revision: 0, value: config }],
    mutate: async (ns, ops, expected) => { assert.equal(ns, 'pi'); assert.equal(expected, revision); profile.models = structuredClone(ops[0].value); revision++; writes++; }
  }, connection: { fetch: { register: value => { route = value; } } } };
  try {
    globalThis.fetch = async () => { reads++; return Response.json({ data: [...metadata.data, { id: 'other-model', context_window: 999999, max_output_tokens: 88888, reasoning_levels: ['high'] }] }); };
    apply(ctx, config);
    await new Promise(resolve => setImmediate(resolve));
    const request = async body => (await route.fetch(new Request('http://localhost/api/magpie-model-sync', { method: 'POST', body: JSON.stringify(body) }))).json();
    const status = await request({ action: 'status' });
    assert.equal(status.value.mode, 'manual'); assert.equal(status.value.autoSync, false);
    assert.equal(scheduled, 0); assert.equal(reads, 0); assert.equal(writes, 0);
    assert.equal(listeners.has('settings/updated'), false);
    listeners.get('credentials/reference-updated')();
    assert.equal(reads, 0);
    const saved = await request({ action: 'sync-model', provider: 'cpa', model: 'fixture-model' });
    assert.equal(saved.ok, true); assert.equal(saved.value.changed, 1); assert.equal(saved.value.model, 'fixture-model');
    assert.deepEqual(saved.value.fields, ['contextWindow', 'maxTokens', 'reasoningEfforts']);
    assert.equal(profile.models[0].contextWindow, 872000);
    assert.deepEqual(profile.models[1], other);
    assert.deepEqual(profile.models[2], { id: 'missing-model', contextWindow: 777 });
    const again = await request({ action: 'sync-model', provider: 'cpa', model: 'fixture-model' });
    assert.equal(again.value.changed, 0); assert.deepEqual(again.value.fields, []); assert.equal(writes, 1);
    const missing = await request({ action: 'sync-model', provider: 'cpa', model: 'missing-model' });
    assert.equal(missing.ok, false); assert.equal(writes, 1);
    const oldToggle = await request({ action: 'configure', values: { autoSync: true } });
    assert.equal(oldToggle.ok, false);
  } finally {
    globalThis.fetch = originalFetch; globalThis.setInterval = originalInterval; globalThis.setTimeout = originalTimeout;
    for (const dispose of effects) if (typeof dispose === 'function') dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test('check detects drift without writes and sync-all atomically updates all configured models with backup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'magpie-sync-all-test-'));
  let reads = 0;
  let writes = 0;
  let revision = 0;
  let route;
  const effects = [];
  const originalFetch = globalThis.fetch;
  const profile = {
    baseURL: 'https://fixture.test/magpie/v1',
    api: 'openai-responses',
    models: [
      { id: 'fixture-model', contextWindow: 1000000, maxTokens: 64000, reasoningEfforts: { low: 'low' } },
      { id: 'other-model', contextWindow: 12345, maxTokens: 2345, input: ['text'], reasoningEfforts: { low: 'custom' } },
      { id: 'missing-model', contextWindow: 777 }
    ]
  };
  const config = { providerIds: [], preserveNames: true, ultraAsMax: false };
  const ctx = {
    profileContext: { home, dir: join(home, 'profile') },
    fiber: { entry: { options: { id: 'magpie-model-sync' } } },
    on() {},
    effect: fn => effects.push(fn()),
    credentials: { resolve: async () => undefined },
    settings: {
      describe: () => [{ ns: 'pi', revision, value: { providers: { cpa: structuredClone(profile) } } }, { ns: 'magpie-model-sync', revision: 0, value: config }],
      mutate: async (ns, ops, expected) => { assert.equal(ns, 'pi'); assert.equal(expected, revision); profile.models = structuredClone(ops[0].value); revision++; writes++; }
    },
    connection: { fetch: { register: value => { route = value; } } }
  };
  try {
    globalThis.fetch = async () => {
      reads++;
      return Response.json({
        data: [
          ...metadata.data,
          { id: 'other-model', context_window: 999999, max_output_tokens: 88888, modalities: { input: ['text', 'image'] }, reasoning_levels: ['high'] }
        ]
      });
    };
    apply(ctx, config);
    const request = async body => (await route.fetch(new Request('http://localhost/api/magpie-model-sync', { method: 'POST', body: JSON.stringify(body) }))).json();
    const checked = await request({ action: 'check', ns: 'pi', provider: 'cpa' });
    assert.equal(checked.ok, true);
    assert.equal(checked.value.pendingCount, 2);
    assert.deepEqual(checked.value.missingIds, ['missing-model']);
    assert.deepEqual(checked.value.changes.map(c => c.id), ['fixture-model', 'other-model']);
    assert.equal(writes, 0);
    assert.equal(reads, 1);

    // Second check within 60s reuses cache
    const cachedCheck = await request({ action: 'check', ns: 'pi', provider: 'cpa' });
    assert.equal(cachedCheck.value.pendingCount, 2);
    assert.equal(reads, 1);

    // sync-all fetches fresh and updates both drifted models at once
    const synced = await request({ action: 'sync-all', ns: 'pi', provider: 'cpa' });
    assert.equal(synced.ok, true);
    assert.equal(synced.value.changed, 2);
    assert.equal(synced.value.modelCount, 3);
    assert.deepEqual(synced.value.missingIds, ['missing-model']);
    assert.equal(synced.value.updatedModels.length, 2);
    assert.equal(writes, 1);
    assert.equal(reads, 2);
    assert.equal(profile.models[0].contextWindow, 872000);
    assert.equal(profile.models[1].contextWindow, 999999);
    assert.deepEqual(profile.models[2], { id: 'missing-model', contextWindow: 777 });

    // Idempotent second sync-all
    const again = await request({ action: 'sync-all', ns: 'pi', provider: 'cpa' });
    assert.equal(again.ok, true);
    assert.equal(again.value.changed, 0);
    assert.equal(writes, 1);

    // Restore works after sync-all
    const restored = await request({ action: 'restore', backupId: synced.value.backupId });
    assert.equal(restored.ok, true);
    assert.equal(profile.models[0].contextWindow, 1000000);
    assert.equal(profile.models[1].contextWindow, 12345);
  } finally {
    globalThis.fetch = originalFetch;
    for (const dispose of effects) if (typeof dispose === 'function') dispose();
    await rm(home, { recursive: true, force: true });
  }
});
