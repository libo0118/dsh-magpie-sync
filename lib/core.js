import { createHash } from 'node:crypto';

export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => record(o) && Object.hasOwn(o, k);
const label = (...values) => values.find(v => typeof v === 'string' && v.trim().length)?.trim();
const capacity = (...values) => values.map(v => typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v).find(v => Number.isSafeInteger(v) && v > 0);
export const digest = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');

export function isMagpie(id, profile, explicit = []) {
  if (explicit.includes(id)) return true;
  try { return /\/magpie(?:\/|$)/i.test(new URL(profile.baseURL).pathname) || /magpie/i.test(`${id} ${profile.displayName ?? ''}`); }
  catch { return false; }
}

export function listingURL(baseURL, api) {
  const url = new URL(baseURL);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('模型端点应为不含账号、查询串或片段的 HTTP(S) URL');
  let path = url.pathname.replace(/\/+$/, '');
  if (!/\/models$/.test(path)) path += api === 'anthropic-messages' && !/\/v1$/.test(path) ? '/v1/models' : '/models';
  url.pathname = path;
  return url;
}

export function normalizeModel(raw, key, options = {}) {
  if (!record(raw)) return undefined;
  const id = label(key, raw.id);
  if (!id) return undefined;
  const notes = [];
  const model = { id };
  const name = label(raw.magpie_label, raw.display_name, raw.displayName, raw.name);
  if (name) model.name = name;
  const context = capacity(raw.context_window, raw.contextWindow, raw.context_length, raw.max_input_tokens, raw.limit?.context);
  const output = capacity(raw.max_output_tokens, raw.maxOutputTokens, raw.maxTokens, raw.max_tokens, raw.limit?.output, raw.top_provider?.max_completion_tokens);
  if (context) model.contextWindow = context;
  if (output) model.maxTokens = output;
  const inputs = raw.modalities?.input ?? raw.input_modalities ?? raw.inputModalities ?? raw.input ?? raw.architecture?.input_modalities;
  if (Array.isArray(inputs)) {
    const supported = [...new Set(inputs.filter(x => x === 'text' || x === 'image'))];
    if (supported.length) model.input = supported;
    const extra = inputs.filter(x => !['text', 'image'].includes(x));
    if (extra.length) notes.push(`DSH 输入选项以外的模态：${extra.join(', ')}`);
  }
  const advertised = raw.reasoning_levels ?? raw.supported_reasoning_levels ?? raw.supported_reasoning_efforts;
  const wires = Array.isArray(advertised) ? [...new Set(advertised.map(x => typeof x === 'string' ? x : x?.effort ?? x?.id).filter(x => typeof x === 'string' && x.length))] : undefined;
  if (raw.reasoning === false) model.reasoningEfforts = false;
  else if (wires) {
    const efforts = {};
    for (const wire of wires) {
      const level = ['none', 'disabled', 'off'].includes(wire) ? 'off' : wire;
      if (LEVELS.includes(level)) efforts[level] = wire;
      else notes.push(`上游档位 ${wire} 未在 DSH 档位列表中`);
    }
    if (options.ultraAsMax && wires.includes('ultra')) {
      efforts.max = 'ultra';
      notes.push('DSH max → Magpie ultra（显式启用的映射）');
    }
    if (Object.keys(efforts).some(x => x !== 'off')) model.reasoningEfforts = efforts;
    else if (wires.length && wires.every(x => ['none', 'off', 'disabled'].includes(x))) model.reasoningEfforts = false;
    else notes.push('未取得可映射的思维档位，保留现有配置');
  } else if (record(raw.reasoningEfforts)) {
    const efforts = Object.fromEntries(Object.entries(raw.reasoningEfforts).filter(([k, v]) => LEVELS.includes(k) && (typeof v === 'string' && v.length || k === 'off' && v === null)));
    if (Object.keys(efforts).some(x => x !== 'off')) model.reasoningEfforts = efforts;
  }
  const missing = ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts'].filter(k => !own(model, k));
  if (missing.length) notes.push(`上游未公布：${missing.join(', ')}；保留已有值`);
  if (raw.tool_call === false) notes.push('上游标记不支持工具调用');
  return { model, reasoningLevels: wires ?? [], toolCall: typeof raw.tool_call === 'boolean' ? raw.tool_call : undefined, nativeEndpoints: Array.isArray(raw.native_endpoints) ? raw.native_endpoints.filter(x => typeof x === 'string') : [], notes };
}

