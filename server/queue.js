// 后台任务串行队列（公益站友好）
// 设计约束：
//  - 任意时刻至多一个后台 LLM 任务在执行（绝不并发）
//  - 每个任务自带延迟（避免与上一条请求过密）
//  - 两次后台调用之间保持最小间隔
//  - 用户正在生成正文时后台任务让路（轮询等待，设上限防饿死）
//  - 同 key 的待执行任务自动合并（例如同一章节的多次整理，只跑一次）
const MIN_INTERVAL_MS = 2500   // 两次后台调用之间的最小间隔
const WAIT_GEN_POLL_MS = 1500  // 生成期间让路的轮询间隔
const WAIT_GEN_MAX_MS = 120000 // 让路最长等待时间，超时后照常执行

const jobs = []            // 待执行任务（FIFO）
const jobByKey = new Map() // key -> job
let running = false
let activeGenerations = 0
let lastCallAt = 0

const sleep = ms => new Promise(r => setTimeout(r, ms))

function beginGeneration() { activeGenerations++ }
function endGeneration() { activeGenerations = Math.max(0, activeGenerations - 1) }
function isGenerating() { return activeGenerations > 0 }

// 入队：key 相同且尚未执行的任务会被合并（mergePayload 负责合并 payload）
// executor 为异步函数，接收 payload，返回结果；enqueue 返回其 Promise
function enqueue({ key = null, delayMs = 3000, payload = null, mergePayload = null, executor }) {
  if (key && jobByKey.has(key)) {
    const job = jobByKey.get(key)
    if (mergePayload) job.payload = mergePayload(job.payload, payload)
    return job.promise
  }
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  const job = { key, delayMs, payload, executor, resolve, reject, promise, notBefore: Date.now() + delayMs }
  if (key) jobByKey.set(key, job)
  jobs.push(job)
  pump()
  return promise
}

async function pump() {
  if (running) return
  running = true
  try {
    while (jobs.length) {
      const job = jobs[0]
      // 1) 任务自身延迟 + 与上次后台调用保持最小间隔
      const wait = Math.max(job.notBefore - Date.now(), lastCallAt + MIN_INTERVAL_MS - Date.now())
      if (wait > 0) await sleep(wait)
      // 2) 用户正在生成正文时让路（有上限，避免持续写作导致后台任务永远排不上）
      const t0 = Date.now()
      while (isGenerating() && Date.now() - t0 < WAIT_GEN_MAX_MS) await sleep(WAIT_GEN_POLL_MS)
      jobs.shift()
      if (job.key) jobByKey.delete(job.key)
      lastCallAt = Date.now()
      try {
        const result = await job.executor(job.payload)
        job.resolve(result)
      } catch (e) {
        job.reject(e)
      }
      lastCallAt = Date.now()
    }
  } finally {
    running = false
    if (jobs.length) pump() // 防御竞态
  }
}

function status() {
  return {
    pending: jobs.length,
    running,
    generating: isGenerating(),
    lastCallAt: lastCallAt || null
  }
}

module.exports = { enqueue, beginGeneration, endGeneration, isGenerating, status }
