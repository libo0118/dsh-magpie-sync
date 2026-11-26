import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { isMagpie, fetchCatalog, buildPlan, digest } from './core.js';

export const inject = ['settings', 'credentials', 'connection', 'profileContext'];
export const Config = z.object({
  providerIds: z.array(z.string()).default([]).description('额外纳入同步的提供商 ID；默认按 Magpie 地址识别').volatile(),
  preserveNames: z.boolean().default(true).description('保留已有模型的显示名称').volatile(),
  ultraAsMax: z.boolean().default(false).description('将 DSH 的 max 档位映射为上游 ultra；关闭时保留 max → max').volatile()
});
const val = v => typeof v?.get === 'function' ? v.get() : v;
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

export function apply(ctx, config) {
  const plans = new Map();
  const catalogs = new Map();
  const results = new Map();
  const abort = new AbortController();
  let running = false;
  let closed = false;
  const options = () => ({ ultraAsMax: val(config.ultraAsMax), preserveNames: val(config.preserveNames), signal: abort.signal });
  const backupDir = join(ctx.profileContext.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'magpie-model-sync', 'backups');
  const descriptors = () => ctx.settings.describe();
  const sources = () => descriptors().flatMap(d => {
    if (!d.value?.providers) return [];
    return Object.entries(d.value.providers).flatMap(([provider, profile]) => isMagpie(provider, profile, val(config.providerIds) ?? []) ? [{ ns: d.ns, revision: d.revision, provider, profile }] : []);
  });
  const source = (ns, provider) => {
    const matches = sources().filter(x => (ns === undefined || x.ns === ns) && x.provider === provider);
    if (matches.length !== 1) throw new Error('当前模型的 Magpie 提供商未配置或存在多个同名连接');
    return matches[0];
  };
  const cacheKey = s => `${s.ns}:${s.provider}`;
  const fingerprint = (s, opts = options()) => digest({ profile: s.profile, options: { ultraAsMax: opts.ultraAsMax, preserveNames: opts.preserveNames } });
  async function load(s, fresh = false, opts = options()) {
    const key = cacheKey(s);
    const cached = catalogs.get(key);
    const signature = digest({ baseURL: s.profile.baseURL, api: s.profile.api, ref: s.profile.apiKeyEnv, headers: s.profile.headers, ultraAsMax: opts.ultraAsMax });
    if (!fresh && cached?.signature === signature && Date.now() - cached.at < 60000) return cached.rows;
    const hit = s.profile.apiKeyEnv ? await ctx.credentials.resolve(s.profile.apiKeyEnv) : undefined;
    const rows = await fetchCatalog(s.profile, hit?.value, opts);
    if (!rows.length) throw new Error('Magpie 返回了空目录，已保留模型设置');
    catalogs.set(key, { rows, at: Date.now(), signature });
    return rows;
  }
  async function preview(s, selectedIds = [], fresh = false, onlyModel) {
    const opts = options();
    const beforeFingerprint = fingerprint(s, opts);
    const rows = await load(s, fresh, opts);
    if (closed) throw new Error('同步任务已停止');
    if (fingerprint(source(s.ns, s.provider)) !== beforeFingerprint) throw new Error('获取目录期间配置已变化，请重新预览');
    if (onlyModel && !rows.some(x => x.model.id === onlyModel)) throw new Error(`Magpie 目录中暂未列出 ${onlyModel}，已保留当前配置`);
    const next = buildPlan(s.profile, rows, selectedIds, { ...opts, ...(onlyModel ? { onlyIds: [onlyModel] } : {}) });
    const id = randomUUID();
    for (const [key, plan] of plans) if (Date.now() - plan.at > 300000) plans.delete(key);
    if (plans.size >= 30) plans.delete(plans.keys().next().value);
    const plan = { id, ns: s.ns, provider: s.provider, fingerprint: beforeFingerprint, models: next.models, changes: next.changes, missingIds: next.missingIds, at: Date.now() };
    plans.set(id, plan);
    return { planId: id, provider: s.provider, fetchedAt: new Date().toISOString(), count: rows.length, changes: next.changes, missingIds: next.missingIds, catalog: rows.map(x => ({ ...x, configured: s.profile.models?.some(m => m.id === x.model.id) ?? false })) };
  }
  async function saveBackup(s, next) {
    const id = randomUUID();
    await mkdir(backupDir, { recursive: true });
    const file = join(backupDir, `${id}.json`);
    const backup = { version: 1, id, time: new Date().toISOString(), profile: ctx.profileContext.dir, ns: s.ns, provider: s.provider, before: s.profile.models ?? null, after: next };
    await writeFile(`${file}.tmp`, JSON.stringify(backup, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(`${file}.tmp`, file);
    return id;
  }
  async function commit(id) {
    if (closed) throw new Error('同步任务已停止');
    const plan = plans.get(id);
    if (!plan || Date.now() - plan.at > 300000) throw new Error('同步预览已过期，请重新获取');
    const s = source(plan.ns, plan.provider);
    if (fingerprint(s) !== plan.fingerprint) throw new Error('模型配置或同步选项已变化，请重新预览');
    if (!plan.changes.length) { plans.delete(id); return { changed: 0 }; }
    const backupId = await saveBackup(s, plan.models);
    if (closed) throw new Error('同步任务已停止');
    // Revision validation is performed inside DSH's profile writer lock.
    await ctx.settings.mutate(s.ns, [{ op: 'set', path: ['providers', s.provider, 'models'], value: plan.models }], s.revision);
    plans.delete(id);
    const value = { changed: plan.changes.length, backupId, time: new Date().toISOString(), missingIds: plan.missingIds };
    results.set(cacheKey(s), value);
    return value;
  }
  async function restore(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('备份编号无效');
    const backup = JSON.parse(await readFile(join(backupDir, `${id}.json`), 'utf8'));
    if (backup.version !== 1 || backup.profile !== ctx.profileContext.dir) throw new Error('备份不属于当前 DSH profile');
    const s = source(backup.ns, backup.provider);
    if (digest(s.profile.models) !== digest(backup.after)) throw new Error('模型已在同步后被修改，请先预览当前配置');
    const op = backup.before === null ? { op: 'unset', path: ['providers', s.provider, 'models'] } : { op: 'set', path: ['providers', s.provider, 'models'], value: backup.before };
    await ctx.settings.mutate(s.ns, [op], s.revision);
    results.set(cacheKey(s), { restored: true, time: new Date().toISOString() });
    return { restored: true };
  }
  // Credentials changes only invalidate the cache. All reads/writes are initiated by a button.
  ctx.on('credentials/reference-updated', () => { catalogs.clear(); });
  ctx.effect(() => () => { closed = true; abort.abort(); plans.clear(); catalogs.clear(); });
  ctx.connection.fetch.register({
    path: '/api/magpie-model-sync', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const text = await request.text();
        if (text.length > 65536) return json({ ok: false, error: '请求超过大小上限' }, 413);
        let input;
        try { input = JSON.parse(text); } catch { return json({ ok: false, error: '请求需要有效 JSON' }, 400); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求格式无效');
        if (input.action === 'status') return json({ ok: true, value: { mode: 'manual', autoSync: false, running, ultraAsMax: val(config.ultraAsMax), providers: sources().map(s => ({ ns: s.ns, id: s.provider, name: s.profile.displayName ?? s.provider, modelCount: s.profile.models?.length ?? 0, result: results.get(cacheKey(s)) })) } });
        if (input.action === 'check') {
          const s = source(input.ns, input.provider);
          const opts = options();
          const rows = await load(s, Boolean(input.fresh), opts);
          const next = buildPlan(s.profile, rows, [], opts);
          return json({
            ok: true,
            value: {
              provider: s.provider,
              modelCount: s.profile.models?.length ?? 0,
              catalogCount: rows.length,
              pendingCount: next.changes.length,
              changes: next.changes.map(c => ({ id: c.id, fields: c.fields })),
              missingIds: next.missingIds,
              checkedAt: new Date().toISOString()
            }
          });
        }
        if (input.action === 'configure') {
          const ns = ctx.fiber.entry?.options.id ?? 'magpie-model-sync';
          const descriptor = descriptors().find(d => d.ns === ns);
          if (!descriptor) throw new Error('同步插件设置暂未就绪');
          const entries = Object.entries(input.values ?? {});
          if (!entries.length || entries.some(([k, v]) => !['preserveNames', 'ultraAsMax'].includes(k) || typeof v !== 'boolean')) throw new Error('同步选项格式无效');
          await ctx.settings.mutate(ns, entries.map(([k, v]) => ({ op: 'set', path: [k], value: v })), descriptor.revision);
          return json({ ok: true, value: { saved: true } });
        }
        if (input.action === 'preview') {
          if (running) throw new Error('同步正在进行，请稍后重试');
          if (input.ids !== undefined && (!Array.isArray(input.ids) || input.ids.length > 1000 || input.ids.some(x => typeof x !== 'string'))) throw new Error('模型选择格式无效');
          return json({ ok: true, value: await preview(source(input.ns, input.provider), input.ids ?? [], Boolean(input.fresh)) });
        }
        if (input.action === 'apply' || input.action === 'restore' || input.action === 'sync-model' || input.action === 'sync-all') {
          if (running) throw new Error('同步正在进行，请稍后重试');
          running = true;
          try {
            if (input.action === 'sync-all') {
              const s = source(input.ns, input.provider);
              if (!s.profile.models?.length) throw new Error('该 Magpie 提供商尚未配置模型，请先通过「获取目录与预览」添加模型');
              const plan = await preview(s, [], true);
              const saved = await commit(plan.planId);
              return json({ ok: true, value: { ...saved, provider: s.provider, modelCount: s.profile.models?.length ?? 0, missingIds: plan.missingIds, updatedModels: plan.changes.map(c => ({ id: c.id, fields: c.fields })) } });
            }
            if (input.action === 'sync-model') {
              if (typeof input.provider !== 'string' || typeof input.model !== 'string' || !input.model.length) throw new Error('请先在当前会话选择一个模型');
              const s = source(input.ns, input.provider);
              if (!s.profile.models?.some(x => x.id === input.model)) throw new Error('当前模型未在该 Magpie 连接中配置，请先添加模型');
              const plan = await preview(s, [], true, input.model);
              return json({ ok: true, value: { ...await commit(plan.planId), provider: s.provider, model: input.model, fields: plan.changes[0]?.fields ?? [] } });
            }
            return json({ ok: true, value: input.action === 'apply' ? await commit(input.planId) : await restore(input.backupId) });
          } finally { running = false; }
        }
        throw new Error('未知同步操作');
      } catch (error) { return json({ ok: false, error: error?.message ?? '同步操作失败' }, 400); }
    }
  });
}
