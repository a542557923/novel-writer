// 分层记忆：章节摘要 / 卷级折叠 / 上下文摘要块装配
//
// 数据挂在 project.memory 上：
//   {
//     summaries: { [chapterId]: { text, chars, srcChars, at } },  // 章摘要（srcChars 为生成时的正文长度，用于过期提示）
//     volumes:   [ { id, text, chars, chapterIds, at } ]          // 卷摘要（覆盖一批章的折叠结果，章摘要保留可溯源）
//   }
//
// 上下文装配策略：近 N 章用原文；更早的章节用摘要（若被卷覆盖则用卷摘要）；
// 按「新 → 旧」填充预算，放不下的旧内容在压缩层内被丢弃（dropped 计数）。
const { chatOnce } = require('./llm')

const FOLD_THRESHOLD = 10 // 未折叠的章摘要达到该数量时，自动折叠成一条卷摘要
const SUMMARY_MIN = 120   // 低于该字数的正文不生成摘要（太短没有记忆价值）

// 摘要写作要求（合流整理与补建共用）
const SUMMARY_RULE = `- 180~260 字，紧凑的第三人称叙述，写清发生了什么、推进到哪儿
- 必须保留：主要情节推进、人物状态变化（受伤 / 获得或失去物品 / 关系变化 / 位置变动）、尚未回收的伏笔与承诺（以【伏笔】标注）
- 可大幅省略：环境描写、对话细节、日常动作
- 若正文过短（少于两句话）或无实质剧情，输出空字符串`

const SUMMARY_SYSTEM = `你是小说编辑，负责把一章正文压缩成后续写作要用的「剧情记忆」摘要。

要求：
${SUMMARY_RULE}

输出纯文本，不要标题、不要 JSON、不要任何解释。`

const FOLD_SYSTEM = `你是小说编辑，需要把多章剧情摘要合并成一条「卷级摘要」。

要求：
- 300~500 字，按时间顺序紧凑叙述
- 保留主线推进、关键转折、人物关系变化与位置变动
- 所有【伏笔】标记必须原样保留
- 不要添加摘要之外的任何剧情
输出纯文本，不要标题、不要 JSON、不要任何解释。`

// ---------- 结构管理 ----------

function ensureMemory(project) {
  if (!project.memory || typeof project.memory !== 'object') project.memory = {}
  if (!project.memory.summaries || typeof project.memory.summaries !== 'object') project.memory.summaries = {}
  if (!Array.isArray(project.memory.volumes)) project.memory.volumes = []
  return project.memory
}

function getSummary(project, chapterId) {
  const s = ensureMemory(project).summaries[chapterId]
  return s && s.text ? s : null
}

function setSummary(project, chapterId, text, srcChars = 0) {
  const mem = ensureMemory(project)
  const t = (text || '').trim()
  if (!t) return null
  mem.summaries[chapterId] = { text: t, chars: t.length, srcChars: srcChars || 0, at: Date.now() }
  return mem.summaries[chapterId]
}

// 章节被删除时级联清理：删除其摘要；从卷中移除该章，卷内不足 2 章时解散（章摘要仍保留）
function removeChapter(project, chapterId) {
  const mem = ensureMemory(project)
  delete mem.summaries[chapterId]
  const kept = []
  for (const v of mem.volumes) {
    const ids = (v.chapterIds || []).filter(id => id !== chapterId)
    if (ids.length >= 2) { v.chapterIds = ids; kept.push(v) }
  }
  mem.volumes = kept
}

// 摘要覆盖率（只统计正文长度达标的章节）
function coverage(project) {
  const mem = ensureMemory(project)
  const withText = project.chapters.filter(c => (c.content || '').trim().length >= SUMMARY_MIN)
  const done = withText.filter(c => mem.summaries[c.id])
  return {
    total: withText.length,
    done: done.length,
    missing: withText.filter(c => !mem.summaries[c.id]).map(c => c.id)
  }
}

// 未被卷覆盖的章摘要（按章节顺序升序）
function unfoldedSummaries(project) {
  const mem = ensureMemory(project)
  const covered = new Set()
  for (const v of mem.volumes) for (const id of v.chapterIds || []) covered.add(id)
  return project.chapters
    .slice()
    .sort((a, b) => a.order - b.order)
    .filter(c => mem.summaries[c.id] && !covered.has(c.id))
    .map(c => ({ chapter: c, text: mem.summaries[c.id].text }))
}

// ---------- 上下文装配 ----------

