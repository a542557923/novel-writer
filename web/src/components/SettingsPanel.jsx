import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { APP_VERSION } from '../version.js'

const DEFAULT_SYSTEM_PROMPT_HINT = '留空使用内置默认提示词（小说家角色 + 直出正文 + 设定一致性等要求）'

export default function SettingsPanel({ project, onSaveSettings, onSaveConfig }) {
  return (
    <div className="settings-panel">
      <Section title="AI 接口（全局）">
        <ConfigForm onSave={onSaveConfig} />
      </Section>
      <Section title={`《${project.name}》写作设置`}>
        <ProjectForm project={project} onSave={onSaveSettings} />
      </Section>
      <div className="version-line">Novel Writer v{APP_VERSION}</div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="settings-section">
      <h3>{title}</h3>
      {children}
    </div>
  )
}

function ConfigForm({ onSave }) {
  const [cfg, setCfg] = useState(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [extractModel, setExtractModel] = useState('')
  const [temperature, setTemperature] = useState(0.8)
  const [maxTokens, setMaxTokens] = useState(2000)

  useEffect(() => {
    api.getConfig().then(c => {
      setCfg(c)
      setBaseUrl(c.baseUrl || '')
      setApiKey(c.apiKey || '')
      setModel(c.model || '')
      setExtractModel(c.extractModel || '')
      setTemperature(c.temperature ?? 0.8)
      setMaxTokens(c.maxTokens ?? 2000)
    })
  }, [])

  if (!cfg) return null
  const keyTouched = apiKey && !/^[●]+$/.test(apiKey)

  return (
    <>
      <label>API 地址（OpenAI 兼容，填到 /v1）</label>
      <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" />
      <label>API Key {cfg.apiKey && !keyTouched ? '（已配置，留空保持不变）' : ''}</label>
      <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-…" />
      <label>模型</label>
      <input value={model} onChange={e => setModel(e.target.value)} placeholder="deepseek-chat / gpt-4o / …" />
      <label>抽取模型（可选，留空复用主模型；额度充裕时留空即可，使用推理模型写作或额度受限时建议单独指定）</label>
      <input value={extractModel} onChange={e => setExtractModel(e.target.value)} placeholder="同上，可留空" />
      <div className="entry-editor-row">
        <div>
          <label>温度（创意度）</label>
          <input type="number" step="0.1" min="0" max="2" value={temperature} onChange={e => setTemperature(+e.target.value)} />
        </div>
        <div>
          <label>单次生成上限（tokens）</label>
          <input type="number" value={maxTokens} onChange={e => setMaxTokens(+e.target.value)} />
        </div>
      </div>
      <button
        className="btn primary"
        onClick={() => onSave({ baseUrl: baseUrl.trim(), model: model.trim(), extractModel: extractModel.trim(), temperature, maxTokens, apiKey: apiKey })}
      >保存 AI 配置</button>
    </>
  )
}

function ProjectForm({ project, onSave }) {
  const s = project.settings
  const [systemPrompt, setSystemPrompt] = useState(s.systemPrompt || '')
  const [storyBible, setStoryBible] = useState(s.storyBible || '')
  const [authorNote, setAuthorNote] = useState(s.authorNote || '')
  const [authorNoteDepth, setAuthorNoteDepth] = useState(s.authorNoteDepth ?? 1)
  const [contextChars, setContextChars] = useState(s.contextChars ?? 12000)
  const [scanChars, setScanChars] = useState(s.scanChars ?? 4000)
  const [recentChapters, setRecentChapters] = useState(s.recentChapters ?? 2)
  const [autoExtract, setAutoExtract] = useState(s.autoExtract !== false)
  const [thriftyMode, setThriftyMode] = useState(s.thriftyMode === true)

  return (
    <>
      {s.presetId && (
        <div className="preset-active-hint">
          本书已启用「酒馆预设」：下方<b>系统提示词</b>将注入预设的 main 占位符（留空则不注入，不回退默认提示词）；<b>大纲</b>注入 scenario；<b>作者注</b>仍随正文上下文生效。
        </div>
      )}
      <label>系统提示词（{s.presetId ? '作为预设 main 占位符的数据源' : DEFAULT_SYSTEM_PROMPT_HINT}）</label>
      <textarea rows={6} value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} />
      <label>本书大纲 / 核心世界观（每次生成都注入）</label>
      <textarea rows={8} value={storyBible} onChange={e => setStoryBible(e.target.value)} placeholder="题材、主线、力量体系、结局走向…" />
      <label>作者注（插入到上下文倒数第 N 段之前，优先级高于正文惯性）</label>
      <textarea rows={3} value={authorNote} onChange={e => setAuthorNote(e.target.value)} placeholder="如：本章要揭示主角身世；多写心理描写" />
      <div className="entry-editor-row">
        <div>
          <label>作者注深度</label>
          <input type="number" min="1" max="20" value={authorNoteDepth} onChange={e => setAuthorNoteDepth(+e.target.value)} />
        </div>
        <div>
          <label>上下文预算（字符）</label>
          <input type="number" step="1000" value={contextChars} onChange={e => setContextChars(+e.target.value)} />
        </div>
        <div>
          <label>近章原文数</label>
          <input type="number" min="0" max="10" value={recentChapters} onChange={e => setRecentChapters(+e.target.value)} />
        </div>
        <div>
          <label>世界书扫描窗口（字符）</label>
          <input type="number" step="500" value={scanChars} onChange={e => setScanChars(+e.target.value)} />
        </div>
      </div>
      <div className="order-hint">
        分层记忆：近 <b>{recentChapters}</b> 章用原文注入，更早章节用摘要注入（在「记忆」面板管理与补建）；
        上下文预算按「当前章 ≤50% · 近章 ≤25% · 摘要余量」分配。原文永久保留，摘要只做导航。
      </div>
      <label className="check">
        <input type="checkbox" checked={autoExtract && !thriftyMode} disabled={thriftyMode}
          onChange={e => setAutoExtract(e.target.checked)} />
        生成后自动整理（世界书抽取 + 章节摘要，合并为一次请求，串行后台执行）
      </label>
      <label className="check">
        <input type="checkbox" checked={thriftyMode} onChange={e => setThriftyMode(e.target.checked)} />
        省流模式（公益站友好）：关闭全部后台任务，每次生成严格仅 1 次请求
      </label>
      {thriftyMode && (
        <div className="order-hint">省流模式下不会自动抽取世界书、不会生成摘要；可在「记忆」面板手动补建摘要。</div>
      )}
      <button
        className="btn primary"
        onClick={() => onSave({
          systemPrompt: systemPrompt.trim(), storyBible: storyBible.trim(),
          authorNote: authorNote.trim(), authorNoteDepth,
          contextChars, scanChars, recentChapters, autoExtract, thriftyMode
        })}
      >保存本书设置</button>
    </>
  )
}
