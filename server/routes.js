// 全部 REST API 路由 + SSE 生成端点
const express = require('express')
const store = require('./store')
const { buildPrompt } = require('./prompt')
const { buildPresetMessages, createOutputFilter } = require('./preset')
const { chatStream, listModels } = require('./llm')
const { extract, postprocess, applyExtraction } = require('./extractor')
const memory = require('./memory')
const queue = require('./queue')
const requestlog = require('./requestlog')

const router = express.Router()

const POSTPROCESS_DELAY_MS = 3500 // 生成完成后的后台整理延迟（公益站友好：避免连续密集请求）
const POSTPROCESS_MIN_CHARS = 60  // 已生成文本不足该长度时不做后台整理

const wrap = fn => (req, res) => {
  Promise.resolve(fn(req, res)).catch(e => {
    if (!res.headersSent) res.status(500).json({ error: e.message })
  })
}

// 解析"完整章节文本"：优先用章节实际内容（前端会自动保存）；
// 若尚未保存（内容里找不到新增文本的尾部），则把新增文本补在后面
function resolveFullText(chapter, delta) {
  const content = chapter?.content || ''
  const d = (delta || '').trim()
  if (!d) return content
  if (!content) return delta
  const tail = d.slice(-60)
  if (tail && content.includes(tail)) return content
  return content + delta
}

// 后台整理执行器：抽取 + 摘要（一次调用）→ 写入世界书与记忆 → 记录发送 → 自动折叠
function makePostprocessExecutor(pid, cid) {
  return async ({ delta }) => {
    const p = store.getProject(pid)
    if (!p) return { added: [], updated: [], skipped: 0, summaryUpdated: false }
    const chapter = store.findChapter(p, cid)
    if (!chapter) return { added: [], updated: [], skipped: 0, summaryUpdated: false }
    const cfg = store.rawConfig()
    const full = resolveFullText(chapter, delta)
    const r = await postprocess(cfg, p, { delta, full }, null)
    const applied = applyExtraction(p, r.extraction)
    let summaryUpdated = false
    if (r.summary) {
      memory.setSummary(p, cid, r.summary, full.length)
      summaryUpdated = true
    }
    if (applied.added.length || applied.updated.length || summaryUpdated) store.touch(p)
    requestlog.record(pid, {
      kind: 'postprocess',
      model: cfg.extractModel || cfg.model,
      messages: r.messages,
      response: r.raw,
      detail: {
        added: applied.added.length,
        updated: applied.updated.length,
        summaryChars: r.summary.length,
        chapterTitle: chapter.title
      }
    })
    // 未折叠摘要达到阈值时自动折叠为卷摘要
    let folded = null
    try {
      folded = await memory.maybeFold(cfg, p)
      if (folded) store.touch(p)
    } catch {}
    return { ...applied, summaryUpdated, folded }
  }
}

// 摘要补建状态（内存态，供记忆面板轮询）
const rebuildState = new Map()

// ---------- 配置 ----------
router.get('/config', (req, res) => res.json(store.getConfig()))
router.put('/config', wrap((req, res) => res.json(store.updateConfig(req.body))))

// 拉取可用模型列表（支持传入未保存的表单值；Key 为掩码时回退到已保存值）
router.post('/models', wrap(async (req, res) => {
  const cfg = store.rawConfig()
  const body = req.body || {}
  const baseUrl = String(body.baseUrl || cfg.baseUrl || '').trim()
  let apiKey = String(body.apiKey || '').trim()
  if (!apiKey || /^[●]+$/.test(apiKey)) apiKey = cfg.apiKey
  if (!baseUrl) return res.status(400).json({ error: '请先填写 API 地址' })
  if (!apiKey) return res.status(400).json({ error: '请先填写 API Key' })
  const models = await listModels({ baseUrl, apiKey })
  res.json({ models })
}))

// ---------- 酒馆预设库（全局） ----------
router.get('/presets', (req, res) => res.json(store.listPresets()))
router.get('/presets/:pid', (req, res) => {
  const ps = store.getPreset(req.params.pid)
  if (!ps) return res.status(404).json({ error: '预设不存在' })
  res.json(ps)
})
router.post('/presets', wrap((req, res) => {
  const body = req.body || {}
  // 支持两种：{ name, data: ST原始JSON } 包装，或直接 ST 原始 JSON
  const raw = (body.data && typeof body.data === 'object') ? body.data : body
  res.json(store.createPreset(raw, body.name))
}))
router.put('/presets/:pid', wrap((req, res) => {
  const ps = store.updatePreset(req.params.pid, req.body || {})
  if (!ps) return res.status(404).json({ error: '预设不存在' })
  res.json(ps)
}))
router.delete('/presets/:pid', (req, res) => {
  store.deletePreset(req.params.pid)
  res.json({ ok: true })
})

// ---------- 项目 ----------
router.get('/projects', (req, res) => res.json(store.listProjects()))

