// 轻量 JSON 文件存储：内存为真，防抖落盘
// data/config.json          全局配置（AI 连接等）
// data/projects/<id>.json   每本书完整数据（设定 + 章节 + 世界书）
// data/presets/<id>.json    全局酒馆预设库（SillyTavern 预设）
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const presetMod = require('./preset')

const DATA_DIR = path.join(__dirname, '..', 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const PROJECTS_DIR = path.join(DATA_DIR, 'projects')
const PRESETS_DIR = path.join(DATA_DIR, 'presets')

const DEFAULT_CONFIG = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  extractModel: '', // 留空则抽取复用主模型
  temperature: 0.8,
  maxTokens: 2000
}

const DEFAULT_SETTINGS = {
  systemPrompt: '',
  storyBible: '',
  authorNote: '',
  authorNoteDepth: 1, // 插入到上下文倒数第 N 段之前
  contextChars: 12000,
  scanChars: 4000,
  recentChapters: 2, // 近 N 章使用原文注入；更早章节使用摘要
  autoExtract: true, // 生成后自动整理（世界书抽取 + 章节摘要，合并为一次请求）
  thriftyMode: false, // 省流模式：关闭全部后台任务，每次生成仅 1 次请求（公益站友好）
  presetId: '', // 绑定的全局酒馆预设；空 = 不使用
  presetCharName: '', // 预设 {{char}} 的本书映射
  presetUserName: '' // 预设 {{user}} 的本书映射
}

const config = { ...DEFAULT_CONFIG }
const projects = new Map() // id -> project
const presets = new Map() // id -> preset
const saveTimers = new Map() // id -> timer

function uid() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex')
}

function cnNum(n) {
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (n <= 0) return d[0]
  if (n < 10) return d[n]
  if (n === 10) return '十'
  if (n < 20) return '十' + d[n % 10]
  if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '')
  return String(n)
}

function chapterTitle(index) {
  return `第${cnNum(index + 1)}章`
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function ensureDirs() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true })
  fs.mkdirSync(PRESETS_DIR, { recursive: true })
}

