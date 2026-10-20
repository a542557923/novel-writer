// OpenAI 兼容 Chat Completions 客户端（流式 + 非流式）
// 采样参数（temperature / max_tokens）一律不传，交由服务端使用默认值
function apiUrl(baseUrl, path = '/chat/completions') {
  const base = (baseUrl || '').replace(/\/+$/, '')
  return base + path
}

async function request(config, { messages, model, stream, signal }) {
  const useModel = model || config.model
  if (!config.baseUrl || !config.apiKey) {
    throw new Error('未配置 AI 接口：请在「设置」中填写 API 地址与密钥')
  }
  if (!useModel) throw new Error('未配置模型名称：请在「设置」中填写模型')

  const res = await fetch(apiUrl(config.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.apiKey },
    body: JSON.stringify({
      model: useModel,
      messages,
      stream: !!stream
    }),
    signal
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 500) } catch {}
    throw new Error(`API 请求失败 HTTP ${res.status}: ${detail || res.statusText}`)
  }
  return res
}

// 流式：逐 chunk 回调，返回完整文本
async function chatStream(config, { messages, model, onChunk, signal }) {
  const res = await request(config, { messages, model, stream: true, signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let full = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const payload = s.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const obj = JSON.parse(payload)
        const delta = obj.choices?.[0]?.delta?.content
        if (delta) {
          full += delta
          if (onChunk) onChunk(delta)
        }
      } catch {}
    }
  }
  return full
}

// 非流式：返回完整文本（抽取、摘要等结构化任务用）
async function chatOnce(config, { messages, model, signal }) {
  const res = await request(config, { messages, model, stream: false, signal })
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new Error('API 返回格式异常：未取到 message.content')
  return text
}

// 拉取服务端可用模型列表（OpenAI 兼容 /models）
async function listModels({ baseUrl, apiKey }) {
  if (!baseUrl) throw new Error('请先填写 API 地址')
  if (!apiKey) throw new Error('请先填写 API Key')
  const res = await fetch(apiUrl(baseUrl, '/models'), {
    headers: { 'Authorization': 'Bearer ' + apiKey }
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 300) } catch {}
    throw new Error(`HTTP ${res.status}${detail ? ' · ' + detail : ''}`)
  }
  const data = await res.json().catch(() => null)
  const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []
  const ids = arr
    .map(m => (typeof m === 'string' ? m : m?.id || m?.name))
    .filter(Boolean)
    .map(String)
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

module.exports = { chatStream, chatOnce, listModels }
