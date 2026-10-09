import { t } from '../shared/language'
import { randomUUID } from 'node:crypto'
import {
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  shell,
  systemPreferences,
  type Display
} from 'electron'
import {
  CAPTURE_DOODLE_STROKE_WIDTH_DIP,
  comfyUiCapabilitiesSchema,
  captureSelectionSchema,
  generationOptionsSchema,
  captureSubmissionModeSchema,
  captureSessionIdSchema,
  IPC_CHANNELS,
  MAX_REFERENCE_IMAGE_COUNT,
  UNAVAILABLE_COMFYUI_CAPABILITIES,
  type ComfyUiCapabilities,
  type ComfyUiWorkflowBinding,
  type CaptureFollowUpAction,
  type CaptureOverlaySession,
  type CaptureSelection,
  type CaptureSubmissionMode,
  type GenerationOptions,
  type RectDip
} from '../shared/contracts'
import {
  toGlobalDisplayRect,
  toPhysicalPixels,
  type PixelRect
} from '../shared/geometry'
import { resolveCaptureRegions } from '../shared/capture-regions'
import { supportsImageGeneration } from '../shared/image-models'
import {
  createInpaintDoodleMaskBitmap,
  markTargetFrame,
  type BitmapPoint
} from './selection-bitmap'
import {
  captureDisplaySnapshots,
  type CapturedDisplaySnapshot
} from './display-capture'
import {
  elapsedTimingMs,
  timingNow,
  type TimingLogger
} from './application-logger'

export interface CaptureResult {
  selection: CaptureSelection
  submissionMode: CaptureSubmissionMode
  followUp?: {
    jobId: string
    action: CaptureFollowUpAction
  }
  globalOutputRectDip: RectDip
  screenshotPng: Buffer
  placeholderPng: Buffer
  referencePngs: [Buffer, ...Buffer[]]
  markedContextPng?: Buffer
  inpaintSourcePng?: Buffer
  inpaintMaskPng?: Buffer
  timing?: {
    workflowId: string
    startedAtMs: number
  }
}

interface CaptureFollowUpRequestBase {
  jobId: string
  selection: CaptureSelection
  currentImagePng: Buffer
  previewWindow: BrowserWindow
}

export type CaptureFollowUpRequest = CaptureFollowUpRequestBase & (
  | { action: 'reconfigure'; screenshotPng: Buffer }
  | { action: 'continue_edit' }
)

interface CaptureSession {
  id: string
  startedAtMs: number
  snapshots: Map<string, CapturedDisplaySnapshot>
  hiddenWindows: BrowserWindow[]
  activeDisplayId?: string
  followUp?: CaptureFollowUpRequest
  comfyUiCapabilities?: Promise<ComfyUiCapabilities>
  comfyUiCapabilitiesController?: AbortController
}

interface Deferred {
  promise: Promise<void>
  resolve(): void
}

interface OverlayEntry {
  displayId: string
  webContentsId: number
  window: BrowserWindow
  ready: Deferred
  sessionReady?: {
    sessionId: string
    deferred: Deferred
  }
  retiring: boolean
}

interface CaptureControllerOptions {
  createWindow(view: string, options: Electron.BrowserWindowConstructorOptions): BrowserWindow
  shouldIncludeWindowInCapture(window: BrowserWindow): boolean
  shouldProtectOverlayContent(): boolean
  getDefaultGenerationOptions(): GenerationOptions
  getComfyUiWorkflowBindings(): ComfyUiWorkflowBinding[]
  persistLastGenerationOptions(options: GenerationOptions): Promise<void>
  loadComfyUiCapabilities(signal: AbortSignal): Promise<ComfyUiCapabilities>
  allowFakeGeneration: boolean
  onSubmitted(result: CaptureResult): void | Promise<void>
  onTiming?: TimingLogger
  onUnexpectedError?(event: string, error: unknown): void
}

type CapturePhase = 'idle' | 'preparing' | 'active' | 'finishing'

const OVERLAY_READY_TIMEOUT_MS = 10_000
const SESSION_READY_TIMEOUT_MS = 5_000
const COMFYUI_CAPABILITIES_TIMEOUT_MS = 2_000

const waitForDesktopComposition = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 90))

function createDeferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function setCaptureOverlayWindowLevel(window: BrowserWindow, active: boolean): void {
  // macOS input-method panels cannot appear above a screen-saver-level text client.
  const level = process.platform === 'darwin' && active ? 'floating' : 'screen-saver'
  window.setAlwaysOnTop(true, level)
}

async function waitWithTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
  message: string
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function ensureScreenRecordingPermission(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status === 'granted') return true

  const result = await dialog.showMessageBox({
    type: 'warning',
    title: t('需要屏幕录制权限'),
    message: status === 'not-determined'
      ? t('Art Creator 尚未获得屏幕录制权限。')
      : t('Art Creator 无法读取屏幕画面。'),
    detail: t('请在“隐私与安全性 > 屏幕与系统音频录制”中启用 Art Creator，然后重新启动应用。'),
    buttons: [t('打开“隐私与安全性”'), t('取消')],
    defaultId: 0,
    cancelId: 1
  })
  if (result.response === 0) {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    )
  }
  return false
}

function asRectDip(rect: Electron.Rectangle): RectDip {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function relativeRectPixels(
  context: Electron.Rectangle,
  rect: Electron.Rectangle
): PixelRect {
  const x = Math.max(0, rect.x - context.x)
  const y = Math.max(0, rect.y - context.y)
  return {
    x,
    y,
    width: Math.min(rect.width, context.width - x),
    height: Math.min(rect.height, context.height - y)
  }
}

function doodleStrokePixels(
  strokesDip: NonNullable<CaptureSelection['doodleStrokesDip']>,
  contextRectDip: RectDip,
  scaleFactor: number,
  width: number,
  height: number
): BitmapPoint[][] {
  return strokesDip.map((stroke) => stroke.map((point) => ({
    x: Math.min(width - 1, Math.max(0, Math.round((point.x - contextRectDip.x) * scaleFactor))),
    y: Math.min(height - 1, Math.max(0, Math.round((point.y - contextRectDip.y) * scaleFactor)))
  })))
}

function rectStaysInside(rect: RectDip, bounds: RectDip): boolean {
  return rect.x >= bounds.x - 0.01 &&
    rect.y >= bounds.y - 0.01 &&
    rect.x + rect.width <= bounds.x + bounds.width + 0.01 &&
    rect.y + rect.height <= bounds.y + bounds.height + 0.01
}

function bitmapPng(bitmap: Buffer, width: number, height: number): Buffer {
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG()
}

export class CaptureController {
  private readonly overlays = new Map<string, OverlayEntry>()
  private readonly overlayByWebContents = new Map<number, OverlayEntry>()
  private session?: CaptureSession
  private phase: CapturePhase = 'idle'
  private overlaySync: Promise<void> = Promise.resolve()
  private initialized = false
  private disposed = false

  private readonly onDisplaysChanged = (): void => {
    if (!this.initialized || this.disposed || this.phase !== 'idle') return
    void this.synchronizeOverlays(screen.getAllDisplays()).catch((error) => {
      this.options.onUnexpectedError?.('capture_overlays_sync_failed', error)
    })
  }

  constructor(private readonly options: CaptureControllerOptions) {
    this.registerIpc()
    screen.on('display-added', this.onDisplaysChanged)
    screen.on('display-removed', this.onDisplaysChanged)
    screen.on('display-metrics-changed', this.onDisplaysChanged)
  }

  initialize(): Promise<void> {
    this.initialized = true
    return this.synchronizeOverlays(screen.getAllDisplays())
  }

  startFollowUp(request: CaptureFollowUpRequest): Promise<void> {
    return this.start(request)
  }

  async start(followUp?: CaptureFollowUpRequest): Promise<void> {
    if (this.disposed || this.phase !== 'idle') return
    const followUpSelection = followUp
      ? captureSelectionSchema.parse({
          ...followUp.selection,
          ...(followUp.action === 'continue_edit' ? { imageGeneration: 'reference' } : {})
        })
      : undefined
    if (followUp && (followUp.currentImagePng.length === 0 ||
      (followUp.action === 'reconfigure' && followUp.screenshotPng.length === 0))) {
      throw new Error(t('后续编辑所需的截图或当前图片不可用。'))
    }
    const workflowId = randomUUID()
    const startedAtMs = timingNow()
    this.phase = 'preparing'
    let session: CaptureSession | undefined
    this.logTiming(workflowId, startedAtMs, 'capture_started')

    try {
      if (!await ensureScreenRecordingPermission()) {
        this.phase = 'idle'
        this.logTiming(workflowId, startedAtMs, 'capture_permission_denied')
        return
      }
      this.logTiming(workflowId, startedAtMs, 'capture_permission_ready')
      const displays = screen.getAllDisplays()
      if (displays.length === 0) throw new Error(t('未找到可用显示器。'))
      this.initialized = true
      await this.synchronizeOverlays(displays)
      this.logTiming(workflowId, startedAtMs, 'capture_overlays_ready', { displays: displays.length })

      const visibleWindows = BrowserWindow.getAllWindows().filter((window) =>
        window.isVisible() &&
        !window.isDestroyed() &&
        !this.overlayByWebContents.has(window.webContents.id)
      )
      const includedWindows = visibleWindows.filter((window) =>
        window !== followUp?.previewWindow &&
        this.options.shouldIncludeWindowInCapture(window)
      )
      const hiddenWindows = visibleWindows.filter((window) =>
        !includedWindows.includes(window)
      )
      hiddenWindows.forEach((window) => window.hide())

      session = {
        id: workflowId,
        startedAtMs,
        snapshots: new Map(),
        hiddenWindows,
        ...(followUp
          ? {
              activeDisplayId: followUpSelection!.displayId,
              followUp: {
                ...followUp,
                selection: followUpSelection!
              }
            }
          : {})
      }
      this.session = session

      await waitForDesktopComposition()
      session.snapshots = await captureDisplaySnapshots(displays)
      if (session.followUp?.action === 'reconfigure') {
        const displayId = session.followUp.selection.displayId
        const snapshot = session.snapshots.get(displayId)
        if (!snapshot) throw new Error(t('原截屏所在的显示器当前不可用。'))
        const source = nativeImage.createFromBuffer(session.followUp.screenshotPng)
        if (source.isEmpty()) throw new Error(t('无法读取悬浮窗的原始截屏。'))
        const expectedSize = {
          width: Math.max(1, Math.round(snapshot.display.size.width * snapshot.display.scaleFactor)),
          height: Math.max(1, Math.round(snapshot.display.size.height * snapshot.display.scaleFactor))
        }
        const sourceSize = source.getSize()
        snapshot.image = sourceSize.width === expectedSize.width && sourceSize.height === expectedSize.height
          ? source
          : source.resize({ ...expectedSize, quality: 'best' })
      }
      this.logTiming(workflowId, startedAtMs, 'capture_snapshot_ready', { displays: displays.length })

      let hidIncludedWindow = false
      for (const window of includedWindows) {
        if (window.isDestroyed() || !window.isVisible()) continue
        window.hide()
        session.hiddenWindows.push(window)
        hidIncludedWindow = true
      }
      if (hidIncludedWindow) await waitForDesktopComposition()
      await this.presentSession(session, displays)
      if (this.session === session) {
        this.phase = 'active'
        this.logTiming(workflowId, startedAtMs, 'capture_overlay_visible')
      }
    } catch (error) {
      if (session) this.finishSession(session)
      else this.phase = 'idle'
      this.logTiming(workflowId, startedAtMs, 'capture_failed')
      await dialog.showMessageBox({
        type: 'error',
        title: t('无法捕获屏幕'),
        message: error instanceof Error ? error.message : t('屏幕捕获失败。')
      })
    }
  }

  async cancel(): Promise<void> {
    const session = this.session
    if (!session) return
    this.logTiming(session.id, session.startedAtMs, 'capture_canceled')
    this.finishSession(session)
  }

  refreshOverlayContentProtection(): void {
    const enabled = this.options.shouldProtectOverlayContent()
    this.overlays.forEach((entry) => {
      if (!entry.window.isDestroyed()) entry.window.setContentProtection(enabled)
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.session) this.finishSession(this.session)

    screen.removeListener('display-added', this.onDisplaysChanged)
    screen.removeListener('display-removed', this.onDisplaysChanged)
    screen.removeListener('display-metrics-changed', this.onDisplaysChanged)

    for (const entry of this.overlays.values()) {
      entry.retiring = true
      if (!entry.window.isDestroyed()) entry.window.destroy()
    }
    this.overlays.clear()
    this.overlayByWebContents.clear()

    ipcMain.removeHandler(IPC_CHANNELS.captureStart)
    ipcMain.removeHandler(IPC_CHANNELS.captureOverlayReady)
    ipcMain.removeHandler(IPC_CHANNELS.captureSessionReady)
    ipcMain.removeHandler(IPC_CHANNELS.captureActivate)
    ipcMain.removeHandler(IPC_CHANNELS.captureGetComfyUiCapabilities)
    ipcMain.removeHandler(IPC_CHANNELS.captureSubmit)
    ipcMain.removeHandler(IPC_CHANNELS.captureCancel)
  }

  private registerIpc(): void {
    ipcMain.handle(IPC_CHANNELS.captureStart, async (): Promise<void> => this.start())

    ipcMain.handle(IPC_CHANNELS.captureOverlayReady, (event): void => {
      this.requireOverlay(event.sender.id).ready.resolve()
    })

    ipcMain.handle(IPC_CHANNELS.captureSessionReady, (event, rawSessionId: unknown): void => {
      const sessionId = captureSessionIdSchema.parse(rawSessionId)
      const entry = this.requireOverlay(event.sender.id)
      const pending = entry.sessionReady
      if (!pending) {
        if (this.session?.id === sessionId) return
        throw new Error('Capture overlay has no pending session.')
      }
      if (pending.sessionId !== sessionId || this.session?.id !== sessionId) {
        throw new Error('Capture overlay session mismatch.')
      }
      entry.sessionReady = undefined
      pending.deferred.resolve()
    })

    ipcMain.handle(IPC_CHANNELS.captureActivate, (event): void => {
      const session = this.requireSession(event.sender.id)
      const activeEntry = this.requireOverlay(event.sender.id)
      const displayId = activeEntry.displayId
      if (session.activeDisplayId && session.activeDisplayId !== displayId) return
      session.activeDisplayId = displayId
      setCaptureOverlayWindowLevel(activeEntry.window, true)
      this.overlays.forEach((entry) => {
        entry.window.webContents.send(IPC_CHANNELS.captureLocked, displayId)
        if (entry.displayId !== displayId) entry.window.setIgnoreMouseEvents(true)
      })
    })

    ipcMain.handle(IPC_CHANNELS.captureGetComfyUiCapabilities, async (
      event,
      rawSessionId: unknown
    ): Promise<ComfyUiCapabilities> => {
      const sessionId = captureSessionIdSchema.parse(rawSessionId)
      const session = this.requireSession(event.sender.id)
      if (session.id !== sessionId) throw new Error('Capture overlay session mismatch.')
      return this.getComfyUiCapabilities(session)
    })

    ipcMain.handle(IPC_CHANNELS.captureCancel, async (event): Promise<void> => {
      this.requireSession(event.sender.id)
      await this.cancel()
    })

    ipcMain.handle(IPC_CHANNELS.captureSubmit, async (
      event,
      rawSelection: unknown,
      rawSubmissionMode: unknown = 'generate'
    ) => {
      const session = this.requireSession(event.sender.id)
      const displayId = this.requireOverlay(event.sender.id).displayId
      const selection = captureSelectionSchema.parse(rawSelection)
      const submissionMode = captureSubmissionModeSchema.parse(rawSubmissionMode)
      if ((selection.referenceRectsDip?.length ?? 0) > 0 &&
        !supportsImageGeneration(selection.imageModel, 'reference')) {
        throw new Error(t('当前模型不支持参考生成，请更换模型或撤销蓝色参考框后提交。'))
      }
      if (submissionMode === 'fake' && !this.options.allowFakeGeneration) {
        throw new Error(t('假生成仅在开发环境可用。'))
      }
      if (selection.displayId !== displayId) throw new Error('Capture display mismatch.')
      if (session.activeDisplayId && session.activeDisplayId !== displayId) {
        throw new Error('Another display owns the capture session.')
      }
      if (selection.imageModel.provider === 'comfyui') {
        const capabilities = await this.getComfyUiCapabilities(session)
        if (!capabilities.available) throw new Error(t('ComfyUI 当前不可用，请选择其它图片供应商。'))
        const imageModel = selection.imageModel
        if ('workflowPath' in imageModel) {
          const configured = this.options.getComfyUiWorkflowBindings().find((binding) =>
            binding.workflowPath === imageModel.workflowPath)
          if (!configured || !selection.comfyUiWorkflowBinding ||
            JSON.stringify(configured) !== JSON.stringify(selection.comfyUiWorkflowBinding) ||
            !capabilities.workflows.some((workflow) =>
              workflow.path === imageModel.workflowPath)) {
            throw new Error(t('ComfyUI 工作流或节点绑定已变化，请重新选择后提交。'))
          }
        } else if ('model' in imageModel) {
          const options = selection.comfyUiGenerationOptions!
          if (!capabilities.checkpoints.includes(imageModel.model) ||
            !capabilities.samplers.includes(options.samplerName) ||
            !capabilities.schedulers.includes(options.scheduler)) {
            throw new Error(t('ComfyUI 模型或采样参数已变化，请重新选择后提交。'))
          }
        }
      }

      const snapshot = session.snapshots.get(displayId)!
      this.logTiming(session.id, session.startedAtMs, 'capture_selection_submitted')
      if (Math.abs(selection.scaleFactor - snapshot.display.scaleFactor) > 0.001) {
        throw new Error('Capture scale factor mismatch.')
      }
      const displayBounds = asRectDip(snapshot.display.bounds)
      const displayLocalBounds = {
        x: 0,
        y: 0,
        width: displayBounds.width,
        height: displayBounds.height
      }
      const regions = resolveCaptureRegions(selection)
      if (!rectStaysInside(regions.contextRectDip, displayLocalBounds)) {
        throw new Error('Context rectangle must stay inside the selected display.')
      }
      if (regions.referenceRectsDip.some((rect) => !rectStaysInside(rect, displayLocalBounds))) {
        throw new Error('Reference rectangle must stay inside the selected display.')
      }
      const selectedReferenceRects = selection.referenceRectsDip ?? []
      if (session.followUp?.action === 'continue_edit' &&
        selectedReferenceRects.length + 1 > MAX_REFERENCE_IMAGE_COUNT) {
        throw new Error(t('继续编辑最多支持 {0} 张参考图。', MAX_REFERENCE_IMAGE_COUNT))
      }

      const image = snapshot.image
      const contextPixels = toPhysicalPixels(regions.contextRectDip, snapshot.display.scaleFactor)
      const outputPixels = toPhysicalPixels(regions.outputRectDip, snapshot.display.scaleFactor)
      const contextImage = image.crop(contextPixels)
      const contextSize = contextImage.getSize()
      const outputInsideContext = relativeRectPixels(contextPixels, outputPixels)
      const outputImage = contextImage.crop(outputInsideContext)
      const outputSize = outputImage.getSize()
      const outputPng = outputImage.toPNG()
      const doodlePixels = selection.doodleStrokesDip
        ? doodleStrokePixels(
            selection.doodleStrokesDip,
            regions.outputRectDip,
            selection.scaleFactor,
            outputSize.width,
            outputSize.height
          )
        : undefined
      const doodleThickness = Math.max(
        1,
        Math.round(CAPTURE_DOODLE_STROKE_WIDTH_DIP * selection.scaleFactor)
      )
      const referencePngs: [Buffer, ...Buffer[]] = session.followUp?.action === 'continue_edit'
        ? [
            Buffer.from(session.followUp.currentImagePng),
            ...selectedReferenceRects.map((rect) => image.crop(toPhysicalPixels(
              rect,
              snapshot.display.scaleFactor
            )).toPNG())
          ]
        : (regions.referenceRectsDip.map((rect) => image.crop(toPhysicalPixels(
            rect,
            snapshot.display.scaleFactor
          )).toPNG()) as [Buffer, ...Buffer[]])
      const result: CaptureResult = {
        selection,
        submissionMode,
        ...(session.followUp
          ? { followUp: { jobId: session.followUp.jobId, action: session.followUp.action } }
          : {}),
        globalOutputRectDip: toGlobalDisplayRect(displayBounds, regions.outputRectDip),
        screenshotPng: image.toPNG(),
        placeholderPng: outputPng,
        referencePngs,
        ...(selection.promptProcessing === 'polish_with_selection'
          ? {
              markedContextPng: bitmapPng(
                markTargetFrame(
                  contextImage.toBitmap(),
                  contextSize.width,
                  contextSize.height,
                  outputInsideContext,
                  Math.max(2, Math.round(3 * selection.scaleFactor))
                ),
                contextSize.width,
                contextSize.height
              )
            }
          : {}),
        ...(selection.imageGeneration === 'inpaint'
          ? {
              inpaintSourcePng: outputPng,
              inpaintMaskPng: bitmapPng(
                createInpaintDoodleMaskBitmap(
                  outputSize.width,
                  outputSize.height,
                  doodlePixels!,
                  doodleThickness
                ),
                outputSize.width,
                outputSize.height
              )
            }
          : {}),
        timing: {
          workflowId: session.id,
          startedAtMs: session.startedAtMs
        }
      }

      this.logTiming(session.id, session.startedAtMs, 'capture_image_prepared')
      if (submissionMode === 'generate') {
        await this.options.persistLastGenerationOptions(generationOptionsSchema.parse(selection))
      }
      this.finishSession(session)
      await this.options.onSubmitted(result)
    })
  }

  private requireOverlay(webContentsId: number): OverlayEntry {
    const entry = this.overlayByWebContents.get(webContentsId)
    if (!entry || entry.window.isDestroyed()) {
      throw new Error('Capture overlay is unavailable.')
    }
    return entry
  }

  private requireSession(webContentsId: number): CaptureSession {
    const entry = this.requireOverlay(webContentsId)
    if (!this.session || !this.session.snapshots.has(entry.displayId)) {
      throw new Error('No active capture session for this window.')
    }
    return this.session
  }

  private getComfyUiCapabilities(session: CaptureSession): Promise<ComfyUiCapabilities> {
    if (session.comfyUiCapabilities) return session.comfyUiCapabilities
    const controller = new AbortController()
    session.comfyUiCapabilitiesController = controller
    const timeout = setTimeout(
      () => controller.abort(new Error('ComfyUI capability query timed out.')),
      COMFYUI_CAPABILITIES_TIMEOUT_MS
    )
    session.comfyUiCapabilities = this.options.loadComfyUiCapabilities(controller.signal)
      .then((value) => comfyUiCapabilitiesSchema.parse(value))
      .catch(() => ({ ...UNAVAILABLE_COMFYUI_CAPABILITIES }))
      .finally(() => clearTimeout(timeout))
    return session.comfyUiCapabilities
  }

  private synchronizeOverlays(displays: Display[]): Promise<void> {
    const next = this.overlaySync.then(() => this.syncOverlayPool(displays))
    this.overlaySync = next.catch(() => undefined)
    return next
  }

  private async syncOverlayPool(displays: Display[]): Promise<void> {
    if (this.disposed) return
    const displayIds = new Set(displays.map((display) => String(display.id)))

    for (const [displayId, entry] of this.overlays) {
      if (displayIds.has(displayId) && !entry.window.isDestroyed()) continue
      entry.retiring = true
      this.overlays.delete(displayId)
      this.overlayByWebContents.delete(entry.webContentsId)
      if (!entry.window.isDestroyed()) entry.window.destroy()
    }

    const activeEntries: OverlayEntry[] = []
    for (const display of displays) {
      const displayId = String(display.id)
      let entry = this.overlays.get(displayId)
      if (!entry) entry = this.createOverlay(display)
      else entry.window.setBounds(display.bounds, false)
      activeEntries.push(entry)
    }

    await waitWithTimeout(
      Promise.all(activeEntries.map((entry) => entry.ready.promise)),
      OVERLAY_READY_TIMEOUT_MS,
      t('截屏浮层初始化超时。')
    )
  }

  private createOverlay(display: Display): OverlayEntry {
    const displayId = String(display.id)
    const bounds = display.bounds
    const window = this.options.createWindow('capture', {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#080b09'
    })
    const entry: OverlayEntry = {
      displayId,
      webContentsId: window.webContents.id,
      window,
      ready: createDeferred(),
      retiring: false
    }

    setCaptureOverlayWindowLevel(window, false)
    window.setContentProtection(this.options.shouldProtectOverlayContent())
    this.overlays.set(displayId, entry)
    this.overlayByWebContents.set(window.webContents.id, entry)

    window.on('closed', () => {
      this.overlayByWebContents.delete(entry.webContentsId)
      if (this.overlays.get(displayId) === entry) this.overlays.delete(displayId)
      entry.ready.resolve()
      entry.sessionReady?.deferred.resolve()
      if (!entry.retiring && !this.disposed && this.session) void this.cancel()
    })

    return entry
  }

  private async presentSession(session: CaptureSession, displays: Display[]): Promise<void> {
    const presentations = displays.map((display) => {
      const displayId = String(display.id)
      const entry = this.overlays.get(displayId)
      const snapshot = session.snapshots.get(displayId)
      if (!entry || !snapshot) throw new Error(t('显示器 {0} 的截屏浮层不可用。', display.id))

      setCaptureOverlayWindowLevel(entry.window, false)
      entry.window.setBounds(display.bounds, false)
      entry.window.setIgnoreMouseEvents(false)
      const deferred = createDeferred()
      entry.sessionReady = { sessionId: session.id, deferred }
      const payload: CaptureOverlaySession = {
        sessionId: session.id,
        displayId,
        displayBoundsDip: asRectDip(display.bounds),
        scaleFactor: display.scaleFactor,
        canFakeGenerate: this.options.allowFakeGeneration,
        comfyUiWorkflowBindings: this.options.getComfyUiWorkflowBindings(),
        defaultGenerationOptions: this.options.getDefaultGenerationOptions(),
        screenshotPng: snapshot.image.toPNG(),
        ...(session.activeDisplayId ? { lockedDisplayId: session.activeDisplayId } : {}),
        ...(session.followUp?.selection.displayId === displayId
          ? {
              followUp: {
                action: session.followUp.action,
                selection: session.followUp.selection,
                currentImagePng: Buffer.from(session.followUp.currentImagePng)
              }
            }
          : {})
      }
      entry.window.webContents.send(IPC_CHANNELS.captureSessionStarted, payload)
      return { entry, ready: deferred.promise }
    })

    await waitWithTimeout(
      Promise.all(presentations.map(({ ready }) => ready)),
      SESSION_READY_TIMEOUT_MS,
      t('截屏画面加载超时。')
    )
    if (this.session !== session) return

    const entries = presentations.map(({ entry }) => entry)
    const focusedDisplayId = String(
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
    )
    const focusedEntry = (session.activeDisplayId
      ? this.overlays.get(session.activeDisplayId)
      : this.overlays.get(focusedDisplayId)) ?? entries[0]
    if (session.activeDisplayId && focusedEntry) {
      setCaptureOverlayWindowLevel(focusedEntry.window, true)
    }
    entries.forEach((entry) => {
      const locked = Boolean(session.activeDisplayId && entry.displayId !== session.activeDisplayId)
      entry.window.setIgnoreMouseEvents(locked)
      if (entry !== focusedEntry) entry.window.showInactive()
    })
    focusedEntry?.window.show()
    focusedEntry?.window.focus()
  }

  private finishSession(session: CaptureSession): void {
    if (this.session !== session) return
    this.phase = 'finishing'
    this.session = undefined
    session.comfyUiCapabilitiesController?.abort()

    for (const entry of this.overlays.values()) {
      if (!entry.window.isDestroyed()) {
        entry.window.hide()
        entry.window.setIgnoreMouseEvents(false)
        entry.window.webContents.send(IPC_CHANNELS.captureSessionEnded, session.id)
      }
      entry.sessionReady?.deferred.resolve()
      entry.sessionReady = undefined
    }
    session.hiddenWindows.forEach((window) => {
      if (!window.isDestroyed()) window.show()
    })
    session.snapshots.clear()
    session.hiddenWindows.length = 0
    this.phase = 'idle'

    if (!this.disposed) this.onDisplaysChanged()
  }

  private logTiming(
    workflowId: string,
    startedAtMs: number,
    event: string,
    details?: Record<string, string | number | boolean>
  ): void {
    this.options.onTiming?.({
      flow: 'capture',
      event,
      workflowId: workflowId.slice(0, 8),
      totalMs: elapsedTimingMs(startedAtMs),
      ...(details ? { details } : {})
    })
  }
}
