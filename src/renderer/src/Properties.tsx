import { useEffect, useState } from 'react'
import type { ImagePropertiesViewState, ResultVersion } from '../../shared/contracts'

const ACTION_LABEL = {
  capture: '选区截图',
  initial: '首次生成',
  reconfigure: '重新配置',
  continue_edit: '继续编辑',
  regenerate: '重新生成',
  upscale: '放大 / 改尺寸',
  refine: '精细处理',
  cutout: '抠图'
} as const

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function versionDimensions(version: ResultVersion): string {
  return version.width && version.height ? `${version.width} × ${version.height} px` : '未知'
}

export function Properties(): React.JSX.Element {
  const initialId = new URLSearchParams(window.location.search).get('jobId') ?? ''
  const [jobId, setJobId] = useState(initialId)
  const [state, setState] = useState<ImagePropertiesViewState>()
  const [selectedVersionId, setSelectedVersionId] = useState<string>()
  const [notice, setNotice] = useState('')
  const [applying, setApplying] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => window.artCreator.preview.onPropertiesJobChanged((id) => {
    setSelectedVersionId(undefined)
    setJobId(id)
  }), [])

  useEffect(() => {
    let active = true

    async function refresh(): Promise<void> {
      const value = await window.artCreator.preview.getProperties(jobId)
      if (active) setState(value)
    }

    void refresh()
    const removeListener = window.artCreator.jobs.onChanged((job) => {
      if (job.id === jobId) void refresh()
    })
    return () => {
      active = false
      removeListener()
    }
  }, [jobId])

  const effectiveVersionId = selectedVersionId && state?.versions.some((version) => version.id === selectedVersionId)
    ? selectedVersionId
    : state?.currentVersionId ?? state?.versions.at(-1)?.id
  const selectedIndex = state?.versions.findIndex((version) => version.id === effectiveVersionId) ?? -1
  const selectedVersion = selectedIndex >= 0 ? state?.versions[selectedIndex] : undefined
  const isCurrent = selectedVersion?.id === state?.currentVersionId

  function selectOffset(offset: number): void {
    if (!state || selectedIndex < 0) return
    const next = state.versions[selectedIndex + offset]
    if (next) {
      setSelectedVersionId(next.id)
      setNotice('')
    }
  }

  async function applySelected(): Promise<void> {
    if (!selectedVersion) return
    setApplying(true)
    setNotice('')
    try {
      await window.artCreator.preview.applyVersion(jobId, selectedVersion.id)
      setState(await window.artCreator.preview.getProperties(jobId))
      setNotice('已应用到当前悬浮窗')
    } catch {
      setNotice('应用失败，请稍后重试')
    } finally {
      setApplying(false)
    }
  }

  async function saveSelected(): Promise<void> {
    if (!selectedVersion) return
    setSaving(true)
    setNotice('')
    try {
      if (await window.artCreator.preview.saveVersion(jobId, selectedVersion.id)) {
        setNotice('历史图片已保存到本地')
      }
    } catch {
      setNotice('保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="properties-shell">
      <div className="window-drag-bar" aria-hidden="true" />
      <header className="properties-header">
        <div>
          <p className="eyebrow">IMAGE PROPERTIES / VERSION HISTORY</p>
          <h1>{state?.assetName ?? '图片属性'}</h1>
        </div>
        <button className="properties-close" onClick={() => window.close()} aria-label="关闭属性窗">×</button>
      </header>

      {selectedVersion ? (
        <>
          <section className="properties-preview" aria-label="历史版本预览">
            <button
              className="version-arrow version-arrow-left"
              onClick={() => selectOffset(-1)}
              disabled={selectedIndex <= 0}
              aria-label="上一个历史版本"
            >‹</button>
            <div className="properties-image-stage">
              <img src={selectedVersion.imageDataUrl} alt={`生成历史版本 ${selectedIndex + 1}`} />
            </div>
            <button
              className="version-arrow version-arrow-right"
              onClick={() => selectOffset(1)}
              disabled={!state || selectedIndex >= state.versions.length - 1}
              aria-label="下一个历史版本"
            >›</button>
            <div className="version-caption">
              <span>版本 {selectedIndex + 1} / {state?.versions.length ?? 0}</span>
              <strong>{ACTION_LABEL[selectedVersion.action]}</strong>
              {isCurrent && <em>当前使用</em>}
            </div>
          </section>

          <section className="properties-metadata" aria-label="图片属性信息">
            <div><span>尺寸</span><strong>{versionDimensions(selectedVersion)}</strong></div>
            <div><span>文件大小</span><strong>{formatFileSize(selectedVersion.sizeBytes)}</strong></div>
            <div><span>格式</span><strong>PNG</strong></div>
            <div><span>背景</span><strong>{selectedVersion.background === 'transparent' ? '透明' : '不透明'}</strong></div>
            <div className="metadata-wide">
              <span>生成时间</span>
              <strong>{new Date(selectedVersion.createdAt).toLocaleString('zh-CN', { hour12: false })}</strong>
            </div>
          </section>

          {selectedVersion.prompt && (
            <section className="properties-prompt" aria-label="图片提示词">
              <span>{selectedVersion.action === 'capture' ? '初始素材说明' : '本次生成提示词'}</span>
              <textarea
                value={selectedVersion.prompt}
                readOnly
                aria-label="提示词内容"
              />
            </section>
          )}

          <footer className="properties-actions">
            <p aria-live="polite">{notice || (state?.busy ? '生成进行中，完成后可应用其他版本。' : '选择历史版本后可应用或保存。')}</p>
            <div>
              <button
                className="properties-apply"
                disabled={state?.busy || isCurrent || applying || saving}
                onClick={() => void applySelected()}
              >{applying ? '应用中…' : isCurrent ? '已应用' : '应用'}</button>
              <button
                className="properties-save"
                disabled={applying || saving}
                onClick={() => void saveSelected()}
              >{saving ? '保存中…' : '保存'}</button>
            </div>
          </footer>
        </>
      ) : (
        <div className="properties-empty"><span className="preview-spinner" />正在读取图片属性…</div>
      )}
    </main>
  )
}
