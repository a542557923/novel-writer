import React, { useMemo, useState } from 'react'
import { api } from '../api.js'

const TYPE_LABEL = {
  character: '人物', item: '物品', location: '地点',
  organization: '组织', lore: '设定', other: '其他'
}
const TYPES = Object.keys(TYPE_LABEL)

export default function WorldBook({ project, onPatch, toast }) {
  const [expanded, setExpanded] = useState(null) // 展开编辑的条目 id
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState('')

  const groups = useMemo(() => {
    const kw = filter.trim().toLowerCase()
    const entries = project.worldbook.filter(e =>
      !kw || e.name.toLowerCase().includes(kw) || (e.aliases || []).some(a => a.toLowerCase().includes(kw))
    )
    return TYPES.map(t => [t, entries.filter(e => e.type === t)]).filter(([, list]) => list.length)
  }, [project.worldbook, filter])

  async function updateEntry(eid, patch) {
    onPatch(p => ({ ...p, worldbook: p.worldbook.map(e => (e.id === eid ? { ...e, ...patch } : e)) }))
    try { await api.updateEntry(project.id, eid, patch) } catch (err) { toast('保存失败: ' + err.message) }
  }

  async function removeEntry(eid, name) {
    if (!confirm(`删除世界书条目「${name}」？`)) return
    onPatch(p => ({ ...p, worldbook: p.worldbook.filter(e => e.id !== eid) }))
    try { await api.deleteEntry(project.id, eid) } catch (err) { toast('删除失败: ' + err.message) }
  }

  async function createEntry(entry) {
    try {
      const e = await api.addEntry(project.id, entry)
      onPatch(p => ({ ...p, worldbook: [...p.worldbook, e] }))
      setCreating(false)
      toast(`「${entry.name}」已加入世界书`)
    } catch (err) { toast('添加失败: ' + err.message) }
  }

  return (
    <div className="worldbook">
      <div className="wb-toolbar">
        <input className="wb-search" placeholder="搜索实体…" value={filter} onChange={e => setFilter(e.target.value)} />
        <button className="btn small" onClick={() => setCreating(true)}>＋ 手动添加</button>
      </div>

      {project.worldbook.length === 0 && (
        <div className="wb-empty">
          <p>世界书还是空的。</p>
          <p>开始生成正文后，新出现的人物/物品/地点会被<b>自动提取</b>到这里；也可以在正文中选中一段文字，一键加入世界书。</p>
        </div>
      )}

      {groups.map(([type, list]) => (
        <div key={type} className="wb-group">
          <div className="wb-group-title">{TYPE_LABEL[type]}<span>{list.length}</span></div>
          {list.map(e => (
            <div key={e.id} className={'wb-entry' + (e.enabled ? '' : ' disabled')}>
              <div className="wb-entry-row" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                <span className="wb-name">{e.name}</span>
                {e.pinned && <span className="chip pinned" title="常驻注入（等价于 ST 角色卡）">常驻</span>}
                {e.auto && <span className="chip auto" title="由 AI 自动抽取创建">✦自动</span>}
                <span className="wb-hint">{(e.aliases || []).join('、')}</span>
              </div>
              {expanded === e.id ? (
                <EntryEditor entry={e} onSave={patch => updateEntry(e.id, patch)} onDelete={() => removeEntry(e.id, e.name)} />
              ) : (
                <div className="wb-content">{e.content}</div>
              )}
            </div>
          ))}
        </div>
      ))}

      {creating && <EntryModal onClose={() => setCreating(false)} onSubmit={createEntry} />}
    </div>
  )
}

function EntryEditor({ entry, onSave, onDelete }) {
  const [type, setType] = useState(entry.type)
  const [name, setName] = useState(entry.name)
  const [aliases, setAliases] = useState((entry.aliases || []).join('、'))
  const [content, setContent] = useState(entry.content)
  const [keywords, setKeywords] = useState((entry.keywords || []).join('、'))
  const [position, setPosition] = useState(entry.position)
  const [priority, setPriority] = useState(entry.priority)
  const [pinned, setPinned] = useState(entry.pinned)

  return (
    <div className="entry-editor" onClick={e => e.stopPropagation()}>
      <div className="entry-editor-row">
        <div>
          <label>类型</label>
          <select value={type} onChange={e => setType(e.target.value)}>
            {TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </div>
        <div>
          <label>名称</label>
          <input value={name} onChange={e => setName(e.target.value)} />
        </div>
      </div>
      <label>别名（顿号/逗号分隔，出现即触发注入）</label>
      <input value={aliases} onChange={e => setAliases(e.target.value)} />
      <label>设定描述</label>
      <textarea rows={4} value={content} onChange={e => setContent(e.target.value)} />
      <label>额外触发词</label>
      <input value={keywords} onChange={e => setKeywords(e.target.value)} />
      <div className="entry-editor-row">
        <div>
          <label>注入位置</label>
          <select value={position} onChange={e => setPosition(e.target.value)}>
            <option value="after">常规区（默认）</option>
            <option value="before">前置区（世界观级）</option>
          </select>
        </div>
        <div>
          <label>优先级（小在前）</label>
          <input type="number" value={priority} onChange={e => setPriority(+e.target.value)} />
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} />
        常驻注入（无需触发词，每次都注入，等价于角色卡）
      </label>
      <div className="modal-actions">
        <button className="btn danger small" onClick={onDelete}>删除</button>
        <button className="btn" onClick={() => { setType(entry.type); setName(entry.name); setContent(entry.content); setAliases((entry.aliases || []).join('、')) }}>重置</button>
        <button
          className="btn primary"
          disabled={!name.trim() || !content.trim()}
          onClick={() => onSave({
            type,
            name: name.trim(),
            aliases: aliases.split(/[,，、]/).map(s => s.trim()).filter(Boolean),
            content: content.trim(),
            keywords: keywords.split(/[,，、]/).map(s => s.trim()).filter(Boolean),
            position, priority, pinned
          })}
        >保存</button>
      </div>
    </div>
  )
}

function EntryModal({ onClose, onSubmit }) {
  const [type, setType] = useState('character')
  const [name, setName] = useState('')
  const [aliases, setAliases] = useState('')
  const [content, setContent] = useState('')
  const [pinned, setPinned] = useState(false)

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>添加世界书条目</h3>
        <label>类型</label>
        <select value={type} onChange={e => setType(e.target.value)}>
          {TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <label>名称 *</label>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} />
        <label>别名 / 触发词（逗号分隔）</label>
        <input value={aliases} onChange={e => setAliases(e.target.value)} />
        <label>设定描述 *</label>
        <textarea rows={5} value={content} onChange={e => setContent(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} />
          常驻注入（每次生成都注入，无需触发）
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!name.trim() || !content.trim()}
            onClick={() => onSubmit({
              type, name: name.trim(),
              aliases: aliases.split(/[,，、]/).map(s => s.trim()).filter(Boolean),
              content: content.trim(), pinned
            })}
          >保存</button>
        </div>
      </div>
    </div>
  )
}
