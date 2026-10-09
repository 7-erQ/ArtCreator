import { useLanguage } from './useLanguage'
import { t } from '../../shared/language'
import { useEffect, useRef, useState } from 'react'
import type { PreviewViewState, ScreenPointDip } from '../../shared/contracts'
import { movementDelta, screenPoint } from '../../shared/preview-geometry'
import { GenerationEffect } from './GenerationEffect'
import {
  getGenerationEffectScheme,
  normalizeGenerationEffectChoice,
  resolveGenerationEffectScheme
} from './GenerationEffectScheme'

const CLONE_DRAG_THRESHOLD_DIP = 4
const MOVE_DRAG_THRESHOLD_DIP = 4

interface CloneGesture {
  pointerId: number
  start: ScreenPointDip
  current: ScreenPointDip
  startRequested: boolean
  ready: boolean
  finished: boolean
}

interface MoveGesture {
  pointerId: number
  start: ScreenPointDip
  current: ScreenPointDip
  startRequested: boolean
  started: boolean
  finished: boolean
  moveFrameId?: number
}

const STATUS_TEXT = {
  processing_prompt: '正在润色提示词',
  awaiting_confirmation: '等待确认生成请求',
  generating: '正在生成素材',
  ready: '生成完成',
  failed: '生成失败',
  canceled: '任务已取消'
} as const

const ACTION_TEXT = {
  reconfigure: '重新配置',
  continue_edit: '继续编辑',
  regenerate: '重新生成',
  upscale: '放大 / 改尺寸',
  refine: '精细处理',
  cutout: '抠图'
} as const

