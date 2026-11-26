import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileDir = process.env.DSH_PROFILE_DIR ?? join(dshHome, 'profiles', 'desktop');
const runtimeDir = process.env.DSH_IMPLEMENTATION_DIR;
if (!runtimeDir) throw new Error('请设置 DSH_IMPLEMENTATION_DIR 指向 DSH app/dsh 目录');
const require = createRequire(join(runtimeDir, 'package.json'));
const yaml = require('yaml');
const rows = yaml.parse(await fs.readFile(join(profileDir, 'cordis.patch.yml'), 'utf8'));
const providers = rows.find(r => r.id === 'llm-pi-ai')?.config?.providers ?? {};
const credentials = yaml.parse(await fs.readFile(join(dshHome, '.credentials.yaml'), 'utf8'));
for (const [id, p] of Object.entries(providers)) {
  if (!p.baseURL?.includes('/magpie/')) continue;
  const key = credentials.refs?.[p.apiKeyEnv] ?? process.env[p.apiKeyEnv];
  const url = p.baseURL.replace(/\/$/, '') + '/models';
  const res = await fetch(url, { headers: { ...p.headers, ...(key ? { authorization: `Bearer ${key}` } : {}), accept: 'application/json' }, signal: AbortSignal.timeout(20000), redirect: 'error' });
  console.log(JSON.stringify({ provider: id, status: res.status }));
  if (!res.ok) continue;
  const body = await res.json();
  // Model metadata only; never persist or log credentials or response headers.
  const out = new URL('../evidence/magpie-models.json', import.meta.url);
  await fs.mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
  await fs.writeFile(out, JSON.stringify(body, null, 2));
  console.log(JSON.stringify({ keys: Object.keys(body), sample: Array.isArray(body.data) ? body.data.slice(0, 3) : Object.fromEntries(Object.entries(body.models ?? {}).slice(0, 3)), count: Array.isArray(body.data) ? body.data.length : Object.keys(body.models ?? {}).length }));
}
