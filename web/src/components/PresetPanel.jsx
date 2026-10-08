import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

const MARKER_LABEL = {
  worldInfoBefore: '世界书·前', worldInfoAfter: '世界书·后',
  personaDescription: '用户角色', charDescription: '常驻角色',
  charPersonality: '角色性格', scenario: '大纲',
  dialogueExamples: '对话示例', chatHistory: '正文上下文',
  agentSystemPrompt: '系统提示', agentTask: '指令',
  agentResults: 'Agent结果', main: '主指令', nsfw: 'NSFW', jailbreak: '越狱'
}
const MARKER_SOURCE = {
  worldInfoBefore: '注入：世界书触发条目（前置位置）',
  worldInfoAfter: '注入：世界书触发条目（后置位置）',
  personaDescription: '本工具无对应用户角色数据，注入为空',
  charDescription: '注入：世界书常驻（pinned）条目，等价于 ST 角色卡',
  charPersonality: '信息已在常驻条目内容中，注入为空',
  scenario: '注入：本书「设置 → 大纲与核心设定」',
  dialogueExamples: '本工具无对话示例数据，注入为空',
  chatHistory: '注入：正文上下文（前面章节尾部 + 当前章，作者注按深度插入）',
  agentSystemPrompt: '注入：本书「设置 → 系统提示词」（留空则不注入，不回退默认）',
  agentTask: '注入：本次生成模式指令与自定义要求',
  agentResults: '注入为空', main: '注入：本书「设置 → 系统提示词」（留空则不注入，不回退默认）',
  nsfw: '注入为空', jailbreak: '注入为空'
}
const ROLE_LABEL = { system: 'System', user: 'User', assistant: 'Assistant' }

// 酒馆预设：本书绑定 + 全局预设库管理
export default function PresetPanel({ project, onPatch, toast }) {
  const [list, setList] = useState(null)        // 预设库摘要
  const [editing, setEditing] = useState(null)  // 展开编辑的预设 id
  const [editData, setEditData] = useState(null) // 完整预设对象
  const settings = project.settings

  async function refreshList() {
    try { setList(await api.listPresets()) }
    catch (e) { toast('预设列表加载失败: ' + e.message) }
  }
  useEffect(() => { refreshList() }, [])

  async function importFile(e) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const raw = JSON.parse(await f.text())
      const ps = await api.importPreset(raw, f.name.replace(/\.json$/i, ''))
      await refreshList()
      toast(`预设「${ps.name}」已导入（${ps.prompts.length} 条）`)
    } catch (err) { toast('导入失败：' + err.message) }
  }

  // 本书 settings 局部更新（presetId / presetCharName / presetUserName）
  async function patchSettings(patch) {
    onPatch(p => ({ ...p, settings: { ...p.settings, ...patch } }))
    try { await api.updateProject(project.id, { settings: patch }) }
    catch (err) { toast('保存失败: ' + err.message) }
  }

  async function toggleEdit(pid) {
    if (editing === pid) { setEditing(null); setEditData(null); return }
    try {
      const full = await api.getPreset(pid)
      setEditData(full)
      setEditing(pid)
    } catch (e) { toast('加载预设失败: ' + e.message) }
  }

  async function removePreset(ps) {
    if (!confirm(`删除预设「${ps.name}」？选用它的书将自动回落默认组装。`)) return
    try {
      await api.deletePreset(ps.id)
      if (editing === ps.id) { setEditing(null); setEditData(null) }
      if (settings.presetId === ps.id) await patchSettings({ presetId: '' })
      await refreshList()
      toast('预设已删除')
    } catch (e) { toast('删除失败: ' + e.message) }
  }

  const activeBound = settings.presetId && list?.some(ps => ps.id === settings.presetId)

  return (
    <div className="preset-panel">
      {/* 本书绑定 */}
      <div className="preset-bind">
        <label className="preset-bind-label">本书使用的预设</label>
        <select
          value={settings.presetId || ''}
          onChange={e => patchSettings({ presetId: e.target.value })}
        >
          <option value="">不使用预设（默认 ST 式组装）</option>
          {(list || []).map(ps => (
            <option key={ps.id} value={ps.id}>{ps.name}（{ps.promptCount} 条）</option>
          ))}
        </select>
        {activeBound && (
          <>
            <div className="preset-names">
              <label>
                <span>{'{'}char{'}'} 名字</span>
                <input
                  placeholder="本书主角名（替换预设中的 {char} 宏）"
                  defaultValue={settings.presetCharName || ''}
                  onBlur={e => { if (e.target.value !== (settings.presetCharName || '')) patchSettings({ presetCharName: e.target.value }) }}
                />
              </label>
              <label>
                <span>{'{'}user{'}'} 名字</span>
                <input
                  placeholder="本书用户名（替换预设中的 {user} 宏）"
                  defaultValue={settings.presetUserName || ''}
                  onBlur={e => { if (e.target.value !== (settings.presetUserName || '')) patchSettings({ presetUserName: e.target.value }) }}
                />
              </label>
            </div>
            <div className="preset-hint">
              已启用预设：main 占位符 = 本书系统提示词，scenario = 大纲，作者注仍随正文生效。采样参数（温度等）不随预设导入，请到「设置」中配置。
            </div>
          </>
        )}
      </div>

      {/* 预设库 */}
      <div className="wb-toolbar">
        <span className="wb-group-title">预设库</span>
        <label className="btn small primary">
          导入预设
          <input type="file" accept=".json,application/json" hidden onChange={importFile} />
        </label>
      </div>

      {list && list.length === 0 && (
        <div className="wb-empty">
          <p>还没有导入任何酒馆预设。</p>
          <p>导入 SillyTavern 的 Chat Completions 预设 JSON（如 Kemini），即可在本书中使用其提示词编排与宏开关。</p>
        </div>
      )}

      {(list || []).map(ps => (
        <div key={ps.id} className="preset-lib-item">
          <div className="preset-lib-row" onClick={() => toggleEdit(ps.id)}>
            <span className="wb-name">{ps.name}</span>
            {settings.presetId === ps.id && <span className="chip pinned">本书使用中</span>}
            <span className="wb-hint">{ps.promptCount} 条 · {new Date(ps.importedAt).toLocaleString()}</span>
            <button className="btn small" onClick={e => { e.stopPropagation(); toggleEdit(ps.id) }}>
              {editing === ps.id ? '收起' : '编辑条目'}
            </button>
            <button className="btn small danger" onClick={e => { e.stopPropagation(); removePreset(ps) }}>删除</button>
          </div>
          {editing === ps.id && editData && (
            <PresetEditor
              key={editData.id}
              preset={editData}
              toast={toast}
            />
          )}
        </div>
      ))}
    </div>
  )
}