router.post('/projects', wrap((req, res) => {
  const p = store.createProject((req.body.name || '').trim())
  res.json(p)
}))

router.get('/projects/:id', (req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  res.json(p)
})

router.put('/projects/:id', wrap((req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  const { name, settings } = req.body || {}
  if (name !== undefined && String(name).trim()) p.name = String(name).trim()
  if (settings && typeof settings === 'object') Object.assign(p.settings, settings)
  store.touch(p)
  res.json(p)
}))

router.delete('/projects/:id', (req, res) => {
  store.deleteProject(req.params.id)
  res.json({ ok: true })
})

// ---------- 章节 ----------
router.post('/projects/:id/chapters', wrap((req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  res.json(store.addChapter(p, (req.body.title || '').trim()))
}))

router.put('/projects/:id/chapters/:cid', wrap((req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  const c = store.updateChapter(p, req.params.cid, req.body || {})
  if (!c) return res.status(404).json({ error: '章节不存在' })
  res.json({ ok: true, chapter: c })
}))

router.delete('/projects/:id/chapters/:cid', (req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  store.deleteChapter(p, req.params.cid)
  res.json({ ok: true })
})

// ---------- 世界书 ----------
router.post('/projects/:id/worldbook', wrap((req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  const e = store.addEntry(p, req.body || {})
  if (!e) return res.status(400).json({ error: '条目名称不能为空' })
  res.json(e)
}))

router.put('/projects/:id/worldbook/:eid', wrap((req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  const e = store.updateEntry(p, req.params.eid, req.body || {})
  if (!e) return res.status(404).json({ error: '条目不存在' })
  res.json(e)
}))

router.delete('/projects/:id/worldbook/:eid', (req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  store.deleteEntry(p, req.params.eid)
  res.json({ ok: true })
})

// ---------- 分层记忆 ----------
router.get('/projects/:id/memory', (req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  const rb = rebuildState.get(p.id) || null
  res.json({
    ...memory.overview(p),
    rebuilding: rb ? { total: rb.total, done: rb.done, failed: rb.failed, running: rb.done < rb.total } : null,
    queue: queue.status()
  })
})

// 补齐缺失摘要（后台串行执行，返回后由前端轮询进度）
router.post('/projects/:id/memory/rebuild', wrap(async (req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  const cov = memory.coverage(p)
  if (!cov.missing.length) return res.json({ queued: 0 })
  const state = { total: cov.missing.length, done: 0, failed: 0, startedAt: Date.now() }
  rebuildState.set(p.id, state)
  for (const cid of cov.missing) {
    queue.enqueue({
      key: `sum:${p.id}:${cid}`,
      delayMs: 1200,
      executor: async () => {
        const proj = store.getProject(p.id)
        const chapter = proj && store.findChapter(proj, cid)
        if (!proj || !chapter) { state.done++; return }
        try {
          const cfg = store.rawConfig()
          const text = await memory.summarizeChapter(cfg, proj, chapter, null)
          if (text) {
            memory.setSummary(proj, cid, text, (chapter.content || '').length)
            store.touch(proj)
          }
        } catch { state.failed++ }
        state.done++
      }
    }).catch(() => { state.done++ })
  }
  res.json({ queued: cov.missing.length })
}))

// 手动折叠为卷摘要
router.post('/projects/:id/memory/fold', wrap(async (req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  const r = await queue.enqueue({
    key: `fold:${p.id}`,
    delayMs: 600,
    executor: async () => {
      const proj = store.getProject(p.id)
      if (!proj) return null
      const out = await memory.maybeFold(store.rawConfig(), proj, { force: true })
      if (out) store.touch(proj)
      return out
    }
  })
  res.json(r || { count: 0 })
}))

// ---------- 发送记录 ----------
router.get('/projects/:id/requests', (req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  res.json(requestlog.list(req.params.id))
})

router.get('/projects/:id/requests/:rid', (req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  const r = requestlog.get(req.params.id, req.params.rid)
  if (!r) return res.status(404).json({ error: '记录不存在' })
  res.json(r)
})

// ---------- 提示词预览 ----------
router.post('/projects/:id/preview', wrap((req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  const { chapterId, mode, selection, instruction } = req.body || {}
  const chapter = store.findChapter(p, chapterId)
  if (!chapter) return res.status(400).json({ error: '请选择章节' })
  const presetObj = p.settings.presetId ? store.getPreset(p.settings.presetId) : null
  res.json(presetObj
    ? buildPresetMessages({ preset: presetObj, project: p, chapter, mode, selection, instruction, charName: p.settings.presetCharName, userName: p.settings.presetUserName })
    : buildPrompt({ project: p, chapter, mode, selection, instruction }))
}))

