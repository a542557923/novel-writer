// 实体自动抽取：从新生成的正文中提取人物/物品/地点/组织/设定，入库并更新已有条目
const { chatOnce } = require('./llm')

const EXTRACT_SYSTEM = `你是小说设定数据库管理员，负责从新写的小说正文中提取值得长期记住的设定实体。

提取标准（宁缺毋滥，一次性元素不要提取）：
- character 人物：有名字或固定称呼、与主角有互动、后续可能再出场（无名一次性路人忽略）
- item 物品：有名字或具有特殊性、影响剧情的物品（武器、信物、法宝、关键道具等）
- location 地点：被命名的、可能再次出现的场所
- organization 组织：被命名的势力、门派、家族、公司、机构
- lore 设定：正文确立的重要世界观规则、伏笔、约定、秘密、悬案

对已有实体：仅提取重大新信息（性格揭示、关系变化、受伤/死亡、获得或失去重要物品、身份揭示等），日常动作不算新信息。

content 用第三人称客观陈述，40~100 字，写清身份、外观特征、与主角关系、关键属性等后续写作需要的信息。

严格输出 JSON，不要输出任何其他文字、不要用代码块包裹：
{"new":[{"type":"character|item|location|organization|lore","name":"实体名","aliases":["别名或称呼"],"content":"设定描述"}],"updates":[{"name":"已有实体名","addition":"新信息，一到两句"}]}
若无任何值得提取的内容，输出 {"new":[],"updates":[]}`

function parseJsonLoose(text) {
  if (!text) return null
  let t = text.trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try { return JSON.parse(t.slice(s, e + 1)) } catch { return null }
}

async function extract(config, project, text, signal) {
  const existing = project.worldbook
    .filter(e => e.enabled)
    .map(e => `${e.name}（${e.type}）`)
    .join('、') || '（暂无）'
  const messages = [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: `【已有实体名单】\n${existing}\n\n【新写的正文】\n${text}` }
  ]
  const raw = await chatOnce(config, {
    messages,
    model: config.extractModel || config.model,
    temperature: 0.2,
    maxTokens: 1500,
    signal
  })
  return parseJsonLoose(raw)
}

// 把抽取结果写入世界书，返回变更摘要
function applyExtraction(project, result) {
  const added = []
  const updated = []
  if (!result || typeof result !== 'object') return { added, updated, skipped: 0 }
  const news = Array.isArray(result.new) ? result.new : []
  const ups = Array.isArray(result.updates) ? result.updates : []
  let skipped = 0

  for (const n of news) {
    const name = (n?.name || '').trim()
    if (!name || !n.content?.trim()) { skipped++; continue }
    const dup = project.worldbook.find(e =>
      e.name === name || e.aliases?.includes(name) ||
      (n.aliases || []).some(a => a && (e.name === a || e.aliases?.includes(a)))
    )
    if (dup) { skipped++; continue }
    project.worldbook.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: ['character', 'item', 'location', 'organization', 'lore'].includes(n.type) ? n.type : 'lore',
      name,
      aliases: (Array.isArray(n.aliases) ? n.aliases : []).map(a => String(a).trim()).filter(Boolean),
      content: n.content.trim(),
      keywords: [],
      enabled: true,
      pinned: false,
      position: 'after',
      priority: 100,
      auto: true,
      mentions: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    added.push({ name, type: n.type })
  }

  for (const u of ups) {
    const name = (u?.name || '').trim()
    const addition = (u?.addition || '').trim()
    if (!name || !addition) continue
    const entry = project.worldbook.find(e => e.name === name || e.aliases?.includes(name))
    if (!entry) continue
    if (entry.content.includes(addition)) continue
    entry.content = (entry.content + '\n' + addition).trim()
    entry.updatedAt = Date.now()
    updated.push({ name, addition })
  }
  return { added, updated, skipped }
}

module.exports = { extract, applyExtraction, parseJsonLoose }
