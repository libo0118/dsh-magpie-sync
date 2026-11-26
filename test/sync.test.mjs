import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { normalizeModel, readListing, buildPlan, fetchCatalog, listingURL } from '../lib/core.js';

const fixture = JSON.parse(await readFile(new URL('../evidence/magpie-models.json', import.meta.url), 'utf8'));

test('real Magpie catalog: 223 models with exact capacities, modalities and effort wires', () => {
  const rows = readListing(fixture);
  assert.equal(rows.length, 223);
  const gpt = rows.find(x => x.model.id === 'gpt-6-astra');
  assert.equal(gpt.model.contextWindow, 872000);
  assert.equal(gpt.model.maxTokens, 128000);
  assert.deepEqual(gpt.model.input, ['text', 'image']);
  assert.deepEqual(gpt.model.reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
  assert.ok(gpt.notes.some(x => x.includes('ultra')));
  assert.deepEqual(rows.find(x => x.model.id === 'qoder/gfmodel').model.reasoningEfforts, { high: 'high', max: 'max' });
  assert.deepEqual(rows.find(x => x.model.id === 'workbuddy/deepseek-v4.1-flash').model.reasoningEfforts, { off: 'none', low: 'low', high: 'high', max: 'max' });
});

test('ultra mapping is explicit and opt-in', () => {
  const gpt = fixture.data.find(x => x.id === 'gpt-6-astra');
  assert.equal(normalizeModel(gpt).model.reasoningEfforts.max, 'max');
  assert.equal(normalizeModel(gpt, undefined, { ultraAsMax: true }).model.reasoningEfforts.max, 'ultra');
});

test('sparse metadata preserves manual capabilities and absent aliases without guessing', () => {
  const profile = { models: [{ id: 'plain', contextWindow: 100000, maxTokens: 9000, input: ['text', 'image'], reasoningEfforts: { high: 'h' }, compat: { supportsTemperature: false }, name: 'My name' }, { id: 'missing', contextWindow: 42 }] };
  const plan = buildPlan(profile, readListing({ data: [{ id: 'plain', display_name: 'Upstream' }, { id: 'prefixed/missing', max_output_tokens: 1000 }] }), [], { preserveNames: true });
  assert.deepEqual(plan.models, profile.models);
  assert.equal(plan.changes.length, 0);
  assert.deepEqual(plan.missingIds, ['missing']);
});

test('synchronization is idempotent and preserves compat; new models require explicit selection', () => {
  const old = { models: [{ id: 'gpt-6-astra', name: 'My GPT', contextWindow: 1000000, reasoningEfforts: { off: null, low: 'low', max: 'max' }, compat: { supportsTemperature: false } }] };
  const rows = readListing(fixture);
  const first = buildPlan(old, rows, ['agy-cli/claude-opus-5-5'], { preserveNames: true });
  assert.equal(first.models.length, 2);
  assert.equal(first.changes.length, 2);
  assert.equal(first.models[0].name, 'My GPT');
  assert.deepEqual(first.models[0].compat, old.models[0].compat);
  assert.deepEqual(buildPlan({ models: first.models }, rows, [], { preserveNames: true }).changes, []);
  assert.equal(old.models[0].contextWindow, 1000000);
});

test('invalid entries and unknown levels are handled conservatively', () => {
  const rows = readListing({ models: { alias: { id: 'canonical', context_window: '32000', max_tokens: 8.5, input: ['audio', 'text'], reasoning_levels: ['future'] }, metadata: 'ignore' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model.id, 'alias');
  assert.equal(rows[0].model.contextWindow, 32000);
  assert.equal(rows[0].model.maxTokens, undefined);
  assert.equal(rows[0].model.reasoningEfforts, undefined);
  assert.deepEqual(rows[0].model.input, ['text']);
  assert.equal(normalizeModel({ id: 'non-thinking', reasoning: false }).model.reasoningEfforts, false);
  assert.throws(() => readListing({ error: 'bad' }), /缺少/);
});

test('fetch retains Magpie prefix, auth, paging; it never calls inference or forwards redirects', async () => {
  const urls = [];
  const rows = await fetchCatalog({ baseURL: 'https://example.test/magpie/v1/', api: 'openai-responses' }, 'secret-value', { fetch: async (url, init) => {
    urls.push(String(url)); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.get('authorization'), 'Bearer secret-value');
    return Response.json(urls.length === 1 ? { data: [{ id: 'a' }], has_more: true, last_id: 'a' } : { data: [{ id: 'b' }], has_more: false });
  } });
  assert.equal(urls[0], 'https://example.test/magpie/v1/models');
  assert.match(urls[1], /after=a$/); assert.equal(rows.length, 2);
  assert.equal(String(listingURL('https://example.test/magpie', 'anthropic-messages')), 'https://example.test/magpie/v1/models');
  assert.throws(() => listingURL('https://user:password@example.test', 'openai-responses'));
});

test('HTTP, oversized, malformed and cyclic paging failures preserve configuration', async () => {
  const p = { baseURL: 'https://example.test/v1' };
  await assert.rejects(fetchCatalog(p, '', { fetch: async () => new Response('private upstream error', { status: 401 }) }), /HTTP 401/);
  await assert.rejects(fetchCatalog(p, '', { fetch: async () => new Response('not json') }), /有效 JSON/);
  await assert.rejects(fetchCatalog(p, '', { fetch: async () => new Response('x'.repeat(8 * 1024 * 1024 + 1)) }), /8 MiB/);
  await assert.rejects(fetchCatalog(p, '', { fetch: async () => Response.json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }) }), /游标/);
});