// 单个预设的条目列表（开关为全局，影响所有选用此预设的书）
function PresetEditor({ preset, toast }) {
  const [prompts, setPrompts] = useState(preset.prompts)
  const [expanded, setExpanded] = useState(null)

  async function patchPrompt(identifier, patch) {
    setPrompts(ps => ps.map(p => (p.identifier === identifier ? { ...p, ...patch } : p)))
    try { await api.updatePreset(preset.id, { prompts: [{ identifier, ...patch }] }) }
    catch (e) { toast('保存失败: ' + e.message) }
  }

  return (
    <div className="preset-editor">
      <div className="preset-editor-note">条目开关为全局设置，影响所有选用此预设的作品。点击条目查看与编辑内容。</div>
      {prompts.map((p, i) => (
        <div key={p.identifier} className={'preset-item' + (p.enabled ? '' : ' disabled')}>
          <div className="preset-item-row" onClick={() => setExpanded(expanded === p.identifier ? null : p.identifier)}>
            <input
              type="checkbox"
              checked={p.enabled}
              onClick={e => e.stopPropagation()}
              onChange={e => patchPrompt(p.identifier, { enabled: e.target.checked })}
            />
            <span className="preset-idx">{i + 1}</span>
            <span className="preset-name">{p.name || p.identifier}</span>
            <span className={'chip role role-' + p.role}>{ROLE_LABEL[p.role] || p.role}</span>
            {p.marker && (
              <span className="chip pmarker" title={MARKER_SOURCE[p.identifier]}>
                {MARKER_LABEL[p.identifier] || p.identifier}
              </span>
            )}
            {!p.marker && p.injection_position === 1 && <span className="chip">@深度{p.injection_depth}</span>}
            <span className="wb-hint">{(p.content || '').length} 字</span>
          </div>
          {expanded === p.identifier && (
            p.marker ? (
              <div className="preset-marker-note">{MARKER_SOURCE[p.identifier] || '占位符'}</div>
            ) : (
              <PromptContentEditor p={p} onSave={content => patchPrompt(p.identifier, { content })} />
            )
          )}
        </div>
      ))}
    </div>
  )
}

function PromptContentEditor({ p, onSave }) {
  const [content, setContent] = useState(p.content)
  const [dirty, setDirty] = useState(false)
  useEffect(() => { setContent(p.content); setDirty(false) }, [p.content])
  return (
    <div className="entry-editor" onClick={e => e.stopPropagation()}>
      <textarea
        className="preset-content-editor"
        value={content}
        onChange={e => { setContent(e.target.value); setDirty(true) }}
      />
      <div className="modal-actions">
        <button className="btn small" onClick={() => { setContent(p.content); setDirty(false) }}>重置</button>
        <button
          className="btn small primary"
          disabled={!dirty}
          onClick={() => { onSave(content); setDirty(false) }}
        >保存</button>
      </div>
    </div>
  )
}
