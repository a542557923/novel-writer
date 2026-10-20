import React, { useEffect, useRef, useState } from 'react'
import { streamGenerate, api } from '../api.js'

const MODES = [
  ['continue', '续写'],
  ['expand', '扩写选中'],
  ['polish', '润色选中'],
  ['custom', '自定义指令']
]

const TYPE_LABEL = {
  character: '人物', item: '物品', location: '地点',
  organization: '组织', lore: '设定', other: '其他'
}

export default function Editor({ project, chapter, onContent, toast, onWorldbookChanged }) {
  const taRef = useRef(null)
  const abortRef = useRef(null)
  const anchorRef = useRef(null)

  const [mode, setMode] = useState('continue')
  const [instruction, setInstruction] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [meta, setMeta] = useState(null)
  const [extractInfo, setExtractInfo] = useState(null)
  const [sel, setSel] = useState(null) // {start, end, text}
  const [quickAdd, setQuickAdd] = useState(null) // 快速入库弹窗

  const content = chapter?.content || ''

  // 切换章节时清理选区状态
  useEffect(() => {
    setSel(null)
    setQuickAdd(null)
  }, [chapter?.id])

  // 流式期间的显示文本：锚点前 + 已生成 + 锚点后
  const display = streaming && anchorRef.current
    ? content.slice(0, anchorRef.current.start) + streamText + content.slice(anchorRef.current.end)
    : content

  useEffect(() => {
    if (streaming) {
      const ta = taRef.current
      if (ta) ta.scrollTop = ta.scrollHeight
    }
  }, [streamText, streaming])

  function stopGenerate() {
    abortRef.current?.()
  }

  function settle(finalText, fromStream) {
    const a = anchorRef.current
    if (!a) return
    const text = finalText !== undefined ? finalText : streamText
    const next = content.slice(0, a.start) + text + content.slice(a.end)
    anchorRef.current = null
    setStreamText('')
    setStreaming(false)
    onContent(next)
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) { ta.selectionStart = ta.selectionEnd = a.start + text.length; ta.focus() }
    })
    void fromStream
  }

  function startGenerate() {
    if (!chapter || streaming) return
    const ta = taRef.current
    let start = ta.selectionStart
    let end = ta.selectionEnd
    let selection = ''
    if (mode === 'expand' || mode === 'polish') {
      if (start === end) { toast('请先在正文中选中要处理的片段'); ta.focus(); return }
      selection = content.slice(start, end)
    } else {
      end = start
    }
    if (mode === 'custom' && !instruction.trim()) { toast('请输入自定义写作指令'); return }

    anchorRef.current = { start, end }
    setStreaming(true)
    setStreamText('')
    setMeta(null)
    setExtractInfo(null)

    abortRef.current = streamGenerate(project.id, {
      chapterId: chapter.id, mode, selection, instruction
    }, {
      onMeta: (m) => setMeta(m),
      onChunk: (t) => setStreamText(p => p + t),
      onDone: (d) => settle(d.text),
      onError: (msg, aborted) => {
        if (msg && !aborted) toast('生成失败: ' + msg + '（已保留生成的部分）')
        // 中止与报错都保留已生成的部分，保证后续后台整理与正文一致
        settle(undefined, true)
      },
      onPostprocessQueued: () => setExtractInfo({ state: 'queued' }),
      onExtractStart: () => setExtractInfo({ state: 'running' }),
      onExtract: (d) => {
        setExtractInfo({ state: 'done', added: d.added, updated: d.updated, summaryUpdated: d.summaryUpdated, folded: d.folded })
        if (d.added.length || d.updated.length || d.summaryUpdated) onWorldbookChanged()
      },
      onExtractError: (e) => setExtractInfo({ state: 'error', message: e.message }),
      onEnd: () => setStreaming(false)
    })
  }

  // ---------- 选区快速入库 ----------
  function onSelect() {
    const ta = taRef.current
    if (!ta || streaming) return
    if (ta.selectionStart !== ta.selectionEnd) {
      setSel({ start: ta.selectionStart, end: ta.selectionEnd, text: ta.value.slice(ta.selectionStart, ta.selectionEnd) })
    } else if (sel) setSel(null)
  }

  async function submitQuickAdd(entry) {
    try {
      await api.addEntry(project.id, entry)
      toast(`「${entry.name}」已加入世界书`)
      setQuickAdd(null)
      onWorldbookChanged()
    } catch (e) {
      toast('添加失败: ' + e.message)
    }
  }

  const charCount = display.length

  return (
    <main className="editor-main">
      <div className="editor-head">
        <input
          className="chapter-title"
          value={chapter?.title || ''}
          onChange={e => { /* 标题改名由 Sidebar 管理，这里仅展示 */ }}
          readOnly
          title="章节标题"
        />
        <span className="char-count">{charCount.toLocaleString()} 字</span>
        {sel && !streaming && (
          <button className="btn small quick-add" onClick={() => setQuickAdd({ text: sel.text })}>
            ✦ 将选中内容加入世界书
          </button>
        )}
      </div>
      <textarea
        ref={taRef}
        className="editor"
        value={display}
        readOnly={streaming}
        placeholder="开始写下第一句话…（生成时会自动提取人物与物品进世界书）"
        onChange={e => onContent(e.target.value)}
        onSelect={onSelect}
        onKeyDown={e => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !streaming) { e.preventDefault(); startGenerate() }
        }}
      />
      <div className="gen-bar">
        <select value={mode} onChange={e => setMode(e.target.value)} disabled={streaming}>
          {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input
          className="instruction"
          placeholder={mode === 'custom' ? '写作指令，如：写一段雨夜追逐戏' : '附加要求（可选）'}
          value={instruction}
          onChange={e => setInstruction(e.target.value)}
          disabled={streaming}
          onKeyDown={e => e.key === 'Enter' && !streaming && startGenerate()}
        />
        {streaming ? (
          <button className="btn danger" onClick={stopGenerate}>■ 停止</button>
        ) : (
          <button className="btn primary" onClick={startGenerate} disabled={!chapter}>✍ 生成 (Ctrl+Enter)</button>
        )}
        <div className="gen-status">
          {meta && <span title="本次提示词注入的世界书条目数">注入 {meta.stats?.usedEntries ?? 0} 条设定</span>}
          {streaming && <span className="dot-pulse">生成中…</span>}
          {extractInfo?.state === 'queued' && <span className="dot-pulse" title="后台任务串行执行，间隔数秒，用户可继续操作">后台整理排队中…</span>}
          {extractInfo?.state === 'running' && <span className="dot-pulse">世界书与摘要整理中…</span>}
          {extractInfo?.state === 'done' && (
            <span className="extract-ok">
              ✦ {extractInfo.added?.length ? `新增 ${extractInfo.added.map(a => a.name).join('、')}` : '无新增'}
              {extractInfo.updated?.length ? `；更新 ${extractInfo.updated.map(u => u.name).join('、')}` : ''}
              {extractInfo.summaryUpdated ? '；摘要已更新' : ''}
            </span>
          )}
          {extractInfo?.state === 'error' && <span className="extract-err" title={extractInfo.message}>后台整理失败</span>}
        </div>
      </div>

      {quickAdd && (
        <QuickAddModal
          text={quickAdd.text}
          onClose={() => setQuickAdd(null)}
          onSubmit={submitQuickAdd}
        />
      )}
    </main>
  )
}

// 选中文字 → 快速入库弹窗
function QuickAddModal({ text, onClose, onSubmit }) {
  const [type, setType] = useState('character')
  const [name, setName] = useState('')
  const [content, setContent] = useState(text)
  const [aliases, setAliases] = useState('')

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>加入世界书</h3>
        <label>类型</label>
        <select value={type} onChange={e => setType(e.target.value)}>
          {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <label>名称 *</label>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="实体名称，如：青霜剑" />
        <label>别名 / 触发词（逗号分隔）</label>
        <input value={aliases} onChange={e => setAliases(e.target.value)} placeholder="别名、昵称、称号…后续出现这些词会自动注入" />
        <label>设定描述 *</label>
        <textarea rows={5} value={content} onChange={e => setContent(e.target.value)} />
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!name.trim() || !content.trim()}
            onClick={() => onSubmit({
              type, name: name.trim(),
              aliases: aliases.split(/[,，、]/).map(s => s.trim()).filter(Boolean),
              content: content.trim()
            })}
          >保存</button>
        </div>
      </div>
    </div>
  )
}
