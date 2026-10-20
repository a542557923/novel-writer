// REST API 封装
async function j(r) {
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {})
}).then(j)

export const api = {
  getConfig: () => fetch('/api/config').then(j),
  saveConfig: (patch) => fetch('/api/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
  }).then(j),
  listModels: (body) => post('/api/models', body),

  listProjects: () => fetch('/api/projects').then(j),
  getProject: (id) => fetch(`/api/projects/${id}`).then(j),
  createProject: (name) => post('/api/projects', { name }),
  updateProject: (id, patch) => fetch(`/api/projects/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
  }).then(j),
  deleteProject: (id) => fetch(`/api/projects/${id}`, { method: 'DELETE' }).then(j),

  addChapter: (id, title) => post(`/api/projects/${id}/chapters`, { title }),
  updateChapter: (id, cid, patch) => fetch(`/api/projects/${id}/chapters/${cid}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
  }).then(j),
  deleteChapter: (id, cid) => fetch(`/api/projects/${id}/chapters/${cid}`, { method: 'DELETE' }).then(j),

  addEntry: (id, entry) => post(`/api/projects/${id}/worldbook`, entry),
  updateEntry: (id, eid, patch) => fetch(`/api/projects/${id}/worldbook/${eid}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
  }).then(j),
  deleteEntry: (id, eid) => fetch(`/api/projects/${id}/worldbook/${eid}`, { method: 'DELETE' }).then(j),

  preview: (id, body) => post(`/api/projects/${id}/preview`, body),
  extract: (id, body) => post(`/api/projects/${id}/extract`, body),

  getMemory: (id) => fetch(`/api/projects/${id}/memory`).then(j),
  rebuildMemory: (id) => post(`/api/projects/${id}/memory/rebuild`, {}),
  foldMemory: (id) => post(`/api/projects/${id}/memory/fold`, {}),

  listRequests: (id) => fetch(`/api/projects/${id}/requests`).then(j),
  getRequest: (id, rid) => fetch(`/api/projects/${id}/requests/${rid}`).then(j),

  listPresets: () => fetch('/api/presets').then(j),
  getPreset: (pid) => fetch(`/api/presets/${pid}`).then(j),
  importPreset: (raw, name) => post('/api/presets', { name, data: raw }),
  updatePreset: (pid, patch) => fetch(`/api/presets/${pid}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
  }).then(j),
  deletePreset: (pid) => fetch(`/api/presets/${pid}`, { method: 'DELETE' }).then(j)
}

// SSE 生成流：返回 abort 函数
export function streamGenerate(projectId, body, handlers) {
  const controller = new AbortController()
  ;(async () => {
    let res
    try {
      res = await fetch(`/api/projects/${projectId}/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal
      })
    } catch (e) {
      if (!controller.signal.aborted) handlers.onError?.(e.message)
      return
    }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      handlers.onError?.(d.error || `HTTP ${res.status}`)
      return
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const dispatch = (block) => {
      const ev = /event:\s*(.+)/.exec(block)?.[1]?.trim()
      const dataLine = block.split('\n').find(l => l.startsWith('data:'))
      let data = {}
      if (dataLine) { try { data = JSON.parse(dataLine.slice(5)) } catch {} }
      if (ev === 'chunk') handlers.onChunk?.(data.text)
      else if (ev === 'meta') handlers.onMeta?.(data)
      else if (ev === 'done') handlers.onDone?.(data)
      else if (ev === 'postprocess-queued') handlers.onPostprocessQueued?.(data)
      else if (ev === 'extract-start') handlers.onExtractStart?.()
      else if (ev === 'extract') handlers.onExtract?.(data)
      else if (ev === 'extract-error') handlers.onExtractError?.(data)
      else if (ev === 'error') handlers.onError?.(data.message, data.aborted)
    }
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          if (block.trim()) dispatch(block)
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) handlers.onError?.(e.message)
    }
    handlers.onEnd?.()
  })()
  return () => controller.abort()
}
