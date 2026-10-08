// SillyTavern 酒馆预设兼容：解析 / 宏引擎 / 消息组装 / 输出标签流式过滤
const ctx = require('./context')
const { formatSection, buildContextText, scanWorldbook, injectAuthorNote, MODE_INSTRUCTION } = ctx

const MARKER_IDS = [
  'worldInfoBefore', 'worldInfoAfter', 'personaDescription', 'charDescription',
  'charPersonality', 'scenario', 'dialogueExamples', 'chatHistory', 'agentSystemPrompt',
  'agentTask', 'agentResults', 'main', 'nsfw', 'jailbreak'
]
const ROLES = ['system', 'user', 'assistant']

// ---------- 解析与规范化 ----------

// 导入用：ST 预设原始 JSON → 规范化 schema（prompts 已按 prompt_order 排序）
function parsePreset(raw) {
  if (!raw || !Array.isArray(raw.prompts)) throw new Error('不是有效的 SillyTavern 预设（缺少 prompts 数组）')
  const rawPrompts = raw.prompts
  const order = Array.isArray(raw.prompt_order?.[0]?.order)
    ? raw.prompt_order[0].order
    : rawPrompts.map(p => ({ identifier: p.identifier, enabled: p.enabled !== false }))
  const byId = new Map(rawPrompts.map(p => [p.identifier, p]))
  const prompts = []
  for (const item of order) {
    if (!item || !item.identifier) continue
    let p = byId.get(item.identifier)
    if (!p) {
      // order 引用了不存在的标准 marker → 合成空占位条目；非标准 identifier → 跳过
      if (MARKER_IDS.includes(item.identifier)) p = { identifier: item.identifier, role: 'system', content: '' }
      else continue
    }
    prompts.push({
      identifier: p.identifier,
      name: typeof p.name === 'string' ? p.name : p.identifier,
      role: ROLES.includes(p.role) ? p.role : 'system',
      content: typeof p.content === 'string' ? p.content : '',
      marker: MARKER_IDS.includes(p.identifier),
      enabled: item.enabled !== false && p.enabled !== false,
      injection_position: +p.injection_position === 1 ? 1 : 0,
      injection_depth: Number.isFinite(+p.injection_depth) ? +p.injection_depth : 4
    })
  }
  return {
    id: '', // 由 store 分配
    name: (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim() : '未命名预设',
    importedAt: Date.now(),
    cleanOutput: true,
    prompts
  }
}

// 落盘数据加载用：补全缺失字段
function normalizePreset(saved) {
  if (!saved || !Array.isArray(saved.prompts)) return null
  const prompts = saved.prompts.filter(p => p && typeof p.identifier === 'string').map(p => ({
    identifier: p.identifier,
    name: typeof p.name === 'string' ? p.name : p.identifier,
    role: ROLES.includes(p.role) ? p.role : 'system',
    content: typeof p.content === 'string' ? p.content : '',
    marker: MARKER_IDS.includes(p.identifier),
    enabled: p.enabled !== false,
    injection_position: +p.injection_position === 1 ? 1 : 0,
    injection_depth: Number.isFinite(+p.injection_depth) ? +p.injection_depth : 4
  }))
  return {
    id: saved.id,
    name: (typeof saved.name === 'string' && saved.name.trim()) ? saved.name.trim() : '未命名预设',
    importedAt: +saved.importedAt || Date.now(),
    cleanOutput: saved.cleanOutput !== false,
    prompts
  }
}

// ---------- 宏引擎 ----------

// 深度计数扫描：正确处理 {{setvar::x::a {{getvar::y}} b}} 嵌套；未闭合视为纯文本
function scanMacros(text) {
  const spans = []
  let i = 0
  while (true) {
    const j = text.indexOf('{{', i)
    if (j < 0) break
    let depth = 1
    let k = j + 2
    while (k < text.length && depth > 0) {
      if (text.startsWith('{{', k)) { depth++; k += 2 }
      else if (text.startsWith('}}', k)) { depth--; k += 2 }
      else k++
    }
    if (depth !== 0) { i = j + 2; continue }
    spans.push({ start: j, end: k, inner: text.slice(j + 2, k - 2) })
    i = k
  }
  return spans
}

// 展开单条 prompt 内容里的宏。vars 为本次组装共享的变量表（按 order 顺序传递）
function expandContent(content, vars, names, depthGuard = 0) {
  if (!content || !content.includes('{{')) return { text: content || '', trimSeen: false }
  if (depthGuard > 8) return { text: content, trimSeen: false }
  const spans = scanMacros(content)
  if (!spans.length) return { text: content, trimSeen: false }
  let out = ''
  let pos = 0
  let trimSeen = false
  for (const s of spans) {
    out += content.slice(pos, s.start)
    pos = s.end
    const inner = s.inner
    if (inner.startsWith('//')) continue // {{//注释}}：删除
    const low = inner.toLowerCase()
    if (low === 'trim') { trimSeen = true; continue }
    if (low === 'char') { out += names.charName || ''; continue }
    if (low === 'user') { out += names.userName || ''; continue }
    if (low.startsWith('getvar::')) {
      const name = inner.slice('getvar::'.length)
      out += Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : ''
      continue
    }
    if (low.startsWith('setvar::')) {
      const rest = inner.slice('setvar::'.length)
      const sep = rest.indexOf('::')
      const name = sep >= 0 ? rest.slice(0, sep) : rest
      const val = sep >= 0 ? rest.slice(sep + 2) : ''
      vars[name] = expandContent(val, vars, names, depthGuard + 1).text
      continue // setvar 本体从文本移除
    }
    out += content.slice(s.start, s.end) // 未知宏原样保留
  }
  out += content.slice(pos)
  if (trimSeen) out = out.split('\n').filter(l => l.trim() !== '').join('\n')
  return { text: out, trimSeen }
}

// ---------- 消息组装 ----------

// 返回结构与 buildPrompt 同构：{ messages, usedEntries, stats }
function buildPresetMessages({ preset, project, chapter, mode = 'continue', selection = '', instruction = '', charName = '', userName = '' }) {
  const settings = project.settings
  const { contextText } = buildContextText({ project, chapter, mode, selection })
  const { pinned, wiBefore, wiAfter, scanWindow } = scanWorldbook(project, contextText)
  const { text: historyText } = injectAuthorNote(contextText, settings.authorNote, settings.authorNoteDepth)

  // ---- marker 数据表（本项目数据 → ST 占位符）----
  let taskText = MODE_INSTRUCTION[mode] || ''
  if (mode === 'custom') taskText = ''
  if (instruction?.trim()) taskText += (taskText ? '\n\n' : '') + `【本次额外要求】${instruction.trim()}`
  const sysPrompt = settings.systemPrompt?.trim() || ''
  const M = {
    worldInfoBefore: formatSection('世界观设定（前置）', wiBefore),
    worldInfoAfter: formatSection('相关设定（本次剧情涉及）', wiAfter),
    personaDescription: '',
    charDescription: formatSection('主要角色与常驻设定', pinned),
    charPersonality: '',
    scenario: settings.storyBible?.trim() ? `# 本书大纲与核心设定\n${settings.storyBible.trim()}` : '',
    dialogueExamples: '',
    chatHistory: historyText,
    agentSystemPrompt: sysPrompt,
    main: sysPrompt,
    agentTask: taskText,
    agentResults: '',
    nsfw: '',
    jailbreak: ''
  }

  // ---- 按 order 顺序组装 ----
  const vars = {}
  const names = { charName: charName || '', userName: userName || '' }
  const messages = []
  const absolutes = []
  for (const p of preset.prompts) {
    if (!p.enabled) continue
    // marker 注入数据源（数据内的 {{ 原样保留，防注入）；普通条目展开宏
    const content = p.marker ? (M[p.identifier] ?? '') : expandContent(p.content, vars, names).text
    if (!content.trim()) continue
    if (!p.marker && p.injection_position === 1) {
      absolutes.push({ role: p.role, content, depth: p.injection_depth })
    } else {
      messages.push({ role: p.role, content })
    }
  }

  // ---- 绝对注入：按 depth 降序插入（基准排除末尾 assistant prefill，防其脱离末位）----
  if (absolutes.length) {
    const isPrefill = messages.length > 0 && messages[messages.length - 1].role === 'assistant'
    const base = messages.length - (isPrefill ? 1 : 0)
    const groups = new Map()
    for (const a of absolutes) {
      if (!groups.has(a.depth)) groups.set(a.depth, [])
      groups.get(a.depth).push(a)
    }
    for (const depth of [...groups.keys()].sort((a, b) => b - a)) {
      const idx = Math.max(0, base - depth)
      messages.splice(idx, 0, ...groups.get(depth).map(a => ({ role: a.role, content: a.content })))
    }
  }

  if (!messages.length) throw new Error('预设组装结果为空：请检查预设条目开关或 marker 占位符')

  const usedEntries = [...wiBefore, ...pinned, ...wiAfter].map(e => ({
    id: e.id, name: e.name, type: e.type,
    source: e.pinned ? 'pinned' : 'scan',
    position: e.pinned ? 'pinned' : e.position
  }))
  const activeMarkers = preset.prompts
    .filter(p => p.enabled && p.marker && (M[p.identifier] ?? '').trim())
    .map(p => p.identifier)

  return {
    messages,
    usedEntries,
    stats: {
      mode,
      preset: true,
      presetName: preset.name,
      messageCount: messages.length,
      contextChars: contextText.length,
      totalChars: messages.reduce((s, m) => s + m.content.length, 0),
      usedEntries: usedEntries.length,
      scanWindow,
      activeMarkers
    }
  }
}

// ---------- 输出标签流式过滤 ----------
// 剥离 <thinking>…</thinking> 块与 <Interleaving> 标签（大小写不敏感，跨 chunk 安全）
function createOutputFilter() {
  const BLOCK_OPEN = '<thinking>'
  const BLOCK_CLOSE = '</thinking>'
  const STRIP_TAGS = ['<interleaving>', '</interleaving>']
  let state = 'normal' // normal | thinking
  let pending = ''

  function findTag() {
    const lower = pending.toLowerCase()
    const candidates = state === 'normal'
      ? [BLOCK_OPEN, BLOCK_CLOSE, ...STRIP_TAGS]
      : [BLOCK_CLOSE]
    let best = -1
    let bestTag = null
    for (const t of candidates) {
      const i = lower.indexOf(t)
      if (i >= 0 && (best < 0 || i < best)) { best = i; bestTag = t }
    }
    return best < 0 ? null : { idx: best, tag: bestTag }
  }

  // 尾部悬挂：pending 末尾与某标签的真前缀最大公共长度（滞留下个 chunk 判定）
  function trailingPrefixLen() {
    const tags = state === 'normal'
      ? [BLOCK_OPEN, BLOCK_CLOSE, ...STRIP_TAGS]
      : [BLOCK_CLOSE]
    const lower = pending.toLowerCase()
    let max = 0
    for (const tag of tags) {
      const lim = Math.min(pending.length, tag.length - 1)
      for (let n = lim; n > max; n--) {
        if (lower.endsWith(tag.slice(0, n))) { max = n; break }
      }
    }
    return max
  }

  function push(chunk) {
    pending += chunk
    let out = ''
    while (true) {
      const hit = findTag()
      if (hit) {
        if (state === 'normal') out += pending.slice(0, hit.idx)
        pending = pending.slice(hit.idx + hit.tag.length)
        if (hit.tag === BLOCK_OPEN) state = 'thinking'
        else if (hit.tag === BLOCK_CLOSE) state = 'normal' // 孤儿闭合标签在 normal 态直接删
        continue
      }
      const k = trailingPrefixLen()
      if (state === 'normal') out += pending.slice(0, pending.length - k)
      pending = pending.slice(pending.length - k)
      break
    }
    return out
  }

  function end() {
    const rest = state === 'normal' ? pending : ''
    pending = ''
    return rest
  }

  return { push, end }
}

module.exports = { parsePreset, normalizePreset, buildPresetMessages, createOutputFilter, expandContent, MARKER_IDS }