test('tool-less models cannot be newly imported into a tool-using DSH route', () => {
  assert.throws(() => buildPlan({ models: [] }, readListing({ data: [{ id: 'embedding', tool_call: false }] }), ['embedding']), /工具调用/);
});

test('host preview/apply/restore uses revisions, does not expose or back up credentials', async () => {
  const { apply } = await import('../lib/index.js');
  const home = await mkdtemp(join(tmpdir(), 'magpie-plugin-test-'));
  const profile = { baseURL: 'https://example.test/magpie/v1', api: 'openai-responses', apiKeyEnv: 'MAGPIE_KEY', headers: { 'x-secret': 'header-secret' }, models: [{ id: 'gpt-6-astra', contextWindow: 1000000 }] };
  let revision = 0;
  const effects = [];
  let route;
  const config = { autoSync: false, intervalMinutes: 360, providerIds: [], preserveNames: true, ultraAsMax: false };
  const descriptors = () => [{ ns: 'custom-pi-namespace', value: { providers: { cpa: structuredClone(profile) } }, revision }, { ns: 'magpie-model-sync', value: config, revision: 0 }];
  const ctx = { profileContext: { home, dir: join(home, 'profile') }, fiber: { entry: { options: { id: 'magpie-model-sync' } } }, root: { loader: { await: async () => {} } }, logger: { info() {}, warn() {} }, on() {}, effect: fn => effects.push(fn()), credentials: { resolve: async () => ({ value: 'provider-secret' }) }, settings: { describe: descriptors, mutate: async (ns, ops, expected) => { assert.equal(ns, 'custom-pi-namespace'); assert.equal(expected, revision); profile.models = structuredClone(ops[0].value); revision++; } }, connection: { fetch: { register: value => { route = value; } } } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture);
  try {
    apply(ctx, config);
    const request = async body => (await route.fetch(new Request('http://localhost/api/magpie-model-sync', { method: 'POST', body: JSON.stringify(body) }))).json();
    const pre = await request({ action: 'preview', ns: 'custom-pi-namespace', provider: 'cpa' });
    assert.equal(pre.ok, true); assert.equal(pre.value.count, 223);
    assert.ok(!JSON.stringify(pre).includes('secret'));
    const saved = await request({ action: 'apply', planId: pre.value.planId });
    assert.equal(saved.ok, true); assert.equal(saved.value.changed, 1); assert.equal(profile.models[0].contextWindow, 872000);
    const backup = await readFile(join(home, 'magpie-model-sync', 'backups', `${saved.value.backupId}.json`), 'utf8');
    assert.ok(!backup.includes('secret')); assert.ok(!backup.includes('MAGPIE_KEY'));
    const restored = await request({ action: 'restore', backupId: saved.value.backupId });
    assert.equal(restored.ok, true); assert.equal(profile.models[0].contextWindow, 1000000);
    const stale = await request({ action: 'preview', ns: 'custom-pi-namespace', provider: 'cpa' });
    profile.models[0].name = 'Concurrent user edit'; revision++;
    const conflict = await request({ action: 'apply', planId: stale.value.planId });
    assert.equal(conflict.ok, false); assert.match(conflict.error, /变化/);
    assert.equal(profile.models[0].name, 'Concurrent user edit');
  } finally { globalThis.fetch = originalFetch; for (const dispose of effects) if (typeof dispose === 'function') dispose(); await rm(home, { recursive: true, force: true }); }
});

test('browser factory registers official Models footer and renders with shared React', async () => {
  let plugin;
  const React = (await import('../tools/test-deps/node_modules/react/index.js')).default;
  const ReactDOM = await import('../tools/test-deps/node_modules/react-dom/server.node.js');
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load: row => { assert.equal(row.id, 'dsh-magpie-sync'); plugin = row.factory(name => { assert.equal(name, 'react'); return React; }); } } } });
  let component;
  plugin.apply({ slots: { inject: (name, fn) => { assert.equal(name, 'settings.models.footer'); fn(); }, register: (options, value) => { assert.equal(options.name, 'settings.models.footer'); component = value; } } });
  const html = ReactDOM.renderToStaticMarkup(React.createElement(component, { api: async () => ({ providers: [] }) }));
  assert.match(html, /Magpie 模型同步/); assert.match(html, /获取目录与预览/);
  assert.match(html, /同步全部已配置模型/);
  assert.match(html, /仅同步当前所选模型/); assert.doesNotMatch(html, /自动同步|每 360/);
});
