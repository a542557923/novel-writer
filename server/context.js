// 提示词组装的共享纯函数：正文上下文、世界书扫描、条目格式化（prompt.js 与 preset.js 共用）
const TYPE_LABEL = {
  character: '人物', item: '物品', location: '地点',
  organization: '组织', lore: '设定', other: '其他'
}

// 英文词条用词边界匹配，避免 "he" 误命中 "she"；中文直接包含
function makeMatcher(word) {
  if (/^[A-Za-z0-9\s'’-]+$/.test(word) && word.trim()) {
    try { return new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i') }
    catch { return null }
  }
  return null
}

function entryHit(entry, text) {
  const words = [entry.name, ...entry.aliases, ...entry.keywords].filter(Boolean)
  for (const w of words) {
    const re = makeMatcher(w)
    if (re ? re.test(text) : text.includes(w)) return true
  }
  return false
}

function formatEntry(e) {
  const alias = e.aliases?.length ? `（又称：${e.aliases.join('、')}）` : ''
  return `[${TYPE_LABEL[e.type] || '其他'}] ${e.name}${alias}\n${e.content}`
}

function formatSection(title, entries) {
  if (!entries.length) return ''
  const sorted = [...entries].sort((a, b) => a.priority - b.priority)
  return `# ${title}\n${sorted.map(formatEntry).join('\n\n')}`
}

// 上下文：前面章节尾部 + 当前章正文，按预算截断
function buildContext(project, chapter) {
  const budget = project.settings.contextChars || 12000
  const parts = []
  let used = 0
  // 当前章（从后往前不可能超过一整章太多，直接取尾部）
  const cur = chapter.content || ''
  let curText = cur
  if (cur.length > budget) curText = cur.slice(-budget)
  // 前面章节：从最近的往回，按尾部拼
  const prev = project.chapters.filter(c => c.order < chapter.order).sort((a, b) => b.order - a.order)
  for (const c of prev) {
    const remain = budget - curText.length
    if (remain <= 300) break
    const body = c.content || ''
    if (!body) continue
    const seg = body.length > remain ? body.slice(-remain) : body
    parts.unshift(`《${c.title}》\n${seg}`)
    used += seg.length
    if (body.length > remain) break // 再往前已被截断，无需继续
  }
  const prevText = parts.join('\n\n')
  return {
    prevText,
    curText,
    text: (prevText ? prevText + '\n\n' : '') + curText
  }
}

// 组装正文上下文：expand/polish 用选中片段局部上下文，其余用全量上下文
function buildContextText({ project, chapter, mode = 'continue', selection = '' }) {
  let contextText
  let selectionBlock = ''
  if ((mode === 'expand' || mode === 'polish') && selection) {
    const cur = chapter.content || ''
    const at = cur.indexOf(selection)
    const head = at > 2000 ? cur.slice(at - 2000, at) : cur.slice(0, Math.max(0, at))
    const tail = cur.slice(at + selection.length, at + selection.length + 2000)
    const blocks = []
    if (head.trim()) blocks.push(`【片段前文】\n${head}`)
    selectionBlock = `【待处理片段】\n${selection}`
    blocks.push(selectionBlock)
    if (tail.trim()) blocks.push(`【片段后文】\n${tail}`)
    contextText = blocks.join('\n\n')
  } else {
    contextText = buildContext(project, chapter).text
  }
  return { contextText, selectionBlock }
}

// 世界书扫描：常驻 + 触发（按扫描窗口匹配）
function scanWorldbook(project, contextText) {
  const settings = project.settings
  const enabled = project.worldbook.filter(e => e.enabled)
  const pinned = enabled.filter(e => e.pinned)
  const regular = enabled.filter(e => !e.pinned)
  const scanText = contextText.slice(-(settings.scanChars || 4000))
  const matched = regular.filter(e => entryHit(e, scanText))
  return {
    enabled, pinned,
    wiBefore: matched.filter(e => e.position === 'before'),
    wiAfter: matched.filter(e => e.position === 'after'),
    scanWindow: scanText.length
  }
}

// 作者注按"深度"插入上下文：深度 1 = 倒数第一段之前
function injectAuthorNote(contextText, note, depth) {
  if (!note?.trim()) return { text: contextText, injected: false }
  const paras = contextText.split(/\n\n+/)
  const d = Math.max(1, Math.min(depth || 1, paras.length))
  const idx = paras.length - d
  paras.splice(idx, 0, `【作者备注（写作要求优先级最高）】${note.trim()}`)
  return { text: paras.join('\n\n'), injected: true }
}

const MODE_INSTRUCTION = {
  continue: '请从上文结束处自然续写小说正文。直接输出正文内容。',
  expand: '请对【待处理片段】进行扩写：保留原意与关键情节，丰富细节、动作、对话与心理描写。直接输出扩写后的完整片段（它将替换原片段）。',
  polish: '请对【待处理片段】进行润色改写：提升文字表现力与节奏，修正平淡或不通顺之处，但不得改变情节走向与既定事实。直接输出改写后的完整片段（它将替换原片段）。'
}

module.exports = {
  TYPE_LABEL, entryHit, formatEntry, formatSection,
  buildContext, buildContextText, scanWorldbook, injectAuthorNote, MODE_INSTRUCTION
}
