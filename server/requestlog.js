// 发送记录：保存每次实际发送给模型的完整消息，便于检查发送内容与压缩情况
// 存储：data/requests/<projectId>.json（每项目保留最近 MAX_RECORDS 条）
const fs = require('fs')
const path = require('path')

const DIR = path.join(__dirname, '..', 'data', 'requests')
const MAX_RECORDS = 20     // 每项目保留条数
const MAX_MSG_CHARS = 60000 // 单条消息存储上限，防极端膨胀
const MAX_RESP_CHARS = 8000 // 返回原文存储上限

const cache = new Map()
const writeTimers = new Map()

function fileOf(pid) { return path.join(DIR, pid + '.json') }

function load(pid) {
  if (!cache.has(pid)) {
    let list = []
    try { list = JSON.parse(fs.readFileSync(fileOf(pid), 'utf8')) || [] } catch {}
    cache.set(pid, Array.isArray(list) ? list : [])
  }
  return cache.get(pid)
}

function scheduleWrite(pid) {
  clearTimeout(writeTimers.get(pid))
  writeTimers.set(pid, setTimeout(() => {
    writeTimers.delete(pid)
    try {
      fs.mkdirSync(DIR, { recursive: true })
      fs.writeFileSync(fileOf(pid), JSON.stringify(cache.get(pid) || []))
    } catch {}
  }, 400))
}

// 记录一次发送，返回记录 id（后续可 update 补全状态）
function record(pid, rec) {
  const list = load(pid)
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  list.unshift({
    id,
    time: Date.now(),
    kind: rec.kind || 'generate',
    mode: rec.mode || '',
    model: rec.model || '',
    status: rec.status || 'done',
    messages: (rec.messages || []).map(m => ({
      role: m.role,
      chars: (m.content || '').length,
      content: String(m.content || '').slice(0, MAX_MSG_CHARS)
    })),
    stats: rec.stats || null,
    detail: rec.detail || null,
    response: rec.response != null ? String(rec.response).slice(0, MAX_RESP_CHARS) : null
  })
  if (list.length > MAX_RECORDS) list.length = MAX_RECORDS
  scheduleWrite(pid)
  return id
}

function update(pid, id, patch) {
  const e = load(pid).find(x => x.id === id)
  if (e) { Object.assign(e, patch); scheduleWrite(pid) }
}

// 列表视图：不返回消息正文，只给概要
function list(pid) {
  return load(pid).map(r => ({
    id: r.id,
    time: r.time,
    kind: r.kind,
    mode: r.mode,
    model: r.model,
    status: r.status,
    messageCount: r.messages.length,
    totalChars: r.messages.reduce((s, m) => s + (m.chars || 0), 0),
    detail: r.detail || null
  }))
}

function get(pid, id) {
  return load(pid).find(x => x.id === id) || null
}

module.exports = { record, update, list, get }
