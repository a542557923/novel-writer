import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import Sidebar from './components/Sidebar.jsx'
import Editor from './components/Editor.jsx'
import WorldBook from './components/WorldBook.jsx'
import PresetPanel from './components/PresetPanel.jsx'
import PreviewPanel from './components/PreviewPanel.jsx'
import SettingsPanel from './components/SettingsPanel.jsx'

export default function App() {
  const [projects, setProjects] = useState([])
  const [project, setProject] = useState(null)
  const [chapterId, setChapterId] = useState(null)
  const [tab, setTab] = useState('worldbook')
  const [toastMsg, setToastMsg] = useState(null)
  const [configOk, setConfigOk] = useState(true)
  const [loaded, setLoaded] = useState(false)

  const toast = useCallback((msg) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(m => (m === msg ? null : m)), 3500)
  }, [])

  const refreshProjects = useCallback(async () => {
    const list = await api.listProjects()
    setProjects(list)
    return list
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const cfg = await api.getConfig()
        setConfigOk(!!(cfg.baseUrl && cfg.apiKey && cfg.model))
        const list = await refreshProjects()
        if (list.length) await loadProject(list[0].id)
      } catch (e) {
        toast('初始化失败: ' + e.message)
      } finally {
        setLoaded(true)
      }
    })()
  }, [])

  const loadProject = async (id) => {
    const p = await api.getProject(id)
    setProject(p)
    setChapterId(p.chapters[0]?.id || null)
    if (p.chapters.length === 0) setTab('settings')
  }

  const chapter = project?.chapters.find(c => c.id === chapterId) || null

  // 编辑器内容更新：本地即时更新 + 防抖持久化
  const saveTimers = useRef({})
  const updateContent = useCallback((cid, content) => {
    setProject(p => (p ? { ...p, chapters: p.chapters.map(c => (c.id === cid ? { ...c, content } : c)) } : p))
    clearTimeout(saveTimers.current[cid])
    saveTimers.current[cid] = setTimeout(() => {
      api.updateChapter(project.id, cid, { content }).catch(e => toast('保存失败: ' + e.message))
    }, 700)
  }, [project?.id])

  const addChapter = async () => {
    const c = await api.addChapter(project.id, `第${project.chapters.length + 1}章`)
    setProject(p => ({ ...p, chapters: [...p.chapters, c] }))
    setChapterId(c.id)
  }

  const deleteChapter = async (cid) => {
    if (!confirm('删除该章节？此操作不可恢复。')) return
    await api.deleteChapter(project.id, cid)
    const chapters = project.chapters.filter(c => c.id !== cid)
    setProject(p => ({ ...p, chapters }))
    if (cid === chapterId) setChapterId(chapters[0]?.id || null)
  }

  const renameChapter = async (cid, title) => {
    setProject(p => ({ ...p, chapters: p.chapters.map(c => (c.id === cid ? { ...c, title } : c)) }))
    await api.updateChapter(project.id, cid, { title }).catch(() => {})
  }

  // 世界书变更后本地同步
  const patchProject = useCallback((fn) => {
    setProject(p => (p ? fn(p) : p))
  }, [])

  const refreshProjectView = useCallback(async () => {
    try {
      const fresh = await api.getProject(project.id)
      setProject(prev => (prev ? { ...fresh, chapters: prev.chapters } : fresh))
    } catch {}
  }, [project?.id])

  const createProject = async (name) => {
    const p = await api.createProject(name)
    await refreshProjects()
    await loadProject(p.id)
    toast('已创建新作品，先到「设置」完善大纲与 AI 配置')
  }

  const switchProject = async (id) => {
    await loadProject(id)
  }

  const deleteProject = async (id) => {
    if (!confirm('删除整部作品（含章节与世界书）？不可恢复。')) return
    await api.deleteProject(id)
    const list = await refreshProjects()
    if (project?.id === id) {
      if (list.length) await loadProject(list[0].id)
      else { setProject(null); setChapterId(null) }
    }
  }

  const saveSettings = async (settings) => {
    const updated = await api.updateProject(project.id, { settings })
    setProject(p => ({ ...p, settings: updated.settings }))
    toast('本书设置已保存')
  }

  const saveConfig = async (patch) => {
    const cfg = await api.saveConfig(patch)
    setConfigOk(!!(cfg.baseUrl && cfg.model))
    toast('AI 配置已保存')
    return cfg
  }

  if (!loaded) return <div className="loading">加载中…</div>

  if (!project) {
    return (
      <div className="empty-state">
        <h1>AI 小说写作台</h1>
        <p>世界书随写作自动生长的轻量小说工具</p>
        <NewProjectForm onCreate={createProject} />
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <span className="logo">✒</span>
          <span className="book-name">{project.name}</span>
          <span className="book-meta">{project.chapters.length} 章 · 世界书 {project.worldbook.length} 条</span>
        </div>
        {!configOk && (
          <button className="warn-chip" onClick={() => setTab('settings')}>未配置 AI 接口，点击设置</button>
        )}
      </header>
      <div className="layout">
        <Sidebar
          projects={projects}
          currentId={project.id}
          onSwitch={switchProject}
          onCreate={() => { const name = prompt('新作品名称'); if (name) createProject(name.trim()) }}
          onDelete={deleteProject}
          chapters={project.chapters}
          chapterId={chapterId}
          onSelectChapter={setChapterId}
          onAddChapter={addChapter}
          onDeleteChapter={deleteChapter}
          onRenameChapter={renameChapter}
        />
        <Editor
          project={project}
          chapter={chapter}
          onContent={(content) => chapter && updateContent(chapter.id, content)}
          toast={toast}
          onWorldbookChanged={() => refreshProjectView()}
        />
        <aside className="right-panel">
          <div className="tabs">
            {[['worldbook', '世界书'], ['preset', '预设'], ['preview', '注入预览'], ['settings', '设置']].map(([k, label]) => (
              <button key={k} className={'tab' + (tab === k ? ' active' : '')} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
          {tab === 'worldbook' && (
            <WorldBook project={project} onPatch={patchProject} toast={toast} />
          )}
          {tab === 'preset' && (
            <PresetPanel project={project} onPatch={patchProject} toast={toast} />
          )}
          {tab === 'preview' && (
            <PreviewPanel project={project} chapterId={chapterId} />
          )}
          {tab === 'settings' && (
            <SettingsPanel
              project={project}
              onSaveSettings={saveSettings}
              onSaveConfig={saveConfig}
            />
          )}
        </aside>
      </div>
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  )
}

function NewProjectForm({ onCreate }) {
  const [name, setName] = useState('')
  return (
    <div className="new-project">
      <input
        placeholder="作品名称，如《星海旧事》"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && name.trim() && onCreate(name.trim())}
      />
      <button className="btn primary" disabled={!name.trim()} onClick={() => onCreate(name.trim())}>开始创作</button>
    </div>
  )
}
