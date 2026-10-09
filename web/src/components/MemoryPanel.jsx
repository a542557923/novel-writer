import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

// 记忆面板：章节摘要覆盖率、卷摘要、补建与折叠管理
export default function MemoryPanel({ project, toast }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(null) // 'rebuild' | 'fold'
  const [expanded, setExpanded] = useState(null)
  const timerRef = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const d = await api.getMemory(project.id)
      setData(d)
      return d
    } catch (e) {
      toast?.('读取记忆失败: ' + e.message)
      return null
    }
  }, [project.id])

  useEffect(() => { refresh() }, [refresh])

  // 补建期间轮询进度
  useEffect(() => {
    clearTimeout(timerRef.current)
    const rb = data?.rebuilding
    if (rb && rb.running) {
      timerRef.current = setTimeout(refresh, 2500)
    }
    return () => clearTimeout(timerRef.current)
  }, [data, refresh])

  async function rebuild() {
    setBusy('rebuild')
    try {
      const r = await api.rebuildMemory(project.id)
      if (r.queued) toast?.(`已加入 ${r.queued} 章的摘要补建任务（后台串行执行）`)
      else toast?.('没有需要补建的章节')
      await refresh()
    } catch (e) {
      toast?.('补建失败: ' + e.message)
    } finally { setBusy(null) }
  }

  async function fold() {
    setBusy('fold')
    try {
      const r = await api.foldMemory(project.id)
      if (r?.count) toast?.(`已把 ${r.count} 章摘要折叠为卷摘要`)
      else toast?.('没有可折叠的摘要')
      await refresh()
    } catch (e) {
      toast?.('折叠失败: ' + e.message)
    } finally { setBusy(null) }
  }

  if (!data) return <div className="wb-empty">加载中…</div>

  const cov = data.coverage
  const pct = cov.total ? Math.round(cov.done / cov.total * 100) : 0
  const rb = data.rebuilding

  return (
    <div className="memory-panel">
      <div className="mem-card">
        <div className="mem-cover-row">
          <span className="mem-cover-num">{cov.done}/{cov.total}</span>
          <span className="mem-cover-label">章已生成摘要（{pct}%）</span>
        </div>
        <div className="mem-bar"><div className="mem-bar-fill" style={{ width: pct + '%' }} /></div>
        {rb && rb.running && (
          <div className="mem-progress">补建中 {rb.done}/{rb.total}{rb.failed ? `（失败 ${rb.failed}）` : ''}…</div>
        )}
        {!rb && data.queue?.pending > 0 && (
          <div className="mem-progress">后台队列：{data.queue.pending} 个任务待执行</div>
        )}
      </div>

      <div className="wb-toolbar">
        <button className="btn small primary" onClick={rebuild} disabled={!!busy || !cov.missing.length || (rb && rb.running)}>
          {rb && rb.running ? '补建中…' : `补齐缺失摘要${cov.missing.length ? `（${cov.missing.length}）` : ''}`}
        </button>
        <button className="btn small" onClick={fold} disabled={!!busy || data.unfoldedCount < 2}>
          折叠为卷摘要
        </button>
      </div>

      <div className="order-hint">
        生成时按「近 {project.settings.recentChapters ?? 2} 章原文 + 更早章节摘要」分层装配上下文；
        未折叠摘要达到 {data.foldThreshold} 条时自动折叠为卷摘要；摘要只做导航，原文永久保留。
      </div>

      {data.volumes.length > 0 && (
        <div className="wb-group">
          <div className="wb-group-title"><span>卷摘要</span><span>{data.volumes.length} 条</span></div>
          {data.volumes.map(v => (
            <div key={v.id} className="mem-item" onClick={() => setExpanded(expanded === v.id ? null : v.id)}>
              <div className="mem-item-head">
                <span className="wb-name">覆盖 {v.chapterCount} 章</span>
                <span className="muted">{v.titles[0]} ~ {v.titles[v.titles.length - 1]}</span>
                <span className="chip auto">{v.chars} 字</span>
              </div>
              {expanded === v.id && <div className="mem-text">{v.text}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="wb-group">
        <div className="wb-group-title"><span>章摘要</span><span>{cov.done}/{cov.total}</span></div>
        {data.chapters.length === 0 && <div className="wb-empty">还没有章节。</div>}
        {data.chapters.map(c => (
          <div key={c.id} className={'mem-item' + (c.hasSummary ? '' : ' missing')} onClick={() => c.hasSummary && setExpanded(expanded === c.id ? null : c.id)}>
            <div className="mem-item-head">
              <span className="wb-name">{c.title}</span>
              {c.hasSummary
                ? <span className={'chip ' + (c.stale ? 'stale' : 'auto')}>{c.stale ? '可能过期' : `${c.summaryChars} 字`}</span>
                : <span className="chip miss">未生成</span>}
              <span className="muted">{c.chars} 字</span>
            </div>
            {c.hasSummary && expanded === c.id && <div className="mem-text">{c.summary}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
