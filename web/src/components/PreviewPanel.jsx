import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'

const TYPE_LABEL = {
  character: '人物', item: '物品', location: '地点',
  organization: '组织', lore: '设定', other: '其他'
}
const MODE_LABEL = { continue: '续写', expand: '扩写选中', polish: '润色选中', custom: '自定义指令' }

// 注入预览：下次预览（组装结果）+ 发送历史（实际发送给模型的完整消息）
export default function PreviewPanel({ project, chapterId }) {
  const [sub, setSub] = useState('preview')
  return (
    <div className="preview-panel">
      <div className="subtabs">
        <button className={'subtab' + (sub === 'preview' ? ' active' : '')} onClick={() => setSub('preview')}>下次预览</button>
        <button className={'subtab' + (sub === 'sent' ? ' active' : '')} onClick={() => setSub('sent')}>发送历史</button>
      </div>
      {sub === 'preview'
        ? <PreviewView project={project} chapterId={chapterId} />
        : <SentLog project={project} />}
    </div>
  )
}

// ---------- 下次预览 ----------
function PreviewView({ project, chapterId }) {
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

  const b = data?.stats?.contextBreakdown

  return (
    <>
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
          {b && !b.selection && <Breakdown b={b} />}
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
    </>
  )
}

// 上下文分层构成（压缩情况）
function Breakdown({ b }) {
  const total = Math.max(1, b.memoryChars + b.recentChars + b.curChars)
  const rows = [
    ['前情摘要', b.memoryChars, '#7bab6e'],
    ['近章原文', b.recentChars, '#a8c4e8'],
    ['当前章', b.curChars, '#d9a05b']
  ]
  return (
    <div className="breakdown">
      {rows.map(([label, chars, color]) => (
        <div key={label} className="bd-row">
          <span className="bd-label">{label}</span>
          <span className="bd-bar"><span className="bd-fill" style={{ width: Math.round(chars / total * 100) + '%', background: color }} /></span>
          <span className="bd-num">{chars.toLocaleString()}</span>
        </div>
      ))}
      <div className="bd-note">
        {b.recentChapters?.length > 0 && <span>近章：{b.recentChapters.map(c => c.title).join('、')}</span>}
        {b.memoryUsed?.length > 0 && <span>摘要 {b.memoryUsed.length} 条</span>}
        {b.memoryDropped > 0 && <span className="bd-drop">旧内容超预算，{b.memoryDropped} 条未注入</span>}
      </div>
    </div>
  )
}

// ---------- 发送历史 ----------
function fmtTime(t) {
  const d = new Date(t)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const KIND_LABEL = { generate: '正文生成', postprocess: '后台整理', extract: '手动抽取' }

function SentLog({ project }) {
  const [list, setList] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    try { setList(await api.listRequests(project.id)) } catch { setList([]) }
  }, [project.id])

  useEffect(() => { refresh() }, [refresh])

  async function open(id) {
    setLoading(true)
    try { setDetail(await api.getRequest(project.id, id)) } catch {} finally { setLoading(false) }
  }

  if (detail) return <RecordDetail rec={detail} onBack={() => { setDetail(null); refresh() }} />

  return (
    <>
      <div className="wb-toolbar">
        <span className="muted">最近 {list?.length ?? 0} 次实际发送（含后台整理），点击查看完整消息</span>
        <button className="btn small" onClick={refresh} disabled={loading}>刷新</button>
      </div>
      {list && list.length === 0 && (
        <div className="wb-empty">
          暂无记录。生成一次正文后，这里会显示实际发送给模型的完整消息与上下文分层构成，用于检查压缩情况。
        </div>
      )}
      {list?.map(r => (
        <div key={r.id} className="sent-item" onClick={() => open(r.id)}>
          <div className="sent-row">
            <span className={'chip ' + (r.kind === 'postprocess' ? 'auto' : 'inject')}>{KIND_LABEL[r.kind] || r.kind}</span>
            <span className="muted">{fmtTime(r.time)}</span>
          </div>
          <div className="sent-row">
            <span className="muted">{r.messageCount} 条消息 · {r.totalChars.toLocaleString()} 字 · {r.model || '—'}</span>
            {r.status === 'aborted' && <span className="chip miss">已中止</span>}
          </div>
          {r.detail?.breakdown && (
            <div className="sent-brief">
              摘要 {r.detail.breakdown.memoryChars?.toLocaleString() ?? 0} · 近章 {r.detail.breakdown.recentChars?.toLocaleString() ?? 0} · 当前章 {r.detail.breakdown.curChars?.toLocaleString() ?? 0}
            </div>
          )}
          {r.kind === 'postprocess' && r.detail && (
            <div className="sent-brief">
              {r.detail.chapterTitle || ''} · 新增 {r.detail.added ?? 0} · 更新 {r.detail.updated ?? 0} · 摘要 {r.detail.summaryChars ?? 0} 字
            </div>
          )}
        </div>
      ))}
    </>
  )
}

function RecordDetail({ rec, onBack }) {
  const b = rec.detail?.breakdown
  return (
    <>
      <div className="wb-toolbar">
        <button className="btn small" onClick={onBack}>← 返回</button>
        <span className="muted">{fmtTime(rec.time)} · {KIND_LABEL[rec.kind] || rec.kind}{rec.model ? ` · ${rec.model}` : ''}</span>
      </div>
      {b && <Breakdown b={b} />}
      {rec.detail?.usedEntries?.length > 0 && (
        <div className="sent-entries">
          <div className="wb-group-title"><span>注入的世界书条目</span><span>{rec.detail.usedEntries.length}</span></div>
          <div className="preview-entries">
            {rec.detail.usedEntries.map(e => (
              <span key={e.id} className="chip inject">
                {TYPE_LABEL[e.type]}·{e.name}
                <em>{e.source === 'pinned' ? '常驻' : e.position === 'before' ? '前置' : '触发'}</em>
              </span>
            ))}
          </div>
        </div>
      )}
      {rec.detail?.preset && <div className="order-hint">预设「{rec.detail.preset}」</div>}
      {rec.response && (
        <details className="preview-msg">
          <summary>模型原始返回 · {rec.response.length.toLocaleString()} 字</summary>
          <pre>{rec.response}</pre>
        </details>
      )}
      {rec.messages.map((m, i) => (
        <details key={i} open={i === 0} className="preview-msg">
          <summary>
            {m.role === 'system' ? 'System' : m.role === 'user' ? 'User' : 'Assistant'} · 第 {i + 1} 条 · {m.chars.toLocaleString()} 字
          </summary>
          <pre>{m.content}</pre>
        </details>
      ))}
    </>
  )
}

function PromptOrderHint() {
  return (
    <div className="order-hint" title="SillyTavern 式组装顺序">
      组装顺序：System → 前置设定 → 本书大纲 → 常驻角色 → 触发设定 → 前情摘要 → 近章原文 → 当前章（作者注按深度插入）→ 指令
    </div>
  )
}
