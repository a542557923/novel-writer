import React from 'react'

export default function Sidebar({
  projects, currentId, onSwitch, onCreate, onDelete,
  chapters, chapterId, onSelectChapter, onAddChapter, onDeleteChapter, onRenameChapter
}) {
  return (
    <nav className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-head">
          <span>作品</span>
          <button className="icon-btn" title="新建作品" onClick={onCreate}>＋</button>
        </div>
        <div className="project-list">
          {projects.map(p => (
            <div key={p.id} className={'project-item' + (p.id === currentId ? ' active' : '')}>
              <span className="project-name" title={p.name} onClick={() => onSwitch(p.id)}>{p.name}</span>
              <button className="icon-btn del" title="删除作品" onClick={() => onDelete(p.id)}>✕</button>
            </div>
          ))}
        </div>
      </div>
      <div className="sidebar-section grow">
        <div className="sidebar-head">
          <span>章节</span>
          <button className="icon-btn" title="新增章节" onClick={onAddChapter}>＋</button>
        </div>
        <div className="chapter-list">
          {chapters.map(c => (
            <div key={c.id} className={'chapter-item' + (c.id === chapterId ? ' active' : '')}>
              <span className="chapter-name" onClick={() => onSelectChapter(c.id)} title={c.title}>{c.title}</span>
              <button
                className="icon-btn del"
                title="删除章节"
                onClick={() => onDeleteChapter(c.id)}
              >✕</button>
            </div>
          ))}
        </div>
      </div>
    </nav>
  )
}
