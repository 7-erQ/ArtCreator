import { useEffect, useState } from 'react'
import {
  DEFAULT_GENERATION_EFFECT_CHOICE,
  type GenerationEffectChoice
} from '../../shared/contracts'
import { getGenerationEffectScheme } from './GenerationEffectScheme'

export function DebugPanel(): React.JSX.Element {
  const [imagePath, setImagePath] = useState('')
  const [effectChoice, setEffectChoice] = useState<GenerationEffectChoice>(
    DEFAULT_GENERATION_EFFECT_CHOICE
  )
  const [busy, setBusy] = useState(false)
  const [captureOverlayProtection, setCaptureOverlayProtection] = useState(true)
  const [savingProtection, setSavingProtection] = useState(false)
  const [message, setMessage] = useState('')
  const [messageIsError, setMessageIsError] = useState(false)

  useEffect(() => {
    let disposed = false
    void window.artCreator.settings.get()
      .then((settings) => {
        if (!disposed) {
          setCaptureOverlayProtection(settings.captureOverlayProtection)
          setEffectChoice(settings.generationEffectChoice)
        }
      })
      .catch(() => {
        if (!disposed) {
          setMessage('无法读取调试设置。')
          setMessageIsError(true)
        }
      })
    return () => {
      disposed = true
    }
  }, [])

  async function chooseImage(): Promise<void> {
    try {
      const selectedPath = await window.artCreator.debug.chooseImage()
      if (selectedPath) {
        setImagePath(selectedPath)
        setMessage('')
        setMessageIsError(false)
      }
    } catch {
      setMessage('无法打开图片选择器。')
      setMessageIsError(true)
    }
  }

  async function createPreview(selectedEffect?: GenerationEffectChoice): Promise<void> {
    setBusy(true)
    setMessage('')
    setMessageIsError(false)
    try {
      await window.artCreator.debug.createPreview(imagePath, selectedEffect)
      setMessage(selectedEffect
        ? '加载特效调试窗已创建，阶段会自动循环。'
        : '调试悬浮窗已创建。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建调试悬浮窗失败。')
      setMessageIsError(true)
    } finally {
      setBusy(false)
    }
  }

  async function updateCaptureOverlayProtection(enabled: boolean): Promise<void> {
    const previous = captureOverlayProtection
    setCaptureOverlayProtection(enabled)
    setSavingProtection(true)
    setMessage('')
    setMessageIsError(false)
    try {
      const settings = await window.artCreator.settings.updateCaptureOverlayProtection(enabled)
      setCaptureOverlayProtection(settings.captureOverlayProtection)
      setMessage(enabled ? '选框录制保护已开启。' : '选框录制保护已关闭，Bandicam 可录制框选步骤。')
    } catch (error) {
      setCaptureOverlayProtection(previous)
      setMessage(error instanceof Error ? error.message : '保存选框录制保护设置失败。')
      setMessageIsError(true)
    } finally {
      setSavingProtection(false)
    }
  }

  return (
    <main className="debug-shell">
      <header className="debug-header">
        <p className="eyebrow">ART CREATOR / DEBUG</p>
        <h1>调试面板</h1>
        <p className="debug-lede">
          使用指定图片直接打开悬浮预览，方便验证拖动、克隆、穿透和关闭等交互。
        </p>
      </header>

      <section className="debug-card">
        <div className="debug-card-heading">
          <div>
            <span className="step">01</span>
            <h2>图片预览</h2>
          </div>
          <span className="debug-badge">不保存路径</span>
        </div>
        <p className="debug-card-description">
          图片由主进程读取并按原始比例创建置顶悬浮窗，不会写入设置或项目目录。
        </p>
        <label>
          <span>调试图片路径</span>
          <input
            aria-label="调试图片路径"
            value={imagePath}
            onChange={(event) => {
              setImagePath(event.target.value)
              setMessage('')
              setMessageIsError(false)
            }}
            placeholder="C:\path\to\image.png"
            autoComplete="off"
          />
        </label>
        <div className="debug-effect-current">
          <span>当前正式设置</span>
          <strong>
            {effectChoice === 'random' ? '每个任务随机' : getGenerationEffectScheme(effectChoice).label}
          </strong>
          <small>请在主设置页的“生成加载特效”中修改，调试窗只负责预览当前选择。</small>
        </div>
        <div className="debug-actions">
          <button className="debug-choose-button" type="button" onClick={() => void chooseImage()}>
            选择图片
          </button>
          <button
            className="debug-create-button"
            type="button"
            disabled={busy || !imagePath.trim()}
            onClick={() => void createPreview()}
          >
            {busy ? '正在创建…' : '创建悬浮窗'}
          </button>
          <button
            className="debug-effect-button"
            type="button"
            disabled={busy || !imagePath.trim()}
            onClick={() => void createPreview(effectChoice)}
          >
            {busy ? '正在创建…' : '预览加载特效'}
          </button>
        </div>
        {message && (
          <p className={messageIsError ? 'debug-message error' : 'debug-message'} aria-live="polite">
            {message}
          </p>
        )}

        <div className="advanced-divider" />
        <div className="debug-card-heading">
          <div>
            <span className="step">02</span>
            <h2>录制保护</h2>
          </div>
          <span className="debug-badge">
            {captureOverlayProtection ? '已保护' : '可录制'}
          </span>
        </div>
        <p className="debug-card-description">
          默认保护截图浮层不被录屏软件捕获。关闭后可录制真实的框选操作，不影响截图数据或生图流程。
        </p>
        <label className="setting-toggle">
          <input
            aria-label="保护截图选框不被录制"
            type="checkbox"
            checked={captureOverlayProtection}
            disabled={savingProtection}
            onChange={(event) => void updateCaptureOverlayProtection(event.target.checked)}
          />
          <span>
            <strong>保护截图选框不被录制</strong>
            <small>关闭后，Bandicam 等录屏软件可以录到截图选框和拖动过程。</small>
          </span>
        </label>
      </section>
    </main>
  )
}
