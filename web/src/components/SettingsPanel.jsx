import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { APP_VERSION } from '../version.js'

export default function SettingsPanel({ project, onSaveSettings, onSaveConfig, toast }) {
  return (
    <div className="settings-panel">
      <Section title="AI 接口" desc="全局配置，所有作品共用">
        <ConfigForm onSave={onSaveConfig} toast={toast} />
      </Section>
      <Section title="自动处理" desc="仅影响当前作品">
        <ProcessForm project={project} onSave={onSaveSettings} />
      </Section>

      <details className="settings-section collapse">
        <summary>
          <span className="collapse-title">高级</span>
          <span className="collapse-sub">系统提示词 / 本书大纲</span>
          <span className="chev">›</span>
        </summary>
        <AdvancedForm project={project} onSave={onSaveSettings} />
      </details>

      <div className="version-line">Novel Writer v{APP_VERSION}</div>
    </div>
  )
}

function Section({ title, desc, children }) {
  return (
    <section className="settings-section">
      <div className="section-head">
        <h3>{title}</h3>
        {desc && <span>{desc}</span>}
      </div>
      {children}
    </section>
  )
}

function ConfigForm({ onSave, toast }) {
  const [cfg, setCfg] = useState(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [extractModel, setExtractModel] = useState('')
  const [models, setModels] = useState([])
  const [fetching, setFetching] = useState(false)
  const [status, setStatus] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.getConfig().then(c => {
      setCfg(c)
      setBaseUrl(c.baseUrl || '')
      setApiKey(c.apiKey || '')
      setModel(c.model || '')
      setExtractModel(c.extractModel || '')
    })
  }, [])

  if (!cfg) return null
  const keyTouched = apiKey && !/^[●]+$/.test(apiKey)

  async function fetchModels() {
    setFetching(true)
    setStatus(null)
    try {
      const r = await api.listModels({ baseUrl: baseUrl.trim(), apiKey })
      setModels(r.models || [])
      setStatus(r.models?.length
        ? { ok: true, text: `已获取 ${r.models.length} 个模型，可在输入框下拉选择` }
        : { ok: false, text: '接口未返回模型列表，可直接手动输入模型名' })
    } catch (e) {
      setModels([])
      setStatus({ ok: false, text: '拉取失败：' + e.message + '（可直接手动输入模型名）' })
    } finally {
      setFetching(false)
    }
  }

  async function save() {
    setSaving(true)
    try {
      await onSave({ baseUrl: baseUrl.trim(), model: model.trim(), extractModel: extractModel.trim(), apiKey })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <label>API 地址</label>
      <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" spellCheck={false} />

      <label>API Key {cfg.apiKey && !keyTouched ? <span className="label-note">已配置，留空保持不变</span> : null}</label>
      <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-…" spellCheck={false} />

      <label>模型</label>
      <div className="field-action">
        <input
          list="model-options"
          value={model}
          onChange={e => setModel(e.target.value)}
          placeholder="拉取列表后选择，或直接输入"
          spellCheck={false}
        />
        <button className="btn small" onClick={fetchModels} disabled={fetching}>
          {fetching ? '拉取中…' : '拉取模型'}
        </button>
      </div>

      <label>整理模型 <span className="label-note">可选，留空复用主模型</span></label>
      <input
        list="model-options"
        value={extractModel}
        onChange={e => setExtractModel(e.target.value)}
        placeholder="同上，可留空"
        spellCheck={false}
      />

      <datalist id="model-options">
        {models.map(m => <option key={m} value={m} />)}
      </datalist>

      {models.length > 0 && (
        <div className="model-chips">
          {models.slice(0, 60).map(m => (
            <button
              key={m}
              type="button"
              className={'model-chip' + (model === m ? ' active' : '')}
              onClick={() => setModel(m)}
              title={m}
            >{m}</button>
          ))}
        </div>
      )}

      {status && <div className={'hint-line' + (status.ok ? ' ok' : '')}>{status.text}</div>}

      <button className="btn primary block" onClick={save} disabled={saving}>
        {saving ? '保存中…' : '保存配置'}
      </button>
    </>
  )
}

// 高级：系统提示词 / 本书大纲（默认折叠）
function AdvancedForm({ project, onSave }) {
  const s = project.settings
  const [systemPrompt, setSystemPrompt] = useState(s.systemPrompt || '')
  const [storyBible, setStoryBible] = useState(s.storyBible || '')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try { await onSave({ systemPrompt: systemPrompt.trim(), storyBible: storyBible.trim() }) }
    finally { setSaving(false) }
  }

  return (
    <>
      {s.presetId && (
        <div className="hint-line">
          已启用酒馆预设：系统提示词会<b>覆盖</b>预设的 <b>main</b>（留空则使用预设自带内容），大纲覆盖 <b>scenario</b>。
        </div>
      )}
      <label>系统提示词</label>
      <textarea
        rows={6}
        value={systemPrompt}
        onChange={e => setSystemPrompt(e.target.value)}
        placeholder="留空则使用内置默认提示词；启用预设时留空 = 使用预设自带的 main"
      />
      <label>本书大纲 / 核心世界观（每次生成都注入）</label>
      <textarea
        rows={8}
        value={storyBible}
        onChange={e => setStoryBible(e.target.value)}
        placeholder="题材、主线、力量体系、结局走向…"
      />
      <button className="btn primary block" onClick={save} disabled={saving}>
        {saving ? '保存中…' : '保存高级设置'}
      </button>
    </>
  )
}

function ProcessForm({ project, onSave }) {
  const s = project.settings
  const [autoExtract, setAutoExtract] = useState(s.autoExtract !== false)
  const [thriftyMode, setThriftyMode] = useState(s.thriftyMode === true)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try { await onSave({ autoExtract, thriftyMode }) } finally { setSaving(false) }
  }

  return (
    <>
      <div className="switch-row">
        <div className="switch-text">
          <div className="switch-title">生成后自动整理</div>
          <div className="switch-desc">从新正文中抽取世界书条目并生成章节摘要（合并为一次请求，后台串行执行）。</div>
        </div>
        <label className={'switch' + (thriftyMode ? ' disabled' : '')}>
          <input type="checkbox" checked={autoExtract && !thriftyMode} disabled={thriftyMode} onChange={e => setAutoExtract(e.target.checked)} />
          <span className="switch-track" />
        </label>
      </div>

      <div className="switch-row">
        <div className="switch-text">
          <div className="switch-title">省流模式</div>
          <div className="switch-desc">关闭全部后台任务，每次生成严格仅 1 次请求。适合额度紧张的中转站。</div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={thriftyMode} onChange={e => setThriftyMode(e.target.checked)} />
          <span className="switch-track" />
        </label>
      </div>

      {thriftyMode && (
        <div className="hint-line">省流模式下不会自动抽取世界书、不会生成摘要；可在「记忆」面板手动补建。</div>
      )}

      <button className="btn primary block" onClick={save} disabled={saving}>
        {saving ? '保存中…' : '保存设置'}
      </button>
    </>
  )
}