function load() {
  ensureDirs()
  const saved = readJson(CONFIG_FILE, null)
  if (saved) Object.assign(config, saved)
  for (const f of fs.readdirSync(PRESETS_DIR)) {
    if (!f.endsWith('.json')) continue
    const ps = presetMod.normalizePreset(readJson(path.join(PRESETS_DIR, f), null))
    if (ps && ps.id) presets.set(ps.id, ps)
  }
  for (const f of fs.readdirSync(PROJECTS_DIR)) {
    if (!f.endsWith('.json')) continue
    const p = readJson(path.join(PROJECTS_DIR, f), null)
    if (p && p.id) {
      p.settings = { ...DEFAULT_SETTINGS, ...(p.settings || {}) }
      p.chapters = p.chapters || []
      p.worldbook = p.worldbook || []
      // 分层记忆结构（v1.0 新增）
      if (!p.memory || typeof p.memory !== 'object') p.memory = {}
      if (!p.memory.summaries || typeof p.memory.summaries !== 'object') p.memory.summaries = {}
      if (!Array.isArray(p.memory.volumes)) p.memory.volumes = []
      projects.set(p.id, p)
    }
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

function projectFile(id) {
  return path.join(PROJECTS_DIR, id + '.json')
}

function saveProjectNow(id) {
  const p = projects.get(id)
  if (!p) return
  ensureDirs()
  fs.writeFileSync(projectFile(id), JSON.stringify(p, null, 2))
}

function queueSaveProject(id) {
  clearTimeout(saveTimers.get(id))
  saveTimers.set(id, setTimeout(() => {
    saveTimers.delete(id)
    saveProjectNow(id)
  }, 300))
}

function getConfig() {
  return { ...config, apiKey: config.apiKey ? '●'.repeat(8) : '' }
}

function updateConfig(patch) {
  // apiKey 传掩码或空值时保留原值
  const { apiKey, ...rest } = patch || {}
  Object.assign(config, rest)
  if (apiKey && !/^[●]+$/.test(apiKey)) config.apiKey = apiKey
  if (apiKey === '') config.apiKey = ''
  saveConfig()
  return getConfig()
}

function listProjects() {
  return [...projects.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(p => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      chapterCount: p.chapters.length,
      worldbookCount: p.worldbook.length,
      totalChars: p.chapters.reduce((s, c) => s + (c.content || '').length, 0)
    }))
}

function getProject(id) {
  return projects.get(id) || null
}

function createProject(name) {
  const p = {
    id: uid(),
    name: name || '未命名作品',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings: { ...DEFAULT_SETTINGS },
    chapters: [{ id: uid(), title: chapterTitle(0), content: '', order: 0, createdAt: Date.now(), updatedAt: Date.now() }],
    worldbook: [],
    memory: { summaries: {}, volumes: [] }
  }
  projects.set(p.id, p)
  saveProjectNow(p.id)
  return p
}

function deleteProject(id) {
  clearTimeout(saveTimers.get(id))
  saveTimers.delete(id)
  projects.delete(id)
  try { fs.unlinkSync(projectFile(id)) } catch {}
}

function touch(p) {
  p.updatedAt = Date.now()
  queueSaveProject(p.id)
}

// ---------- 章节 ----------
function findChapter(p, cid) {
  return p.chapters.find(c => c.id === cid) || null
}

function addChapter(p, title) {
  const c = {
    id: uid(),
    title: title || chapterTitle(p.chapters.length),
    content: '',
    order: p.chapters.length,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  p.chapters.push(c)
  touch(p)
  return c
}

function updateChapter(p, cid, patch) {
  const c = findChapter(p, cid)
  if (!c) return null
  if (patch.title !== undefined) c.title = patch.title
  if (patch.content !== undefined) c.content = patch.content
  c.updatedAt = Date.now()
  touch(p)
  return c
}

function deleteChapter(p, cid) {
  p.chapters = p.chapters.filter(c => c.id !== cid)
  p.chapters.forEach((c, i) => { c.order = i })
  // 级联清理分层记忆：删除该章摘要；从卷中移除，卷内不足 2 章时解散（章摘要保留可溯源）
  if (p.memory && typeof p.memory === 'object') {
    if (p.memory.summaries) delete p.memory.summaries[cid]
    if (Array.isArray(p.memory.volumes)) {
      p.memory.volumes = p.memory.volumes.filter(v => {
        v.chapterIds = (Array.isArray(v.chapterIds) ? v.chapterIds : []).filter(id => id !== cid)
        return v.chapterIds.length >= 2
      })
    }
  }
  touch(p)
}

// ---------- 世界书 ----------
function normalizeEntry(e) {
  return {
    id: e.id || uid(),
    type: ['character', 'item', 'location', 'organization', 'lore', 'other'].includes(e.type) ? e.type : 'other',
    name: (e.name || '').trim(),
    aliases: Array.isArray(e.aliases) ? e.aliases.filter(Boolean) : [],
    content: e.content || '',
    keywords: Array.isArray(e.keywords) ? e.keywords.filter(Boolean) : [],
    enabled: e.enabled !== false,
    pinned: !!e.pinned,
    position: e.position === 'before' ? 'before' : 'after',
    priority: Number.isFinite(+e.priority) ? +e.priority : 100,
    auto: !!e.auto,
    mentions: e.mentions || 0,
    createdAt: e.createdAt || Date.now(),
    updatedAt: Date.now()
  }
}

function addEntry(p, entry) {
  const e = normalizeEntry({ ...entry, id: undefined })
  if (!e.name) return null
  p.worldbook.push(e)
  touch(p)
  return e
}

function updateEntry(p, eid, patch) {
  const i = p.worldbook.findIndex(e => e.id === eid)
  if (i < 0) return null
  const merged = normalizeEntry({ ...p.worldbook[i], ...patch, id: p.worldbook[i].id, createdAt: p.worldbook[i].createdAt })
  p.worldbook[i] = merged
  touch(p)
  return merged
}

function deleteEntry(p, eid) {
  p.worldbook = p.worldbook.filter(e => e.id !== eid)
  touch(p)
}

function rawConfig() {
  return config
}

// ---------- 酒馆预设库（全局） ----------
function presetFile(id) {
  return path.join(PRESETS_DIR, id + '.json')
}

function savePresetNow(ps) {
  ensureDirs()
  fs.writeFileSync(presetFile(ps.id), JSON.stringify(ps, null, 2))
}

function listPresets() {
  return [...presets.values()]
    .sort((a, b) => b.importedAt - a.importedAt)
    .map(ps => ({ id: ps.id, name: ps.name, promptCount: ps.prompts.length, importedAt: ps.importedAt }))
}

function getPreset(id) {
  return presets.get(id) || null
}

function createPreset(raw, name) {
  const ps = presetMod.parsePreset(raw)
  ps.id = uid()
  if (name && String(name).trim()) ps.name = String(name).trim()
  presets.set(ps.id, ps)
  savePresetNow(ps)
  return ps
}

function updatePreset(id, patch) {
  const ps = presets.get(id)
  if (!ps) return null
  const { prompts, name, cleanOutput } = patch || {}
  if (name !== undefined && String(name).trim()) ps.name = String(name).trim()
  if (cleanOutput !== undefined) ps.cleanOutput = !!cleanOutput
  for (const u of Array.isArray(prompts) ? prompts : []) {
    if (!u || typeof u.identifier !== 'string') continue
    const t = ps.prompts.find(x => x.identifier === u.identifier)
    if (!t) continue
    if (u.enabled !== undefined) t.enabled = !!u.enabled
    if (u.content !== undefined) t.content = String(u.content)
  }
  savePresetNow(ps)
  return ps
}

function deletePreset(id) {
  presets.delete(id)
  try { fs.unlinkSync(presetFile(id)) } catch {}
}

module.exports = {
  load, saveConfig, getConfig, rawConfig, updateConfig,
  listProjects, getProject, createProject, deleteProject,
  findChapter, addChapter, updateChapter, deleteChapter,
  addEntry, updateEntry, deleteEntry, normalizeEntry, touch,
  listPresets, getPreset, createPreset, updatePreset, deletePreset
}
