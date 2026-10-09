// ST 式提示词组装器 —— 顺序：System → WI-Before → Story Bible → 常驻/Pinned → WI-After → 正文上下文（作者注按深度插入）→ 指令
// 共享纯函数在 context.js；酒馆预设模式见 preset.js（分流在 routes.js）
const ctx = require('./context')
const { entryHit, buildContext, formatSection, buildContextText, scanWorldbook, injectAuthorNote, MODE_INSTRUCTION } = ctx

const DEFAULT_SYSTEM_PROMPT = `你是一位技艺精湛的小说作家，负责续写与创作小说正文。

写作要求：
1. 直接输出小说正文，禁止输出任何解释、标题、大纲、要点或元信息
2. 保持既定的文风、叙事人称与叙事节奏，与前文无缝衔接
3. 严格遵守设定资料中的人物性格、人物关系与世界观，不得自相矛盾
4. 出场人物的行为须符合其动机与性格逻辑
5. 多用场景细节、动作与对话推进情节，避免流水账式概述
6. 段落收尾留下自然的叙事余韵，便于后续继续续写`

function buildPrompt({ project, chapter, mode = 'continue', selection = '', instruction = '' }) {
  const settings = project.settings
  const sysPrompt = settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT

  // ---- 上下文 ----
  const { contextText, breakdown } = buildContextText({ project, chapter, mode, selection })

  // ---- 世界书扫描 ----
  const { pinned, wiBefore, wiAfter, scanWindow } = scanWorldbook(project, contextText)

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
      scanWindow,
      contextBreakdown: breakdown
    }
  }
}

module.exports = { buildPrompt, DEFAULT_SYSTEM_PROMPT, entryHit, buildContext }
