import React, { useState } from 'react'
import { api } from '../api.js'

const TYPE_LABEL = {
  character: '人物', item: '物品', location: '地点',
  organization: '组织', lore: '设定', other: '其他'
}
const MODE_LABEL = { continue: '续写', expand: '扩写选中', polish: '润色选中', custom: '自定义指令' }

// 注入预览：展示本次生成实际发送给模型的完整提示词
export default function PreviewPanel({ project, chapterId }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('continue')

  async function refresh() {
    if (!chapterId) { setError('请先选择章节'); return }
    setLoading(true); setError(null)
    try {
      const d = await api.preview(project.id, { chapterId, mode, selection: '', instruction: '' })
      setData(d)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }

  return (
    <div className="preview-panel">
      <div className="wb-toolbar">
        <select value={mode} onChange={e => setMode(e.target.value)}>
          {Object.entries(MODE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button className="btn small primary" onClick={refresh} disabled={loading}>
          {loading ? '组装中…' : '刷新预览'}
        </button>
      </div>

      {error && <div className="preview-error">{error}</div>}

      {data && (
        <>
          <div className="preview-stats">
            {data.stats.preset && <span>预设「{data.stats.presetName}」· {data.stats.messageCount} 条消息</span>}
            <span>注入 {data.stats.usedEntries} 条设定</span>
            <span>上下文 {data.stats.contextChars.toLocaleString()} 字</span>
            <span>提示词共 {data.stats.totalChars.toLocaleString()} 字</span>
          </div>
          <div className="preview-entries">
            {data.usedEntries.length === 0 && <span className="muted">本次无世界书条目被注入</span>}
            {data.usedEntries.map(e => (
              <span key={e.id} className="chip inject">
                {TYPE_LABEL[e.type]}·{e.name}
                <em>{e.source === 'pinned' ? '常驻' : e.position === 'before' ? '前置' : '触发'}</em>
              </span>
            ))}
          </div>
          {data.stats.preset ? (
            <div className="order-hint">组装顺序：按预设 prompt_order（含宏展开与绝对注入）</div>
          ) : (
            <PromptOrderHint />
          )}
          {data.messages.map((m, i) => (
            <details key={i} open={i === 0} className="preview-msg">
              <summary>
                {m.role === 'system' ? 'System' : m.role === 'user' ? 'User' : 'Assistant'} · 第 {i + 1} 条 · {m.content.length.toLocaleString()} 字
                {m.role === 'assistant' && i === data.messages.length - 1 && data.messages.length > 1 ? '（prefill）' : ''}
              </summary>
              <pre>{m.content}</pre>
            </details>
          ))}
        </>
      )}
      {!data && !error && (
        <div className="wb-empty"><p>点击「刷新预览」，查看下一次生成时实际发送的完整提示词与被注入的世界书条目。</p></div>
      )}
    </div>
  )
}

function PromptOrderHint() {
  return (
    <div className="order-hint" title="SillyTavern 式组装顺序">
      组装顺序：System → 前置设定 → 本书大纲 → 常驻角色 → 触发设定 → 正文上下文（作者注按深度插入）→ 指令
    </div>
  )
}
