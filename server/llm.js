// OpenAI 兼容 Chat Completions 客户端（流式 + 非流式）
function apiUrl(baseUrl) {
  const base = (baseUrl || '').replace(/\/+$/, '')
  return base + '/chat/completions'
}

async function request(config, { messages, model, temperature, maxTokens, stream, signal }) {
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
      temperature: temperature ?? config.temperature,
      max_tokens: maxTokens ?? config.maxTokens,
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
async function chatStream(config, { messages, model, temperature, maxTokens, onChunk, signal }) {
  const res = await request(config, { messages, model, temperature, maxTokens, stream: true, signal })
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

// 非流式：返回完整文本（抽取等结构化任务用）
async function chatOnce(config, { messages, model, temperature, maxTokens, signal }) {
  const res = await request(config, { messages, model, temperature, maxTokens, stream: false, signal })
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new Error('API 返回格式异常：未取到 message.content')
  return text
}

module.exports = { chatStream, chatOnce }
