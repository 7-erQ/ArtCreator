import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  Menu,
  nativeImage,
  type WebContents,
  type MenuItemConstructorOptions
} from 'electron'
import {
  DEFAULT_GENERATION_EFFECT_CHOICE,
  generationRequestDraftSchema,
  generatorPromptSchema,
  imagePropertiesViewStateSchema,
  IPC_CHANNELS,
  previewViewStateSchema,
  type GenerationEffectChoice,
  type GenerationJobSnapshot,
  type GenerationRequestDraft,
  type GenerationRequestReview,
  type ImagePropertiesViewState,
  type CaptureSelection,
  type PreviewProcessRequest,
  type PreviewViewState,
  type CaptureFollowUpAction,
  type RectDip,
  type ScreenPointDip
} from '../shared/contracts'
import { resolveCaptureRegions } from '../shared/capture-regions'
import { getImageModelDefinition, supportsImageGeneration } from '../shared/image-models'
import type { CaptureFollowUpRequest } from './capture-controller'
import { GenerationManager } from './generation-manager'
import { calculateImageLayout } from './image-layout'

interface PreviewInstance {
  window: BrowserWindow
  clickThrough: boolean
  imageFilePath?: string
}

interface CloneDrag {
  cloneId: string
  sender: WebContents
  sourceBounds: Electron.Rectangle
  start: ScreenPointDip
}

interface MoveDrag {
  sender: WebContents
  sourceBounds: Electron.Rectangle
  start: ScreenPointDip
}

interface PreviewControllerOptions {
  createWindow(
    view: string,
    options: Electron.BrowserWindowConstructorOptions,
    query?: Record<string, string>
  ): BrowserWindow
  generationManager: GenerationManager
  getGenerationEffectChoice?(): GenerationEffectChoice
  onStartCapture(): void
  onFollowUpCapture?(request: CaptureFollowUpRequest): void | Promise<void>
  onListChanged(): void
}

interface PreviewRenderOptions {
  effectChoice?: GenerationEffectChoice
  debugGenerationEffect?: boolean
}