// 生成「前情摘要」块：取当前章之前、近章窗口之外的旧章节，
// 若被卷覆盖用卷摘要，否则用章摘要；按新 → 旧填充预算，最后按时间正序拼装
function buildMemoryBlock(project, chapter, budget, recentN = 2) {
  const mem = ensureMemory(project)
  const empty = { text: '', used: [], dropped: 0, chars: 0 }
  if (budget <= 200) return empty

  const volumeOf = new Map()
  for (const v of mem.volumes) for (const id of v.chapterIds || []) volumeOf.set(id, v)

  const windowStart = chapter.order - recentN // 该 order 及以上属于近章窗口（用原文）
  const older = project.chapters
    .filter(c => c.order < windowStart)
    .sort((a, b) => b.order - a.order) // 新 → 旧

  const units = []
  const seenVol = new Set()
  for (const c of older) {
    const v = volumeOf.get(c.id)
    if (v) {
      if (seenVol.has(v.id)) continue
      seenVol.add(v.id)
      const members = (v.chapterIds || [])
        .map(id => project.chapters.find(x => x.id === id))
        .filter(Boolean)
        .sort((a, b) => a.order - b.order)
      if (members.length < 2) continue
      units.push({ type: 'volume', text: v.text, from: members[0].title, to: members[members.length - 1].title })
    } else {
      const s = mem.summaries[c.id]
      if (s && s.text) units.push({ type: 'chapter', text: s.text, title: c.title })
    }
  }

  const picked = []
  let total = 0
  let dropped = 0
  for (const u of units) {
    const header = u.type === 'volume' ? `【前情·${u.from} 至 ${u.to}】` : `【${u.title}·摘要】`
    const body = `${header}\n${u.text}`
    if (total + body.length > budget) {
      if (picked.length > 0) {
        // 预算不足：停止在缺口处（保持时间线连续），剩余全部计为丢弃
        dropped = units.length - picked.length
        break
      }
      // 连一条都放不下：截断首条（尽量保留最近的记忆）
      const cut = body.slice(0, Math.max(50, budget))
      picked.push({ body: cut, u, chars: cut.length, truncated: true })
      total += cut.length
      dropped = units.length - 1
      break
    }
    picked.push({ body, u, chars: body.length, truncated: false })
    total += body.length
  }
  if (!picked.length) return { ...empty, dropped }

  const ordered = picked.slice().reverse() // 旧 → 新
  const text = '# 前情回顾（较早剧情的压缩记忆，供衔接参考）\n\n' + ordered.map(p => p.body).join('\n\n')
  const used = ordered.map(p => ({
    type: p.u.type,
    title: p.u.type === 'volume' ? `${p.u.from} 至 ${p.u.to}` : p.u.title,
    chars: p.chars,
    truncated: p.truncated
  }))
  return { text, used, dropped, chars: text.length }
}

// ---------- 摘要生成 ----------

// 单章摘要（补建用）：一章一次调用
async function summarizeChapter(config, project, chapter, signal) {
  const text = (chapter.content || '').trim()
  if (text.length < SUMMARY_MIN) return ''
  const raw = await chatOnce(config, {
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `【章节】${chapter.title}\n\n【正文】\n${text}` }
    ],
    model: config.extractModel || config.model,
    temperature: 0.3,
    maxTokens: 800,
    signal
  })
  return (raw || '').trim()
}

// 折叠：把最旧的未折叠章摘要合并为一条卷摘要（自动按阈值触发；force 时折叠全部）
async function maybeFold(config, project, { force = false, signal } = {}) {
  const unfolded = unfoldedSummaries(project)
  if (unfolded.length < 2) return null
  if (!force && unfolded.length < FOLD_THRESHOLD) return null
  const batch = force ? unfolded : unfolded.slice(0, FOLD_THRESHOLD)

  const parts = batch.map(b => `【${b.chapter.title}】\n${b.text}`)
  const raw = await chatOnce(config, {
    messages: [
      { role: 'system', content: FOLD_SYSTEM },
      { role: 'user', content: parts.join('\n\n') }
    ],
    model: config.extractModel || config.model,
    temperature: 0.3,
    maxTokens: 1200,
    signal
  })
  const text = (raw || '').trim()
  if (!text) return null

  const mem = ensureMemory(project)
  const vol = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text,
    chars: text.length,
    chapterIds: batch.map(b => b.chapter.id),
    at: Date.now()
  }
  mem.volumes.push(vol)
  return { id: vol.id, count: batch.length, chars: text.length }
}

// ---------- 面板数据 ----------

function overview(project) {
  const mem = ensureMemory(project)
  const cov = coverage(project)
  const chapters = project.chapters
    .slice()
    .sort((a, b) => a.order - b.order)
    .map(c => {
      const s = mem.summaries[c.id] || null
      const cur = (c.content || '').length
      const stale = !!(s && s.srcChars && Math.abs(cur - s.srcChars) / Math.max(s.srcChars, 1) > 0.35)
      return {
        id: c.id, title: c.title, chars: cur,
        hasSummary: !!(s && s.text), summaryChars: s ? s.chars : 0,
        summary: s ? s.text : '', stale
      }
    })
  const volumes = mem.volumes.map(v => ({
    id: v.id, at: v.at, chars: (v.text || '').length,
    chapterCount: (v.chapterIds || []).length,
    titles: (v.chapterIds || []).map(id => (project.chapters.find(c => c.id === id) || {}).title).filter(Boolean),
    text: v.text || ''
  }))
  return {
    coverage: cov,
    chapters,
    volumes,
    unfoldedCount: unfoldedSummaries(project).length,
    foldThreshold: FOLD_THRESHOLD
  }
}

module.exports = {
  ensureMemory, getSummary, setSummary, removeChapter,
  coverage, unfoldedSummaries, buildMemoryBlock,
  summarizeChapter, maybeFold, overview,
  SUMMARY_RULE, SUMMARY_MIN, FOLD_THRESHOLD
}
