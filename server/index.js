// 入口：加载存储 → 挂 API → 服务前端构建产物
const express = require('express')
const path = require('path')
const fs = require('fs')
const store = require('./store')
const routes = require('./routes')

store.load()

const app = express()
app.use(express.json({ limit: '5mb' }))
app.use('/api', routes)

const DIST = path.join(__dirname, '..', 'dist')
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(path.join(DIST, 'index.html'))
  })
}
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }))

const PORT = process.env.PORT || 3210
app.listen(PORT, () => {
  console.log(`Novel Writer 已启动: http://localhost:${PORT}`)
})