// ---------- 生成（SSE 流式） ----------
router.post('/projects/:id/generate', wrap(async (req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  const { chapterId, mode = 'continue', selection = '', instruction = '' } = req.body || {}
  const chapter = store.findChapter(p, chapterId)
  if (!chapter) return res.status(400).json({ error: '请选择章节' })

  const presetObj = p.settings.presetId ? store.getPreset(p.settings.presetId) : null
  const built = presetObj
    ? buildPresetMessages({ preset: presetObj, project: p, chapter, mode, selection, instruction, charName: p.settings.presetCharName, userName: p.settings.presetUserName })
    : buildPrompt({ project: p, chapter, mode, selection, instruction })
  const cfg = store.rawConfig()

  // 记录本次实际发送的内容（供「注入预览 → 发送历史」检查）
  const recordId = requestlog.record(p.id, {
    kind: 'generate',
    mode,
    model: cfg.model,
    messages: built.messages,
    stats: built.stats,
    detail: {
      usedEntries: built.usedEntries,
      breakdown: built.stats?.contextBreakdown || null,
      preset: built.stats?.preset ? built.stats.presetName : null,
      chapterTitle: chapter.title
    },
    status: 'streaming'
  })

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (event, data) => {
    try {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {}
  }

  send('meta', { usedEntries: built.usedEntries, stats: built.stats, model: cfg.model, recordId })

  const controller = new AbortController()
  // 注意：Node 18+ 里 req 的 close 在请求体读完后就会触发，不能用它判断断开
  res.on('close', () => { if (!res.writableEnded) controller.abort() })

  // 预设模式：流式剥离 <thinking> 块与 <Interleaving> 标签（cleaned 为唯一真源，与 chunk 流一致）
  const filter = (presetObj && presetObj.cleanOutput !== false) ? createOutputFilter() : null
  let cleaned = ''

  queue.beginGeneration()
  let finalText = null
  let produced = ''   // 已生成的部分文本（成功/报错/中止都保留）
  let streamErr = null
  try {
    const text = await chatStream(cfg, {
      messages: built.messages,
      signal: controller.signal,
      onChunk: c => {
        if (!filter) { produced += c; send('chunk', { text: c }); return }
        const out = filter.push(c)
        if (out) { cleaned += out; produced += out; send('chunk', { text: out }) }
      }
    })
    if (filter) {
      const tail = filter.end()
      if (tail) { cleaned += tail; produced += tail; send('chunk', { text: tail }) }
    }
    finalText = filter ? cleaned : text
    send('done', { text: finalText, stats: built.stats })
    requestlog.update(p.id, recordId, { status: 'done' })
  } catch (e) {
    streamErr = e
    const aborted = e.name === 'AbortError' || /aborted/i.test(e.message || '')
    requestlog.update(p.id, recordId, { status: aborted ? 'aborted' : 'error', response: e.message })
    send('error', { aborted, message: aborted ? '已停止生成' : e.message })
  } finally {
    // 生成阶段到此结束（先释放，后台整理才能通过队列的"生成期间让路"检查）
    queue.endGeneration()
  }

  // 后台整理（世界书抽取 + 章节摘要，合并一次调用；参与全局串行队列）
  // 注意：正文生成报错或中途停止时，只要已产出足够文本，仍然执行整理（不跳过）
  const autoOn = p.settings.autoExtract !== false && !p.settings.thriftyMode
  const deltaText = (finalText || produced || '').trim()
  if (autoOn && deltaText.length >= POSTPROCESS_MIN_CHARS) {
    send('postprocess-queued', { delayMs: POSTPROCESS_DELAY_MS, partial: !!streamErr })
    try {
      const applied = await queue.enqueue({
        key: `post:${p.id}:${chapterId}`,
        delayMs: POSTPROCESS_DELAY_MS,
        payload: { delta: deltaText },
        mergePayload: (a, b) => ({ delta: `${a.delta}\n${b.delta}` }),
        executor: makePostprocessExecutor(p.id, chapterId)
      })
      send('extract', applied)
    } catch (e) {
      send('extract-error', { message: e.message })
    }
  }
  try { res.end() } catch {}
}))

// ---------- 手动抽取 ----------
router.post('/projects/:id/extract', wrap(async (req, res) => {
  const p = store.getProject(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  const { text, chapterId } = req.body || {}
  let source = (text || '').trim()
  if (!source && chapterId) {
    const c = store.findChapter(p, chapterId)
    if (c) source = (c.content || '').trim()
  }
  if (!source) return res.status(400).json({ error: '没有可抽取的文本' })
  const cfg = store.rawConfig()
  const r = await extract(cfg, p, source, null)
  const applied = applyExtraction(p, r.extraction)
  if (applied.added.length || applied.updated.length) store.touch(p)
  requestlog.record(p.id, {
    kind: 'extract',
    model: cfg.extractModel || cfg.model,
    messages: r.messages,
    response: r.raw,
    detail: { added: applied.added.length, updated: applied.updated.length }
  })
  res.json(applied)
}))

module.exports = router
