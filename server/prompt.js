// ST 式提示词组装器 —— 顺序：System → WI-Before → Story Bible → 常驻/Pinned → WI-After → 正文上下文（作者注按深度插入）→ 指令
const DEFAULT_SYSTEM_PROMPT = `你是一位技艺精湛的小说作家，负责续写与创作小说正文。

写作要求：
1. 直接输出小说正文，禁止输出任何解释、标题、大纲、要点或元信息
2. 保持既定的文风、叙事人称与叙事节奏，与前文无缝衔接
3. 严格遵守设定资料中的人物性格、人物关系与世界观，不得自相矛盾
4. 出场人物的行为须符合其动机与性格逻辑
5. 多用场景细节、动作与对话推进情节，避免流水账式概述
6. 段落收尾留下自然的叙事余韵，便于后续继续续写`

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

function buildPrompt({ project, chapter, mode = 'continue', selection = '', instruction = '' }) {
  const settings = project.settings
  const sysPrompt = settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT

  // ---- 上下文 ----
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

  // ---- 世界书扫描 ----
  const enabled = project.worldbook.filter(e => e.enabled)
  const pinned = enabled.filter(e => e.pinned)
  const regular = enabled.filter(e => !e.pinned)
  const scanText = contextText.slice(-(settings.scanChars || 4000))
  const matched = regular.filter(e => entryHit(e, scanText))
  const wiBefore = matched.filter(e => e.position === 'before')
  const wiAfter = matched.filter(e => e.position === 'after')

  // ---- system 段 ----
  const sysSections = [
    sysPrompt,
    formatSection('世界观设定（常驻）', wiBefore),
    settings.storyBible?.trim() ? `# 本书大纲与核心设定\n${settings.storyBible.trim()}` : '',
    formatSection('主要角色与常驻设定', pinned),
    formatSection('相关设定（本次剧情涉及）', wiAfter)
  ].filter(Boolean)
  const systemText = sysSections.join('\n\n')

  // ---- 作者注 + 指令 ----
  const { text: contextWithNote } = injectAuthorNote(contextText, settings.authorNote, settings.authorNoteDepth)
  let directive = MODE_INSTRUCTION[mode] || ''
  if (mode === 'custom') directive = ''
  const extra = instruction?.trim() ? `\n\n【本次额外要求】${instruction.trim()}` : ''
  const userText = `${contextWithNote}\n\n${directive}${extra}`.trim()

  const messages = [
    { role: 'system', content: systemText },
    { role: 'user', content: userText }
  ]

  const usedEntries = [...wiBefore, ...pinned, ...wiAfter].map(e => ({
    id: e.id, name: e.name, type: e.type,
    source: e.pinned ? 'pinned' : 'scan',
    position: e.pinned ? 'pinned' : e.position
  }))

  return {
    messages,
    usedEntries,
    stats: {
      mode,
      contextChars: contextText.length,
      systemChars: systemText.length,
      totalChars: systemText.length + userText.length,
      usedEntries: usedEntries.length,
      scanWindow: scanText.length
    }
  }
}

module.exports = { buildPrompt, DEFAULT_SYSTEM_PROMPT, entryHit, buildContext }