function safeFileName(value: string): string {
  const sanitized = [...value.replace(/[<>:"/\\|?*]/g, '-')]
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
    .trim()
  return sanitized || 'generated-asset'
}

function pngDimensions(png: Buffer): { width: number; height: number } | undefined {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (
    png.length < 24 ||
    !png.subarray(0, 8).equals(signature) ||
    png.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return undefined
  }
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

export class PreviewController {
  private readonly instances = new Map<string, PreviewInstance>()
  private readonly moveDrags = new Map<string, MoveDrag>()
  private readonly cloneDrags = new Map<string, CloneDrag>()
  private readonly pendingCaptureBounds = new Map<string, RectDip>()
  private detailsWindow?: BrowserWindow
  private detailsJobId?: string
  private propertiesWindow?: BrowserWindow
  private propertiesJobId?: string
  private upscaleWindow?: BrowserWindow
  private upscaleJobId?: string

  constructor(private readonly options: PreviewControllerOptions) {}

  create(
    job: GenerationJobSnapshot,
    bounds: RectDip,
    renderOptions: PreviewRenderOptions = {}
  ): void {
    const width = Math.max(24, Math.round(bounds.width))
    const height = Math.max(24, Math.round(bounds.height))
    const effectChoice = renderOptions.effectChoice ??
      this.options.getGenerationEffectChoice?.() ??
      DEFAULT_GENERATION_EFFECT_CHOICE
    const window = this.options.createWindow('preview', {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width,
      height,
      minWidth: 24,
      minHeight: 24,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true
    }, {
      jobId: job.id,
      generationEffect: effectChoice,
      ...(renderOptions.debugGenerationEffect ? { debugGenerationEffect: '1' } : {})
    })
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setResizable(true)
    window.setAspectRatio(width / height)
    window.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width,
      height
    }, false)
    this.instances.set(job.id, { window, clickThrough: false })
    window.on('show', () => this.restoreStackingOrder())
    window.on('closed', () => {
      const instance = this.instances.get(job.id)
      if (instance?.window !== window) return
      this.instances.delete(job.id)
      this.moveDrags.delete(job.id)
      this.cloneDrags.delete(job.id)
      this.pendingCaptureBounds.delete(job.id)
      for (const [sourceId, drag] of this.cloneDrags) {
        if (drag.cloneId === job.id) this.cloneDrags.delete(sourceId)
      }
      this.removeReferencedImageFile(job.id, instance)
      if (this.detailsJobId === job.id) this.detailsWindow?.close()
      if (this.propertiesJobId === job.id) this.propertiesWindow?.close()
      if (this.upscaleJobId === job.id) this.upscaleWindow?.close()
      this.options.generationManager.remove(job.id)
      this.options.onListChanged()
    })
    this.options.onListChanged()
    if (job.status === 'awaiting_confirmation') this.openDetails(job.id)
  }

  createDebugPreview(
    png: Buffer,
    bounds: RectDip,
    assetName: string,
    effectChoice?: GenerationEffectChoice
  ): void {
    const job = this.options.generationManager.createDebugPreview(
      png,
      Math.max(1, Math.round(bounds.width)),
      Math.max(1, Math.round(bounds.height)),
      assetName
    )
    try {
      this.create(job, bounds, effectChoice
        ? { effectChoice, debugGenerationEffect: true }
        : undefined)
    } catch (error) {
      this.options.generationManager.remove(job.id)
      throw error
    }
  }

  getState(id: string): PreviewViewState {
    const entry = this.requireInstance(id)
    const job = this.options.generationManager.get(id)
    if (!job) throw new Error('Preview job no longer exists.')
    const result = this.options.generationManager.getResult(id)
    const placeholder = result ? undefined : this.options.generationManager.getPlaceholder(id)
    if (result) this.materializeReferencedImageFile(id, result)
    return previewViewStateSchema.parse({
      job,
      clickThrough: entry.clickThrough,
      ...this.options.generationManager.getAdjacentResultVersionIds(id),
      ...(result ? { imageDataUrl: `data:image/png;base64,${result.toString('base64')}` } : {}),
      ...(placeholder
        ? { placeholderDataUrl: `data:image/png;base64,${placeholder.toString('base64')}` }
        : {})
    })
  }

  shouldIncludeWindowInCapture(window: BrowserWindow): boolean {
    for (const [id, entry] of this.instances) {
      if (entry.window === window) return Boolean(this.options.generationManager.getResult(id))
    }
    return false
  }

  startDrag(id: string, sender: WebContents): void {
    const entry = this.requireInstance(id)
    if (sender !== entry.window.webContents) throw new Error('Drag must start from its preview window.')

    const result = this.requireResult(id)
    const filePath = this.materializeReferencedImageFile(id, result)
    sender.startDrag({ file: filePath, icon: nativeImage.createFromBuffer(result) })
  }

  startMoveDrag(id: string, sender: WebContents, start: ScreenPointDip): void {
    const entry = this.requireInstance(id)
    if (sender !== entry.window.webContents) {
      throw new Error('Move drag must start from its preview window.')
    }
    const sourceBounds = entry.window.getBounds()
    this.moveDrags.set(id, {
      sender,
      sourceBounds,
      start
    })
  }

  moveDrag(id: string, sender: WebContents, current: ScreenPointDip): void {
    const drag = this.moveDrags.get(id)
    if (!drag || drag.sender !== sender) throw new Error('Manual drag is not active.')
    const entry = this.requireInstance(id)
    entry.window.setBounds({
      x: Math.round(drag.sourceBounds.x + current.x - drag.start.x),
      y: Math.round(drag.sourceBounds.y + current.y - drag.start.y),
      width: drag.sourceBounds.width,
      height: drag.sourceBounds.height
    }, false)
  }

  endMoveDrag(id: string, sender: WebContents): void {
    const drag = this.moveDrags.get(id)
    if (!drag) return
    if (drag.sender !== sender) throw new Error('Move drag must end from its preview window.')
    this.moveDrags.delete(id)
  }

  startCloneDrag(
    id: string,
    sender: WebContents,
    start: ScreenPointDip,
    current: ScreenPointDip
  ): void {
    const source = this.requireInstance(id)
    if (sender !== source.window.webContents) {
      throw new Error('Clone drag must start from its preview window.')
    }

    const result = this.requireResult(id)
    const sourceFilePath = this.materializeReferencedImageFile(id, result)
    const sourceBounds = source.window.getBounds()
    const clone = this.options.generationManager.clone(id)
    let cloneCreated = false
    try {
      this.create(clone, {
        x: sourceBounds.x + current.x - start.x,
        y: sourceBounds.y + current.y - start.y,
        width: sourceBounds.width,
        height: sourceBounds.height
      })
      cloneCreated = true
      const cloneFilePath = this.referencedImageFilePath(clone.id)
      mkdirSync(dirname(cloneFilePath), { recursive: true })
      copyFileSync(sourceFilePath, cloneFilePath)
      this.requireInstance(clone.id).imageFilePath = cloneFilePath
      this.cloneDrags.set(id, { cloneId: clone.id, sender, sourceBounds, start })
    } catch (error) {
      if (cloneCreated) this.close(clone.id)
      else this.options.generationManager.remove(clone.id)
      throw error
    }
  }

  moveCloneDrag(id: string, sender: WebContents, current: ScreenPointDip): void {
    const drag = this.cloneDrags.get(id)
    if (!drag || drag.sender !== sender) throw new Error('Clone drag is not active.')
    const clone = this.requireInstance(drag.cloneId)
    clone.window.setPosition(
      Math.round(drag.sourceBounds.x + current.x - drag.start.x),
      Math.round(drag.sourceBounds.y + current.y - drag.start.y)
    )
  }

  endCloneDrag(id: string, sender: WebContents): void {
    const drag = this.cloneDrags.get(id)
    if (!drag) return
    if (drag.sender !== sender) throw new Error('Clone drag must end from its preview window.')
    this.cloneDrags.delete(id)
  }

  async copy(id: string): Promise<void> {
    const result = this.requireResult(id)
    const blob = new Blob([new Uint8Array(result)], { type: 'image/png' })
    await clipboard.write([new ClipboardItem({ 'image/png': blob })])
  }

  async save(id: string): Promise<boolean> {
    const entry = this.requireInstance(id)
    const result = this.requireResult(id)
    const job = this.options.generationManager.get(id)!
    const fileName = `${safeFileName(job.assetSpec?.assetName ?? 'generated-asset')}.png`
    return this.savePng(entry.window, result, fileName)
  }

  getProperties(id: string): ImagePropertiesViewState {
    this.requireInstance(id)
    const job = this.options.generationManager.get(id)
    if (!job) throw new Error('Preview job no longer exists.')
    const versions = this.options.generationManager.getResultVersions(id).map((version) => ({
      id: version.id,
      imageDataUrl: `data:image/png;base64,${version.png.toString('base64')}`,
      ...pngDimensions(version.png),
      sizeBytes: version.png.byteLength,
      background: version.background,
      action: version.action,
      ...(version.prompt ? { prompt: version.prompt } : {}),
      createdAt: version.createdAt
    }))
    return imagePropertiesViewStateSchema.parse({
      jobId: id,
      assetName: job.assetSpec?.assetName ?? '生成素材',
      versions,
      currentVersionId: this.options.generationManager.getCurrentResultVersionId(id),
      busy: job.status === 'processing_prompt' ||
        job.status === 'awaiting_confirmation' ||
        job.status === 'generating'
    })
  }

  openProperties(id: string): void {
    this.requireResult(id)
    if (this.propertiesWindow && !this.propertiesWindow.isDestroyed()) {
      this.propertiesJobId = id
      this.propertiesWindow.webContents.send(IPC_CHANNELS.previewPropertiesChanged, id)
      this.propertiesWindow.show()
      this.propertiesWindow.focus()
      return
    }

    this.propertiesJobId = id
    this.propertiesWindow = this.options.createWindow('properties', {
      title: '图片属性',
      width: 700,
      height: 760,
      minWidth: 560,
      minHeight: 620,
      backgroundColor: '#ece7dc',
      autoHideMenuBar: true,
      alwaysOnTop: true,
      frame: false
    }, { jobId: id })
    this.propertiesWindow.on('closed', () => {
      this.propertiesWindow = undefined
      this.propertiesJobId = undefined
    })
  }

  applyVersion(id: string, versionId: string): GenerationJobSnapshot {
    this.requireInstance(id)
    return this.options.generationManager.applyResultVersion(id, versionId)
  }

  async saveVersion(id: string, versionId: string): Promise<boolean> {
    const entry = this.requireInstance(id)
    const versions = this.options.generationManager.getResultVersions(id)
    const index = versions.findIndex((candidate) => candidate.id === versionId)
    if (index < 0) throw new Error('Image version no longer exists.')
    const job = this.options.generationManager.get(id)!
    const fileName = `${safeFileName(job.assetSpec?.assetName ?? 'generated-asset')}-v${index + 1}.png`
    const owner = this.propertiesJobId === id && this.propertiesWindow && !this.propertiesWindow.isDestroyed()
      ? this.propertiesWindow
      : entry.window
    return this.savePng(owner, versions[index]!.png, fileName)
  }

  openDetails(id: string): void {
    this.requireInstance(id)
    if (this.detailsWindow && !this.detailsWindow.isDestroyed()) {
      const previousJobId = this.detailsJobId
      if (previousJobId && previousJobId !== id &&
        this.options.generationManager.get(previousJobId)?.status === 'awaiting_confirmation') {
        this.options.generationManager.cancel(previousJobId)
      }
      this.detailsJobId = id
      this.detailsWindow.webContents.send(IPC_CHANNELS.previewDetailsChanged, id)
      this.detailsWindow.show()
      this.detailsWindow.focus()
      return
    }

    this.detailsJobId = id
    this.detailsWindow = this.options.createWindow('details', {
      title: '确认生成请求',
      width: 760,
      height: 760,
      minWidth: 560,
      minHeight: 620,
      backgroundColor: '#f3ecdc',
      frame: false
    }, { jobId: id })
    this.detailsWindow.on('closed', () => {
      const detailsJobId = this.detailsJobId
      this.detailsWindow = undefined
      this.detailsJobId = undefined
      if (detailsJobId && this.options.generationManager.get(detailsJobId)?.status === 'awaiting_confirmation') {
        this.options.generationManager.cancel(detailsJobId)
      }
    })
  }

  getGenerationReview(id: string, draft: GenerationRequestDraft): GenerationRequestReview {
    this.requireInstance(id)
    return this.options.generationManager.getGenerationReview(
      id,
      generationRequestDraftSchema.parse(draft)
    )
  }

  confirmGeneration(id: string, draft: GenerationRequestDraft): GenerationJobSnapshot {
    this.requireInstance(id)
    return this.options.generationManager.confirmGeneration(
      id,
      generationRequestDraftSchema.parse(draft)
    )
  }

  regenerate(id: string, generatorPrompt?: string): GenerationJobSnapshot {
    this.requireInstance(id)
    return this.options.generationManager.regenerate(
      id,
      generatorPrompt === undefined ? undefined : generatorPromptSchema.parse(generatorPrompt)
    )
  }

  async startFollowUp(id: string, action: CaptureFollowUpAction): Promise<void> {
    const entry = this.requireInstance(id)
    const job = this.options.generationManager.get(id)
    if (!job) throw new Error('Preview job no longer exists.')
    if (job.status === 'processing_prompt' || job.status === 'awaiting_confirmation' ||
      job.status === 'generating') {
      throw new Error('生成进行中，暂时无法继续操作。')
    }
    const currentImagePng = this.requireResult(id)
    if (!this.options.onFollowUpCapture) throw new Error('后续编辑功能暂不可用。')
    if (action === 'continue_edit' &&
      !supportsImageGeneration(job.selection.imageModel, 'reference')) {
      throw new Error('当前模型不支持参考生成，无法继续编辑。')
    }
    const screenshotPng = action === 'reconfigure'
      ? this.options.generationManager.getCaptureScreenshot(id)
      : undefined
    if (action === 'reconfigure' && !screenshotPng) throw new Error('原始截屏已不可用。')
    const selection: CaptureSelection = action === 'continue_edit'
      ? { ...job.selection, imageGeneration: 'reference' }
      : job.selection
    const baseRequest = {
      jobId: id,
      selection,
      currentImagePng,
      previewWindow: entry.window
    }
    const request: CaptureFollowUpRequest = action === 'reconfigure'
      ? { ...baseRequest, action, screenshotPng: screenshotPng! }
      : { ...baseRequest, action }
    await this.options.onFollowUpCapture(request)
  }

  applyCaptureUpdate(id: string, bounds: RectDip): void {
    this.requireInstance(id)
    const job = this.options.generationManager.get(id)
    if (job?.status === 'failed' || job?.status === 'canceled') return
    this.pendingCaptureBounds.set(id, { ...bounds })
  }

  process(id: string, request: PreviewProcessRequest): GenerationJobSnapshot {
    this.requireInstance(id)
    return this.options.generationManager.process(id, request)
  }

  openUpscaleDialog(id: string): void {
    const entry = this.requireInstance(id)
    this.requireResult(id)
    const job = this.options.generationManager.get(id)
    if (!job) throw new Error('Preview job no longer exists.')

    if (this.upscaleWindow && !this.upscaleWindow.isDestroyed()) {
      if (this.upscaleJobId === id) {
        this.upscaleWindow.show()
        this.upscaleWindow.focus()
        return
      }
      this.upscaleWindow.close()
    }

    const output = resolveCaptureRegions(job.selection).outputRectDip
    const suggested = calculateImageLayout(output.width, output.height)
    const upscaleWindow = this.options.createWindow('upscale', {
      title: '放大 / 改尺寸',
      width: 460,
      height: 300,
      parent: entry.window,
      modal: true,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#f3ecdc'
    }, {
      jobId: id,
      width: String(suggested.canvasWidth),
      height: String(suggested.canvasHeight)
    })
    this.upscaleWindow = upscaleWindow
    this.upscaleJobId = id
    upscaleWindow.on('closed', () => {
      if (this.upscaleWindow !== upscaleWindow) return
      this.upscaleWindow = undefined
      this.upscaleJobId = undefined
    })
  }

  setClickThrough(id: string, enabled: boolean): void {
    const entry = this.requireInstance(id)
    entry.clickThrough = enabled
    entry.window.setIgnoreMouseEvents(enabled)
    this.options.onListChanged()
  }

  showMenu(id: string): void {
    const entry = this.requireInstance(id)
    Menu.buildFromTemplate(this.previewActions(id)).popup({ window: entry.window })
  }

  close(id: string): void {
    const entry = this.instances.get(id)
    if (!entry) return
    this.moveDrags.delete(id)
    entry.window.destroy()
  }

  onJobChanged(job: GenerationJobSnapshot): void {
    if (!this.instances.has(job.id)) return
    const pendingBounds = this.pendingCaptureBounds.get(job.id)
    if (pendingBounds && (job.status === 'ready' || (job.generationProgress?.completed ?? 0) > 0)) {
      const entry = this.requireInstance(job.id)
      const width = Math.max(24, Math.round(pendingBounds.width))
      const height = Math.max(24, Math.round(pendingBounds.height))
      entry.window.setAspectRatio(width / height)
      entry.window.setBounds({
        x: Math.round(pendingBounds.x),
        y: Math.round(pendingBounds.y),
        width,
        height
      }, false)
      this.pendingCaptureBounds.delete(job.id)
    } else if (pendingBounds && (job.status === 'failed' || job.status === 'canceled')) {
      this.pendingCaptureBounds.delete(job.id)
    }
    const result = this.options.generationManager.getResult(job.id)
    if (result) this.materializeReferencedImageFile(job.id, result)
    if (job.status === 'awaiting_confirmation') this.openDetails(job.id)
    this.options.onListChanged()
  }

  getTrayMenuTemplate(): MenuItemConstructorOptions[] {
    return [...this.instances.keys()].map((id) => {
      const entry = this.instances.get(id)!
      const job = this.options.generationManager.get(id)
      const title = job?.assetSpec?.assetName ?? `生成任务 ${id.slice(0, 6)}`
      return {
        label: title,
        submenu: [
          {
            label: entry.clickThrough ? '恢复交互' : '显示预览',
            click: () => {
              this.setClickThrough(id, false)
              entry.window.show()
              entry.window.focus()
            }
          },
          { label: '关闭', click: () => this.close(id) }
        ]
      }
    })
  }

  dispose(): void {
    this.detailsWindow?.close()
    this.propertiesWindow?.close()
    this.upscaleWindow?.close()
    ;[...this.instances.values()].forEach((entry) => entry.window.close())
  }

  private restoreStackingOrder(): void {
    for (const entry of this.instances.values()) {
      if (!entry.window.isDestroyed() && entry.window.isVisible()) entry.window.moveTop()
    }
  }

  private previewActions(id: string): MenuItemConstructorOptions[] {
    const entry = this.requireInstance(id)
    const job = this.options.generationManager.get(id)
    const hasResult = Boolean(this.options.generationManager.getResult(id))
    const canRegenerate = Boolean(
      job?.assetSpec && job.status !== 'processing_prompt' &&
      job.status !== 'awaiting_confirmation' && job.status !== 'generating'
    )
    const capabilities = job ? getImageModelDefinition(job.selection.imageModel) : undefined
    const canProcess = Boolean(hasResult && canRegenerate && capabilities?.supportsEdit)
    const canCutout = Boolean(canProcess && capabilities?.supportsTransparency)
    const canReconfigure = Boolean(hasResult && job &&
      this.options.generationManager.getCaptureScreenshot(id) &&
      job.status !== 'processing_prompt' && job.status !== 'awaiting_confirmation' &&
      job.status !== 'generating')
    const canContinueEdit = Boolean(hasResult && job &&
      job.status !== 'processing_prompt' && job.status !== 'awaiting_confirmation' &&
      job.status !== 'generating' &&
      supportsImageGeneration(job.selection.imageModel, 'reference'))
    return [
      { label: '开始新截图', click: this.options.onStartCapture },
      {
        label: '重新配置…',
        enabled: canReconfigure,
        click: () => {
          void this.startFollowUp(id, 'reconfigure').catch((error) => dialog.showMessageBox(entry.window, {
            type: 'error',
            title: '无法重新配置',
            message: error instanceof Error ? error.message : '重新配置启动失败。'
          }))
        }
      },
      {
        label: '继续编辑',
        enabled: canContinueEdit,
        click: () => {
          void this.startFollowUp(id, 'continue_edit').catch((error) => dialog.showMessageBox(entry.window, {
            type: 'error',
            title: '无法继续编辑',
            message: error instanceof Error ? error.message : '继续编辑启动失败。'
          }))
        }
      },
      { type: 'separator' },
      { label: '复制图片', enabled: hasResult, click: () => void this.copy(id) },
      { label: '保存 PNG…', enabled: hasResult, click: () => void this.save(id) },
      { type: 'separator' },
      { label: '编辑提示词…', click: () => this.openDetails(id) },
      { label: '重新生成', enabled: canRegenerate, click: () => this.regenerate(id) },
      {
        label: '取消生成',
        enabled: job?.status === 'processing_prompt' || job?.status === 'generating' ||
          job?.status === 'awaiting_confirmation',
        click: () => this.options.generationManager.cancel(id)
      },
      { type: 'separator' },
      { label: '放大 / 改尺寸…', enabled: canProcess, click: () => this.openUpscaleDialog(id) },
      { label: '精细处理', enabled: canProcess, click: () => this.process(id, { action: 'refine' }) },
      { label: '抠图（实验）', enabled: canCutout, click: () => this.process(id, { action: 'cutout' }) },
      { type: 'separator' },
      { label: '属性…', enabled: hasResult, click: () => this.openProperties(id) },
      { type: 'separator' },
      {
        label: entry.clickThrough ? '恢复交互' : '启用鼠标穿透',
        click: () => this.setClickThrough(id, !entry.clickThrough)
      },
      { label: '关闭', click: () => this.close(id) }
    ]
  }

  private requireInstance(id: string): PreviewInstance {
    const entry = this.instances.get(id)
    if (!entry || entry.window.isDestroyed()) throw new Error('Preview does not exist.')
    return entry
  }

  private referencedImageFilePath(id: string): string {
    const job = this.options.generationManager.get(id)
    if (!job) throw new Error('Preview job no longer exists.')
    const fileName = `${safeFileName(job.assetSpec?.assetName ?? 'generated-asset')}.png`
    return join(app.getPath('temp'), 'art-creator-previews', id, fileName)
  }

  private materializeReferencedImageFile(id: string, png: Buffer): string {
    const instance = this.requireInstance(id)
    const filePath = this.referencedImageFilePath(id)
    if (instance.imageFilePath && instance.imageFilePath !== filePath) {
      rmSync(instance.imageFilePath, { force: true })
    }
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, png)
    instance.imageFilePath = filePath
    return filePath
  }

  private removeReferencedImageFile(id: string, instance: PreviewInstance): void {
    instance.imageFilePath = undefined
    rmSync(join(app.getPath('temp'), 'art-creator-previews', id), { recursive: true, force: true })
  }

  private async savePng(owner: BrowserWindow, png: Buffer, fileName: string): Promise<boolean> {
    const choice = await dialog.showSaveDialog(owner, {
      title: '保存生成素材',
      defaultPath: fileName,
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    })
    if (choice.canceled || !choice.filePath) return false
    await writeFile(choice.filePath, png)
    return true
  }

  private requireResult(id: string): Buffer {
    this.requireInstance(id)
    const result = this.options.generationManager.getResult(id)
    if (!result) throw new Error('Preview image is not ready.')
    return result
  }
}
