// 全部 REST API 路由 + SSE 生成端点
const express = require('express')
const store = require('./store')
const { buildPrompt } = require('./prompt')
const { buildPresetMessages, createOutputFilter } = require('./preset')
const { chatStream } = require('./llm')
const { extract, applyExtraction } = require('./extractor')

const router = express.Router()

const wrap = fn => (req, res) => {
  Promise.resolve(fn(req, res)).catch(e => {
    if (!res.headersSent) res.status(500).json({ error: e.message })
  })
}

// ---------- 配置 ----------
router.get('/config', (req, res) => res.json(store.getConfig()))
router.put('/config', wrap((req, res) => res.json(store.updateConfig(req.body))))

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

  send('meta', { usedEntries: built.usedEntries, stats: built.stats, model: cfg.model })

  const controller = new AbortController()
  // 注意：Node 18+ 里 req 的 close 在请求体读完后就会触发，不能用它判断断开
  res.on('close', () => { if (!res.writableEnded) controller.abort() })

  // 预设模式：流式剥离 <thinking> 块与 <Interleaving> 标签（cleaned 为唯一真源，与 chunk 流一致）
  const filter = (presetObj && presetObj.cleanOutput !== false) ? createOutputFilter() : null
  let cleaned = ''

  try {
    const text = await chatStream(cfg, {
      messages: built.messages,
      signal: controller.signal,
      onChunk: c => {
        if (!filter) { send('chunk', { text: c }); return }
        const out = filter.push(c)
        if (out) { cleaned += out; send('chunk', { text: out }) }
      }
    })
    if (filter) {
      const tail = filter.end()
      if (tail) { cleaned += tail; send('chunk', { text: tail }) }
    }
    const finalText = filter ? cleaned : text
    send('done', { text: finalText, stats: built.stats })
    if (p.settings.autoExtract && finalText.trim()) {
      send('extract-start', {})
      try {
        const result = await extract(cfg, p, finalText, null)
        const applied = applyExtraction(p, result)
        if (applied.added.length || applied.updated.length) store.touch(p)
        send('extract', applied)
      } catch (e) {
        send('extract-error', { message: e.message })
      }
    }
  } catch (e) {
    const aborted = e.name === 'AbortError' || /aborted/i.test(e.message || '')
    send('error', { aborted, message: aborted ? '已停止生成' : e.message })
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
  const result = await extract(cfg, p, source, null)
  const applied = applyExtraction(p, result)
  if (applied.added.length || applied.updated.length) store.touch(p)
  res.json(applied)
}))

module.exports = router
