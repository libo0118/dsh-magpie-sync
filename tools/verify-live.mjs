import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const runtimeDir = process.env.DSH_IMPLEMENTATION_DIR;
if (!runtimeDir) throw new Error('请设置 DSH_IMPLEMENTATION_DIR 指向 DSH app/dsh 目录');
const require = createRequire(join(runtimeDir, 'package.json'));
const yaml = require('yaml');
const base = new URL(process.env.DSH_WEB_URL ?? 'http://127.0.0.1:29004');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('只验证当前本机 DSH 页面');
// Reuse this DSH host's persistent browser-session grant for a short-lived,
// in-memory owner request. Neither the grant nor the cookie is printed or saved.
const store = yaml.parse(await readFile(join(dshHome, '.credentials.yaml'), 'utf8'));
const secret = store.records?.['client-connection/browser-session']?.payload?.secret;
if (!secret) throw new Error('当前 DSH 没有可复用的本机浏览器连接记录');
const authority = base.protocol === 'https:' ? base.origin : base.host;
const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300000 })).toString('base64url');
const value = `v1.${body}.${createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')}`;
const authorities = [authority, authority.replace(/:[0-9]+$/, '')];
const cookie = [...new Set(authorities)].map(a => `dsh-auth-${createHash('sha256').update(a).digest('base64url')}=${value}`).join('; ');
const headers = { cookie, 'content-type': 'application/json' };
if (process.argv.includes('--disable-auto')) {
  const response = await fetch(new URL('/api/magpie-model-sync', base), { method: 'POST', headers, body: JSON.stringify({ action: 'configure', values: { autoSync: false } }), signal: AbortSignal.timeout(45000) });
  const result = await response.json();
  console.log(JSON.stringify({ autoSyncDisabled: result.ok }));
  if (!result.ok) throw new Error(result.error);
}
const rpc = async (method, payload) => {
  const res = await fetch(new URL(`/api/${method}`, base), { method: 'POST', headers, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: payload } }), signal: AbortSignal.timeout(45000) });
  return res.json();
};
if (process.argv.includes('--reload') || process.argv.includes('--enable')) {
  for (const enabled of process.argv.includes('--enable') ? [true] : [false, true]) {
    const changed = await rpc('pluginManager/setBundleEnabled', { name: 'dsh-magpie-sync', enabled });
    console.log(JSON.stringify({ reloadedStep: enabled ? 'enable' : 'disable', response: changed }));
    if (changed.result?.ok === false) throw new Error('DSH 插件管理重载失败');
  }
}
console.log('Verify: existing GUI index');
const index = await fetch(base, { headers, signal: AbortSignal.timeout(10000) });
const html = await index.text();
console.log('Verify: plugin status');
const statusRes = await fetch(new URL('/api/magpie-model-sync', base), { method: 'POST', headers, body: JSON.stringify({ action: 'status' }), signal: AbortSignal.timeout(10000) });
let status;
try { status = await statusRes.json(); } catch { status = { unavailable: true }; }
if (process.argv.includes('--sync-one')) {
  const response = await fetch(new URL('/api/magpie-model-sync', base), { method: 'POST', headers, body: JSON.stringify({ action: 'sync-model', provider: 'cpa', model: 'gpt-6-astra' }), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  console.log(JSON.stringify({ manualSingleModel: value }));
  if (!value.ok) throw new Error(value.error);
}
const inventory = await rpc('pluginInventory/list', {});
const plugin = inventory.result?.value?.entries?.find(x => x.moduleName === 'dsh-magpie-sync');
const evidence = { url: base.origin, indexStatus: index.status, clientManifestPresent: html.includes('dsh-magpie-sync'), pluginStatus: statusRes.status, state: status, inventory: plugin ?? inventory.result?.error ?? null, checkedAt: new Date().toISOString() };
console.log(JSON.stringify(evidence, null, 2));
await writeFile(new URL('../evidence/live-verification.json', import.meta.url), JSON.stringify(evidence, null, 2));