export function readListing(body, options = {}) {
  if (!record(body)) throw new Error('模型目录应为 JSON 对象');
  let rows;
  if (Array.isArray(body.data)) rows = body.data.map(raw => [undefined, raw]);
  else if (record(body.models)) rows = Object.entries(body.models);
  else throw new Error('模型目录缺少 data 数组或 models 对象');
  const seen = new Set();
  return rows.flatMap(([key, raw]) => {
    const normalized = normalizeModel(raw, key, options);
    if (!normalized || seen.has(normalized.model.id)) return [];
    seen.add(normalized.model.id);
    return [normalized];
  });
}

export async function fetchCatalog(profile, key, options = {}) {
  const url = listingURL(profile.baseURL, profile.api);
  const headers = new Headers(profile.headers ?? {});
  headers.set('accept', 'application/json');
  if (key) {
    if (profile.api === 'anthropic-messages') { headers.set('x-api-key', key); headers.set('anthropic-version', '2023-06-01'); }
    else headers.set('authorization', `Bearer ${key}`);
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const result = [];
  const seen = new Set();
  let bytes = 0;
  const cursors = new Set();
  for (let page = 0; page < 20; page++) {
    let res;
    try { res = await (options.fetch ?? fetch)(url, { method: 'GET', headers, redirect: 'error', signal }); }
    catch { throw new Error(signal.aborted ? '模型目录请求已超时或取消' : '模型目录连接失败（请检查端点与网络）'); }
    if (!res.ok) { await res.body?.cancel(); throw new Error(`Magpie 模型目录返回 HTTP ${res.status}`); }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('模型目录响应为空');
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('模型目录超过 8 MiB 上限'); }
        chunks.push(next.value); length += next.value.byteLength;
      }
    } finally { reader.releaseLock(); }
    const buffer = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    let body;
    try { body = JSON.parse(new TextDecoder().decode(buffer)); }
    catch { throw new Error('模型目录响应不是有效 JSON'); }
    for (const item of readListing(body, options)) if (!seen.has(item.model.id)) { seen.add(item.model.id); result.push(item); }
    if (!body.has_more) return result;
    const cursor = label(body.last_id);
    if (!cursor || cursors.has(cursor)) throw new Error('模型目录分页缺少有效的后续游标');
    cursors.add(cursor); url.searchParams.set('after', cursor);
  }
  throw new Error('模型目录分页超过 20 页');
}

// Only metadata explicitly advertised by the upstream is replaced. No alias guessing.
export function buildPlan(profile, catalog, selectedIds = [], options = {}) {
  const old = Array.isArray(profile.models) ? profile.models : [];
  const byId = new Map(catalog.map(x => [x.model.id, x]));
  const models = old.map(x => structuredClone(x));
  const onlyIds = options.onlyIds === undefined ? undefined : new Set(options.onlyIds);
  const changes = [];
  const missingIds = [];
  const materialize = (previous, found) => {
    const incoming = { ...found.model };
    if (options.preserveNames && previous.name) delete incoming.name;
    const next = { ...previous, ...incoming };
    // A Magpie Messages catalog advertising effort levels needs adaptive
    // dispatch in pi-ai; legacy budget-only models advertise no such levels.
    if (profile.api === 'anthropic-messages' && found.reasoningLevels.some(x => !['off', 'none', 'disabled'].includes(x)) && next.reasoningEfforts && previous.compat?.forceAdaptiveThinking !== false && profile.compat?.forceAdaptiveThinking !== false) {
      next.compat = { ...previous.compat, forceAdaptiveThinking: true };
    }
    return next;
  };
  for (let index = 0; index < models.length; index++) {
    const previous = models[index];
    if (onlyIds && !onlyIds.has(previous.id)) continue;
    const found = byId.get(previous.id);
    if (!found) { missingIds.push(previous.id); continue; }
    const next = materialize(previous, found);
    const fields = Object.keys(next).filter(k => k !== 'id' && digest(previous[k]) !== digest(next[k]));
    if (fields.length) { models[index] = next; changes.push({ id: previous.id, type: 'update', fields, before: previous, after: next }); }
  }
  const existing = new Set(old.map(x => x.id));
  for (const id of new Set(selectedIds)) {
    if (existing.has(id)) continue;
    const found = byId.get(id);
    if (!found) throw new Error(`目录中没有模型：${id}`);
    if (found.toolCall === false) throw new Error(`模型 ${id} 未提供 DSH 所需的工具调用能力`);
    const next = materialize({}, found);
    models.push(next); changes.push({ id, type: 'add', fields: Object.keys(next), after: next }); existing.add(id);
  }
  return { models, changes, missingIds };
}
