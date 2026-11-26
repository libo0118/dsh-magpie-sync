window.__ModuleLoader__.load({
  id: 'dsh-magpie-sync',
  factory: require => {
    const React = require('react');
    const { createElement: h, useEffect, useRef, useState } = React;
    const FIELD_LABELS = { contextWindow: '上下文', maxTokens: '最大输出', input: '输入能力', reasoningEfforts: '推理档位', compat: '兼容参数', name: '名称' };
    const formatFields = fields => (fields ?? []).map(f => FIELD_LABELS[f] ?? f).join('、');
    const style = {
      card: { border: '1px solid var(--border-color, #b8bbc244)', borderRadius: 14, padding: 18, marginTop: 18 },
      row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, margin: '12px 0' },
      button: { padding: '7px 13px', borderRadius: 8, border: '1px solid #8886', cursor: 'pointer', background: 'transparent', color: 'inherit' },
      primaryButton: { padding: '7px 14px', borderRadius: 8, border: '1px solid #3b82f6', fontWeight: 600, cursor: 'pointer', background: 'rgba(59,130,246,0.1)', color: 'inherit' },
      input: { padding: '7px 10px', borderRadius: 7, border: '1px solid #8886', background: 'transparent', color: 'inherit' },
      muted: { opacity: 0.65, fontSize: 12, lineHeight: 1.7 },
      notice: { padding: '8px 12px', borderRadius: 8, border: '1px solid #3b82f644', background: 'rgba(59,130,246,0.06)', fontSize: 12, lineHeight: 1.7, margin: '8px 0' },
      table: { width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: 12 },
      cell: { padding: '8px 6px', borderBottom: '1px solid #8883', verticalAlign: 'top' }
    };
    function Panel({ api, getSelection }) {
      const [status, setStatus] = useState(null);
      const [provider, setProvider] = useState('');
      const [plan, setPlan] = useState(null);
      const [selected, setSelected] = useState([]);
      const [query, setQuery] = useState('');
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const [error, setError] = useState('');
      const [backup, setBackup] = useState('');
      const [ready, setReady] = useState(false);
      const [drift, setDrift] = useState(null);
      const [checking, setChecking] = useState(false);
      const [checkError, setCheckError] = useState('');
      const checkSeq = useRef(0);
      async function checkDrift(target, fresh = false) {
        if (!target) { setDrift(null); setCheckError(''); return null; }
        const seq = ++checkSeq.current;
        setChecking(true); setCheckError('');
        try {
          const value = await api({ action: 'check', ns: target.ns, provider: target.id, fresh });
          if (checkSeq.current === seq) setDrift(value);
          return value;
        } catch (e) {
          if (checkSeq.current === seq) { setDrift(null); setCheckError(e.message); }
          return null;
        } finally {
          if (checkSeq.current === seq) setChecking(false);
        }
      }
      async function refresh(freshDrift = false) {
        const value = await api({ action: 'status' });
        setStatus(value);
        const nextKey = value.providers.some(p => `${p.ns}|${p.id}` === provider) ? provider : value.providers[0] ? `${value.providers[0].ns}|${value.providers[0].id}` : '';
        setProvider(nextKey);
        if (freshDrift) {
          const target = value.providers.find(p => `${p.ns}|${p.id}` === nextKey);
          await checkDrift(target, true);
        }
        return value;
      }
      useEffect(() => { let active = true; api({ action: 'status' }).then(value => { if (!active) return; setStatus(value); const p = value.providers[0]; setProvider(p ? `${p.ns}|${p.id}` : ''); }, e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
      const source = status?.providers.find(p => `${p.ns}|${p.id}` === provider);
      useEffect(() => {
        if (!source) { setDrift(null); setCheckError(''); return; }
        void checkDrift(source, false);
      }, [source?.ns, source?.id]);
      async function run(fn) {
        setBusy(true); setError(''); setMessage('');
        try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
      }
      async function preview(ids, fresh = false) {
        if (!source) return;
        const value = await api({ action: 'preview', ns: source.ns, provider: source.id, ids, fresh });
        setPlan(value); setSelected(ids); setReady(true);
        return value;
      }
      function pick(id) { setSelected(old => old.includes(id) ? old.filter(x => x !== id) : [...old, id]); setReady(false); }
      const visible = plan?.catalog.filter(x => `${x.model.id} ${x.model.name ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
      const button = (text, onClick, disabled = false, primary = false) => h('button', { type: 'button', style: primary ? style.primaryButton : style.button, disabled: busy || disabled, onClick: () => run(onClick) }, text);
      const result = source?.result;
      const syncAllLabel = drift?.pendingCount > 0 ? `同步全部已配置模型（${drift.pendingCount}）` : '同步全部已配置模型';
      return h('section', { style: style.card, 'aria-label': 'Magpie 模型同步' },
        h('strong', { style: { fontSize: 16 } }, 'Magpie 模型同步'),
        h('p', { style: style.muted }, '手动同步模型的上下文、最大输出、图片能力与推理档位。支持一键同步当前提供商全部已配置模型，或仅同步当前会话选中的模型。'),
        h('div', { style: style.row },
          button(syncAllLabel, async () => {
            if (!source) return;
            const value = await api({ action: 'sync-all', ns: source.ns, provider: source.id });
            setBackup(value.backupId ?? ''); setPlan(null); setReady(false);
            await refresh(true);
            if (value.changed > 0) {
              const summary = (value.updatedModels ?? []).map(m => `${m.id}（${formatFields(m.fields)}）`).join('；');
              const missingNote = value.missingIds?.length ? `\n上游暂未列出（已保留）：${value.missingIds.join(', ')}` : '';
              setMessage(`已同步「${source.name}」的 ${value.changed} / ${value.modelCount} 个模型，配置已即时应用：\n${summary}${missingNote}`);
            } else {
              const missingNote = value.missingIds?.length ? `\n上游暂未列出（已保留）：${value.missingIds.join(', ')}` : '';
              setMessage(`「${source.name}」全部 ${value.modelCount} 个已配置模型均已是最新配置。${missingNote}`);
            }
          }, !source, true),
          button('仅同步当前所选模型', async () => {
            const selectedModel = await getSelection();
            const value = await api({ action: 'sync-model', provider: selectedModel.provider, model: selectedModel.model });
            setBackup(value.backupId ?? ''); setPlan(null); setReady(false);
            const next = await refresh(false);
            const target = next.providers.find(p => p.id === selectedModel.provider) ?? source;
            if (target) setProvider(`${target.ns}|${target.id}`);
            const latestDrift = target ? await checkDrift(target, true) : null;
            if (value.changed) {
              const detail = value.fields?.length ? `（已更新：${formatFields(value.fields)}）` : '';
              setMessage(`已同步当前模型 ${value.model}${detail}，配置已即时应用。`);
            } else {
              const more = latestDrift?.pendingCount > 0 ? `\n另外检测到 ${latestDrift.pendingCount} 个已配置模型有更新，可点击「同步全部已配置模型」。` : '';
              setMessage(`当前模型 ${value.model} 已是最新配置。${more}`);
            }
          }),
          status && h('label', { style: { fontSize: 12 } }, h('input', { type: 'checkbox', checked: Boolean(status.ultraAsMax), disabled: busy, onChange: e => { const checked = e.target.checked; run(async () => { await api({ action: 'configure', values: { ultraAsMax: checked } }); setPlan(null); setReady(false); await refresh(true); }); } }), ' max 使用上游 ultra')
        ),
        h('div', { style: style.row },
          h('select', { style: style.input, value: provider, disabled: busy, 'aria-label': 'Magpie 提供商', onChange: e => { setProvider(e.target.value); setPlan(null); setSelected([]); setReady(false); setBackup(''); } }, status?.providers.map(p => h('option', { key: `${p.ns}|${p.id}`, value: `${p.ns}|${p.id}` }, `${p.name} · ${p.modelCount} 个已配置模型`))),
          button(busy ? '处理中…' : '获取目录与预览', () => preview([], true), !source),
          button('刷新状态', () => refresh(true))
        ),
        source && checking && h('p', { style: style.muted }, '正在检查 Magpie 目录差异…'),
        source && !checking && drift && drift.pendingCount > 0 && h('div', { style: style.notice },
          h('strong', null, `检测到 ${drift.pendingCount} / ${drift.modelCount} 个已配置模型有可同步更新：`),
          h('div', null, drift.changes.map(c => `${c.id}（${formatFields(c.fields)}）`).join('；')),
          drift.missingIds?.length > 0 && h('div', { style: style.muted }, `上游暂未列出（已保留）：${drift.missingIds.join(', ')}`)
        ),
        source && !checking && drift && drift.pendingCount === 0 && h('p', { style: style.muted },
          `全部 ${drift.modelCount} 个已配置模型均与 Magpie 最新元数据一致` + (drift.missingIds?.length ? `（上游暂未列出已保留：${drift.missingIds.join(', ')}）` : '')
        ),
        source && !checking && checkError && h('p', { style: style.muted }, `暂无法检查目录差异：${checkError}`),
        status && !source && h('p', { style: style.muted }, '请先在模型设置中保存 Magpie 提供商与 API 密钥。地址含 /magpie/ 的连接会自动识别，其他地址可在插件设置的 providerIds 中指定。'),
        result && h('p', { style: style.muted }, result.error ? `最近同步：${result.error}` : `最近操作：${new Date(result.time).toLocaleString()} · ${result.restored ? '已撤销' : `更新 ${result.changed ?? 0} 个模型`}`),
        h('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 13, color: error ? '#dc4545' : 'inherit', whiteSpace: 'pre-wrap' } }, error || message),
        plan && h(React.Fragment, null,
          h('div', { style: style.row },
            h('span', null, `发现 ${plan.count} 个模型 · 待应用 ${plan.changes.length} 项`),
            button('预览所选模型', () => preview(selected), !selected.length && ready),
            button('应用此预览', async () => { const value = await api({ action: 'apply', planId: plan.planId }); setBackup(value.backupId ?? ''); setMessage(`已更新 ${value.changed} 个模型，配置已即时应用。`); setPlan(null); setReady(false); await refresh(true); }, !ready || !plan.changes.length)
          ),
          plan.missingIds.length > 0 && h('p', { style: style.muted }, `上游暂未列出，已保留：${plan.missingIds.join(', ')}`),
          plan.changes.length > 0 && h('details', null, h('summary', { style: { cursor: 'pointer', marginBottom: 8 } }, '查看配置差异'),
            h('div', { style: { maxHeight: 260, overflow: 'auto' } }, plan.changes.map(c => h('div', { key: c.id, style: { marginBottom: 10 } },
              h('strong', null, `${c.type === 'add' ? '新增' : '更新'} ${c.id}`),
              h('pre', { style: { fontSize: 11, overflowX: 'auto' } }, c.fields.map(field => `${field}: ${JSON.stringify(c.before?.[field]) ?? '未设置'} → ${JSON.stringify(c.after[field])}`).join('\n'))
            )))
          ),
          h('div', { style: style.row },
            h('input', { style: { ...style.input, flex: 1 }, placeholder: '搜索模型名称或 ID', value: query, onChange: e => setQuery(e.target.value), 'aria-label': '搜索模型' }),
            button('选择当前搜索结果', async () => { setSelected(old => [...new Set([...old, ...visible.filter(x => !x.configured && x.toolCall !== false).map(x => x.model.id)])]); setReady(false); }),
            button('清空选择', async () => { setSelected([]); setReady(false); })
          ),
          h('div', { style: { maxHeight: 420, overflow: 'auto' } }, h('table', { style: style.table },
            h('thead', null, h('tr', null, ['模型', '上下文 / 输出', '输入', 'DSH 档位 → API'].map(x => h('th', { key: x, style: style.cell }, x)))),
            h('tbody', null, visible.map(x => h('tr', { key: x.model.id, title: x.notes.join('\n') },
              h('td', { style: style.cell }, h('label', null, h('input', { type: 'checkbox', checked: x.configured || selected.includes(x.model.id), disabled: busy || x.configured || x.toolCall === false, onChange: () => pick(x.model.id), 'aria-label': `添加 ${x.model.id}` }), h('span', null, x.model.name ?? x.model.id)), h('div', { style: style.muted }, x.model.id), x.notes.length > 0 && h('div', { style: style.muted }, x.notes.join('；'))),
              h('td', { style: style.cell }, `${x.model.contextWindow?.toLocaleString() ?? '未公布'} / ${x.model.maxTokens?.toLocaleString() ?? '未公布'}`),
              h('td', { style: style.cell }, x.model.input?.map(v => v === 'text' ? '文本' : '图片').join('、') ?? '未公布'),
              h('td', { style: style.cell }, x.model.reasoningEfforts === false ? '无思考' : x.model.reasoningEfforts ? Object.entries(x.model.reasoningEfforts).map(([k, v]) => k === v ? k : `${k} → ${v ?? '省略参数'}`).join(' / ') : '未公布')
            )))
          ))
        ),
        (backup || result?.backupId) && h('div', { style: style.row }, button('撤销最近一次同步', async () => { await api({ action: 'restore', backupId: backup || result.backupId }); setBackup(''); setPlan(null); setMessage('已恢复同步前的模型配置。'); await refresh(true); }))
      );
    }
    async function currentSelection(ctx) {
      const sessionId = ctx.uiSession.current.getSnapshot()?.key;
      if (!sessionId) throw new Error('请先打开会话并选择一个模型');
      const binding = ctx.sessions.binding(sessionId);
      if (!binding) throw new Error('当前会话尚未就绪，请稍后点击同步');
      const directory = ctx.modelDirectories.directoryFor(sessionId);
      await directory.load();
      if (ctx.uiSession.current.getSnapshot()?.key !== sessionId || ctx.sessions.binding(sessionId) !== binding) throw new Error('当前会话已切换或重新连接，请重新点击同步');
      const snapshot = directory.store.getSnapshot();
      if (snapshot.pending || snapshot.status === 'selecting') throw new Error('模型正在切换，请稍后点击同步');
      if (!snapshot.current) throw new Error('当前会话尚未选择模型');
      return { provider: snapshot.current.provider, model: snapshot.current.model };
    }
    function apply(ctx) {
      const send = globalThis.__DSH_TRANSPORT__?.fetch ?? ((input, init) => globalThis.fetch(input, init));
      const api = async payload => {
        const response = await send('api/magpie-model-sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        let result;
        try { result = await response.json(); } catch { throw new Error(`插件请求返回 HTTP ${response.status}，请刷新页面后重试`); }
        if (!response.ok || !result.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
        return result.value;
      };
      ctx.slots.inject('settings.models.footer', () => ctx.slots.register({ name: 'settings.models.footer', id: 'magpie-model-sync', order: 10, inject: () => ({ api, getSelection: () => currentSelection(ctx) }) }, Panel));
    }
    return { inject: ['slots', 'connection', 'configForms', 'uiSession', 'sessions', 'modelDirectories'], apply, currentSelection };
  }
});