export function Preview(): React.JSX.Element {
  useLanguage()
  const query = new URLSearchParams(window.location.search)
  const jobId = query.get('jobId') ?? ''
  const debugGenerationEffect = query.get('debugGenerationEffect') === '1'
  const effectChoice = normalizeGenerationEffectChoice(query.get('generationEffect'))
  const effectScheme = resolveGenerationEffectScheme(effectChoice, jobId)
  const [state, setState] = useState<PreviewViewState>()
  const [placeholderDataUrl, setPlaceholderDataUrl] = useState<string>()
  const [imageVisible, setImageVisible] = useState(false)
  const [notice, setNotice] = useState('')
  const [switchingVersion, setSwitchingVersion] = useState(false)
  const [ctrlPressed, setCtrlPressed] = useState(false)
  const [shiftPressed, setShiftPressed] = useState(false)
  const [cloneDragging, setCloneDragging] = useState(false)
  const cloneGesture = useRef<CloneGesture | undefined>(undefined)
  const moveGesture = useRef<MoveGesture | undefined>(undefined)
  const previousImageDataUrl = useRef<string | undefined>(undefined)
  const [debugEffectStatus, setDebugEffectStatus] = useState<PreviewViewState['job']['status']>()

  function applyViewState(value: PreviewViewState): void {
    if (value.placeholderDataUrl) setPlaceholderDataUrl(value.placeholderDataUrl)
    if (!value.imageDataUrl) {
      setImageVisible(false)
    } else if (previousImageDataUrl.current === undefined) {
      setImageVisible(false)
    }
    if (!value.imageDataUrl && value.job.status === 'canceled') {
      setPlaceholderDataUrl(undefined)
    }
    previousImageDataUrl.current = value.imageDataUrl
    setState(value)
  }

  async function refresh(): Promise<void> {
    applyViewState(await window.artCreator.preview.getState(jobId))
  }

  useEffect(() => {
    let active = true
    void window.artCreator.preview.getState(jobId).then((value) => {
      if (active) applyViewState(value)
    })
    const removeListener = window.artCreator.jobs.onChanged((job) => {
      if (job.id !== jobId) return
      if (job.status === 'processing_prompt' || job.status === 'generating') setNotice('')
      void window.artCreator.preview.getState(jobId).then((value) => {
        if (active) applyViewState(value)
      })
    })
    return () => {
      active = false
      removeListener()
    }
  }, [jobId])

  useEffect(() => {
    if (!debugGenerationEffect) return
    const phases: Array<PreviewViewState['job']['status'] | undefined> = [
      undefined,
      'processing_prompt',
      'generating'
    ]
    let phaseIndex = 0
    const interval = window.setInterval(() => {
      phaseIndex = (phaseIndex + 1) % phases.length
      setDebugEffectStatus(phases[phaseIndex])
    }, 1_800)
    return () => window.clearInterval(interval)
  }, [debugGenerationEffect])

  useEffect(() => {
    const updateFromKeyboard = (event: KeyboardEvent): void => {
      setCtrlPressed(event.ctrlKey)
      setShiftPressed(event.shiftKey)
    }
    const updateFromMouse = (event: MouseEvent): void => {
      setCtrlPressed(event.ctrlKey)
      setShiftPressed(event.shiftKey)
    }
    const reset = (): void => {
      setCtrlPressed(false)
      setShiftPressed(false)
    }
    window.addEventListener('keydown', updateFromKeyboard)
    window.addEventListener('keyup', updateFromKeyboard)
    window.addEventListener('mousemove', updateFromMouse)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', updateFromKeyboard)
      window.removeEventListener('keyup', updateFromKeyboard)
      window.removeEventListener('mousemove', updateFromMouse)
      window.removeEventListener('blur', reset)
    }
  }, [])

  async function copy(): Promise<void> {
    try {
      await window.artCreator.preview.copy(jobId)
      setNotice('已复制')
    } catch {
      setNotice('复制失败，请重试')
    }
  }

  async function save(): Promise<void> {
    try {
      if (await window.artCreator.preview.save(jobId)) setNotice('已保存')
    } catch {
      setNotice('保存失败，请重试')
    }
  }

  async function regenerate(): Promise<void> {
    setNotice('')
    try {
      await window.artCreator.preview.regenerate(jobId)
      await refresh()
    } catch {
      setNotice('无法重新生成，请稍后重试')
    }
  }

  async function switchVersion(versionId: string): Promise<void> {
    setSwitchingVersion(true)
    setNotice('')
    try {
      await window.artCreator.preview.applyVersion(jobId, versionId)
      await refresh()
    } catch {
      setNotice('无法切换历史图片，请重试')
    } finally {
      setSwitchingVersion(false)
    }
  }

  async function cancelGeneration(): Promise<void> {
    try {
      await window.artCreator.jobs.cancel(jobId)
    } catch {
      setNotice('无法取消生成，请重试')
    }
  }

  async function startCapture(): Promise<void> {
    setNotice('')
    try {
      await window.artCreator.capture.start()
    } catch {
      setNotice('无法开始新截图，请稍后重试')
    }
  }

  async function enableClickThrough(): Promise<void> {
    setState((current) => current ? { ...current, clickThrough: true } : current)
    try {
      await window.artCreator.preview.setClickThrough(jobId, true)
    } catch {
      setState((current) => current ? { ...current, clickThrough: false } : current)
      setNotice('无法启用穿透')
    }
  }

  function showMoreMenu(): void {
    void window.artCreator.preview.showMenu(jobId)
  }

  function openMoreMenuFromContext(event: React.MouseEvent<HTMLElement>): void {
    event.preventDefault()
    showMoreMenu()
  }

  function queueMoveGesture(gesture: MoveGesture): void {
    if (gesture.moveFrameId !== undefined) return
    gesture.moveFrameId = window.requestAnimationFrame(() => {
      gesture.moveFrameId = undefined
      if (!gesture.started || gesture.finished) return
      window.artCreator.preview.moveDrag(jobId, gesture.current)
    })
  }

  function cancelQueuedMove(gesture: MoveGesture): void {
    if (gesture.moveFrameId === undefined) return
    window.cancelAnimationFrame(gesture.moveFrameId)
    gesture.moveFrameId = undefined
  }

  function startMoveGesture(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = screenPoint(event)
    const gesture: MoveGesture = {
      pointerId: event.pointerId,
      start: point,
      current: point,
      startRequested: false,
      started: false,
      finished: false
    }
    moveGesture.current = gesture
  }

  function moveMoveGesture(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = moveGesture.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const point = screenPoint(event)
    if (!gesture.startRequested) {
      gesture.current = point
      const distance = Math.hypot(
        point.x - gesture.start.x,
        point.y - gesture.start.y
      )
      if (distance < MOVE_DRAG_THRESHOLD_DIP) return
      gesture.startRequested = true
      window.artCreator.preview.startMoveDrag(jobId, gesture.start)
      gesture.started = true
      queueMoveGesture(gesture)
      return
    }
    if (!gesture.started) {
      gesture.current = point
      return
    }
    const delta = movementDelta(event)
    gesture.current = {
      x: gesture.current.x + delta.x,
      y: gesture.current.y + delta.y
    }
    queueMoveGesture(gesture)
  }

  function finishMoveGesture(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = moveGesture.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gesture.finished = true
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!gesture.startRequested) {
      moveGesture.current = undefined
      return
    }
    if (!gesture.started) return
    cancelQueuedMove(gesture)
    window.artCreator.preview.moveDrag(jobId, gesture.current)
    window.artCreator.preview.endMoveDrag(jobId)
    moveGesture.current = undefined
  }

  function cancelMoveGesture(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = moveGesture.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gesture.finished = true
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!gesture.startRequested) {
      moveGesture.current = undefined
      return
    }
    if (!gesture.started) return
    cancelQueuedMove(gesture)
    window.artCreator.preview.endMoveDrag(jobId)
    moveGesture.current = undefined
  }

  function startFileDrag(event: React.DragEvent<HTMLImageElement>): void {
    event.preventDefault()
    if (!event.ctrlKey || event.shiftKey) return
    window.artCreator.preview.startDrag(jobId)
  }

  function startCloneGesture(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || !event.shiftKey || !state?.imageDataUrl) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = screenPoint(event)
    cloneGesture.current = {
      pointerId: event.pointerId,
      start: point,
      current: point,
      startRequested: false,
      ready: false,
      finished: false
    }
  }

  function startPointerGesture(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.shiftKey) {
      startCloneGesture(event)
      return
    }
    startMoveGesture(event)
  }

  function movePointerGesture(event: React.PointerEvent<HTMLDivElement>): void {
    moveMoveGesture(event)
    moveCloneGesture(event)
  }

  function finishPointerGesture(event: React.PointerEvent<HTMLDivElement>): void {
    finishMoveGesture(event)
    finishCloneGesture(event)
  }

  function cancelPointerGesture(event: React.PointerEvent<HTMLDivElement>): void {
    cancelMoveGesture(event)
    cancelCloneGesture(event)
  }

  function moveCloneGesture(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = cloneGesture.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gesture.current = screenPoint(event)
    if (!gesture.startRequested) {
      if (!event.shiftKey) {
        cloneGesture.current = undefined
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        return
      }
      const distance = Math.hypot(
        gesture.current.x - gesture.start.x,
        gesture.current.y - gesture.start.y
      )
      if (distance < CLONE_DRAG_THRESHOLD_DIP) return
      gesture.startRequested = true
      setCloneDragging(true)
      void window.artCreator.preview.startCloneDrag(jobId, gesture.start, gesture.current)
        .then(() => {
          gesture.ready = true
          window.artCreator.preview.moveCloneDrag(jobId, gesture.current)
          if (!gesture.finished) return
          window.artCreator.preview.endCloneDrag(jobId)
          if (cloneGesture.current === gesture) cloneGesture.current = undefined
          setCloneDragging(false)
        })
        .catch(() => {
          if (cloneGesture.current === gesture) cloneGesture.current = undefined
          setCloneDragging(false)
          setNotice('无法克隆悬浮窗，请重试')
        })
      return
    }
    if (gesture.ready) window.artCreator.preview.moveCloneDrag(jobId, gesture.current)
  }

  function finishCloneGesture(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = cloneGesture.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gesture.current = screenPoint(event)
    gesture.finished = true
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!gesture.startRequested) {
      cloneGesture.current = undefined
      return
    }
    if (!gesture.ready) return
    window.artCreator.preview.moveCloneDrag(jobId, gesture.current)
    window.artCreator.preview.endCloneDrag(jobId)
    cloneGesture.current = undefined
    setCloneDragging(false)
  }

  function cancelCloneGesture(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = cloneGesture.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gesture.finished = true
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!gesture.startRequested) {
      cloneGesture.current = undefined
      return
    }
    if (!gesture.ready) return
    window.artCreator.preview.endCloneDrag(jobId)
    cloneGesture.current = undefined
    setCloneDragging(false)
  }

  const job = state?.job
  const retainsImage = Boolean(state?.imageDataUrl)
  const isProcessing = job?.status === 'processing_prompt' || job?.status === 'generating'
  const isBusy = isProcessing || job?.status === 'awaiting_confirmation'
  const historyBusy = isBusy || switchingVersion
  const displaysGenerationEffect = isProcessing || debugGenerationEffect
  const hasPlaceholder = Boolean(placeholderDataUrl)
  const cloneMode = shiftPressed || cloneDragging
  const fileDragMode = ctrlPressed && !cloneMode
  const actionText = job?.pendingAction ? t(ACTION_TEXT[job.pendingAction]) : undefined
  const defaultStatusText = debugGenerationEffect
    ? t('特效调试 · {0} · {1}', t(getGenerationEffectScheme(effectScheme).label), debugEffectStatus === 'processing_prompt'
        ? t('理解提示词')
        : debugEffectStatus === 'generating' ? t('绘制素材') : t('准备预览'))
    : isProcessing && retainsImage && actionText
      ? t('正在{0}，保留当前图片', actionText)
      : job?.status === 'failed' && retainsImage && actionText
        ? t('{0}失败，已保留上一版', actionText)
        : t(job?.error?.message) || (job ? t(STATUS_TEXT[job.status]) : t('正在创建预览'))

  const progress = job?.generationProgress
  const statusText = !debugGenerationEffect && progress && progress.total > 1
    ? job?.status === 'failed' || job?.status === 'canceled'
      ? t('{0}，已完成 {1} / {2} 张，保留当前图片', t(STATUS_TEXT[job.status]), progress.completed, progress.total)
      : job?.status === 'generating'
        ? t('正在{0}，已完成 {1} / {2} 张', actionText ?? t('生成素材'), progress.completed, progress.total)
        : t('{0}（{1} / {2} 张）', job ? t(STATUS_TEXT[job.status]) : '', progress.completed, progress.total)
    : defaultStatusText

  return (
    <main
      className={`preview-shell ${retainsImage ? 'has-image' : ''} ${displaysGenerationEffect ? 'is-loading' : ''} ${debugGenerationEffect ? 'debug-generation-effect' : ''} ${fileDragMode ? 'ctrl-drag-mode' : ''} ${cloneMode ? 'shift-clone-mode' : ''}`}
      onContextMenu={openMoreMenuFromContext}
    >
      <div
        className="preview-drag-surface"
        onPointerDown={startPointerGesture}
        onPointerMove={movePointerGesture}
        onPointerUp={finishPointerGesture}
        onPointerCancel={cancelPointerGesture}
      >
        {hasPlaceholder && (
          <GenerationEffect
            status={job?.status}
            presentation="placeholder"
            scheme={effectScheme}
            sourceImageUrl={placeholderDataUrl}
            hidden={imageVisible}
          />
        )}
        {!retainsImage && !hasPlaceholder && (
          <GenerationEffect
            status={job?.status}
            presentation="placeholder"
            scheme={effectScheme}
          />
        )}
        {state?.imageDataUrl && (
          <img
            className={`preview-image ${imageVisible ? 'image-visible' : ''}`}
            src={state.imageDataUrl}
            alt={t('生成的素材')}
            draggable={fileDragMode}
            onLoad={() => {
              setImageVisible(true)
              window.setTimeout(() => setPlaceholderDataUrl(undefined), 420)
            }}
            onDragStart={startFileDrag}
          />
        )}
        {debugGenerationEffect && state?.imageDataUrl && (
          <GenerationEffect
            status={debugEffectStatus}
            presentation="placeholder"
            scheme={effectScheme}
            sourceImageUrl={state.imageDataUrl}
          />
        )}
        {retainsImage && isProcessing && (
          <GenerationEffect
            status={job?.status}
            presentation="overlay"
            scheme={effectScheme}
            sourceImageUrl={state?.imageDataUrl}
          />
        )}
      </div>

      <div
        className={`preview-status status-${job?.status ?? 'processing_prompt'}`}
        title={job?.error?.message ? `${statusText}: ${t(job.error.message)}` : statusText}
      >{statusText}</div>
      {notice && <div className="preview-notice">{t(notice)}</div>}

      {(state?.previousVersionId || state?.nextVersionId) && (
        <nav className="preview-history" aria-label={t('历史图片切换')}>
          <button
            className="preview-history-previous"
            aria-label={t('上一个历史版本')}
            title={t('上一个历史版本')}
            disabled={historyBusy || !state.previousVersionId}
            onClick={() => state.previousVersionId && void switchVersion(state.previousVersionId)}
          >{'<'}</button>
          <button
            className="preview-history-next"
            aria-label={t('下一个历史版本')}
            title={t('下一个历史版本')}
            disabled={historyBusy || !state.nextVersionId}
            onClick={() => state.nextVersionId && void switchVersion(state.nextVersionId)}
          >{'>'}</button>
        </nav>
      )}

      <nav className="preview-toolbar preview-actions-expanded" aria-label={t('预览操作')}>
        <button disabled={!retainsImage} onClick={() => void copy()} title={t('复制图片')}>{t('复制')}</button>
        <button disabled={!retainsImage} onClick={() => void save()} title={t('保存 PNG')}>{t('保存')}</button>
        <button onClick={() => void window.artCreator.preview.openDetails(jobId)} title={t('编辑提示词')}>{t('编辑')}</button>
        <button
          disabled={!isBusy && !job?.assetSpec}
          onClick={() => void (isBusy ? cancelGeneration() : regenerate())}
          title={isBusy ? t('取消生成') : t('重新生成 {0} 张', job?.selection.generationCount ?? 1)}
        >{isBusy ? t('取消生成') : t('重生成')}</button>
        <button onClick={() => void startCapture()} title={t('开始新的截图生成任务')}>{t('新截图')}</button>
        <button onClick={() => void enableClickThrough()} title={t('启用鼠标穿透')}>{t('穿透')}</button>
        <button onClick={() => void window.artCreator.preview.close(jobId)} title={t('关闭预览')}>{t('关闭')}</button>
      </nav>

      <button
        className="preview-menu-button"
        onClick={showMoreMenu}
        aria-label={t('更多选项')}
        title={t('更多选项')}
      >•••</button>
    </main>
  )
}
