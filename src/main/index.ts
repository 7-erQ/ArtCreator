import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  safeStorage,
  screen,
  shell,
  Tray
} from 'electron'
import OpenAI from 'openai'
import { languageSchema, setLanguage, t, type Language } from '../shared/language'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import {
  credentialTargetSchema,
  captureOverlayProtectionSchema,
  IPC_CHANNELS,
  clickThroughSchema,
  comfyUiWorkflowInspectInputSchema,
  comfyUiWorkflowListInputSchema,
  connectionTestInputSchema,
  debugImagePathSchema,
  generationEffectChoiceSchema,
  generationRequestDraftSchema,
  jobIdSchema,
  previewProcessRequestSchema,
  resultVersionIdSchema,
  screenPointDipSchema,
  settingsUpdateSchema,
  type ConnectionTestResult,
  type GenerationJobSnapshot,
  type GenerationRequestReview,
  type ImageModelSelection,
  type PublicSettings,
} from '../shared/contracts'
import { SettingsStore } from './settings-store'
import { ShortcutManager } from './shortcut-manager'
import { CaptureController } from './capture-controller'
import {
  GenerationManager,
  type ImageGeneratorConfiguration
} from './generation-manager'
import { normalizeGeneratedImage } from './image-normalizer'
import {
  OpenAIImageGenerator,
  OpenAIPromptPolisher
} from './openai-asset-generator'
import { IMAGE_REQUEST_TIMEOUT_MS, type ImageGenerator } from './image-generator'
import { LiblibImageGenerator } from './liblib-image-generator'
import {
  ComfyUiImageGenerator,
  ComfyUiWorkflowImageGenerator,
  getComfyUiCapabilities,
  listComfyUiWorkflows
} from './comfyui-image-generator'
import { BrowserComfyUiWorkflowConverter } from './comfyui-workflow-converter'
import { PreviewController } from './preview-controller'
import { testApiConnection } from './connection-test'
import { createProviderFetch } from './provider-fetch'
import { compressScreenshot } from './screenshot-compressor'
import { configureDisplayCaptureColorProfile } from './display-capture'
import { configurePortableStorage } from './portable-storage'
import {
  createApplicationLogger,
  elapsedTimingMs,
  timingNow
} from './application-logger'

configureDisplayCaptureColorProfile(process.platform, app.commandLine)

try {
  configurePortableStorage(app)
} catch {
  dialog.showErrorBox('Art Creator 启动失败', '无法初始化本地数据目录。请将程序完整解压到可写目录后重新启动。')
  app.exit(1)
}

let tray: Tray | undefined
let settingsWindow: BrowserWindow | undefined
let debugWindow: BrowserWindow | undefined
let hotkeyError: string | undefined
let captureController: CaptureController | undefined
let generationManager: GenerationManager | undefined
let previewController: PreviewController | undefined
const currentDirectory = dirname(fileURLToPath(import.meta.url))
const applicationStartedAtMs = timingNow()
const applicationLogger = createApplicationLogger({
  isRelease: app.isPackaged,
  directory: app.getPath('logs')
})
const timing = applicationLogger.timing
const providerFetch = createProviderFetch((input, init) =>
  net.fetch(input instanceof URL ? input.href : input, init))
const comfyUiWorkflowConverter = new BrowserComfyUiWorkflowConverter()

const settingsStore = new SettingsStore(join(app.getPath('userData'), 'settings.json'), safeStorage)
const shortcutManager = new ShortcutManager()

function runtimeAssetPath(fileName: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'assets', fileName)
    : join(currentDirectory, '../../resources', fileName)
}

async function openLogDirectory(): Promise<void> {
  const directory = applicationLogger.directory
  try {
    await applicationLogger.flush()
    const failure = await shell.openPath(directory)
    if (failure) applicationLogger.error('log_directory_open_failed')
  } catch (error) {
    applicationLogger.unexpected('log_directory_open_failed', error)
  }
}

function createWindow(
  view: string,
  options: Electron.BrowserWindowConstructorOptions,
  query: Record<string, string> = {},
  showOnReady = true
): BrowserWindow {
  const startedAtMs = timingNow()
  const window = new BrowserWindow({
    ...(process.platform === 'darwin' ? {} : { icon: runtimeAssetPath('app-icon.png') }),
    ...options,
    show: false,
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  updateWindowTitle(window, view)

  window.webContents.once('did-finish-load', () => {
    updateWindowTitle(window, view)
    timing({
      flow: 'application',
      event: 'window_loaded',
      stageMs: elapsedTimingMs(startedAtMs),
      details: { view }
    })
  })
  if (showOnReady) {
    window.once('ready-to-show', () => {
      window.show()
      timing({
        flow: 'application',
        event: 'window_visible',
        stageMs: elapsedTimingMs(startedAtMs),
        details: { view }
      })
    })
  }
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.searchParams.set('view', view)
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value))
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(join(currentDirectory, '../renderer/index.html'), { query: { view, ...query } })
  }
  return window
}

function showSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }

  settingsWindow = createWindow('settings', {
    width: 620,
    height: 840,
    minWidth: 520,
    minHeight: 620,
    backgroundColor: '#f3ecdc'
  })
  refreshSettingsMenu()
  settingsWindow.on('closed', () => {
    settingsWindow = undefined
  })
}

function refreshSettingsMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      id: 'edit-menu',
      role: 'editMenu',
      label: t('编辑'),
      submenu: [
        { id: 'edit-undo', role: 'undo', label: t('撤销') },
        { id: 'edit-redo', role: 'redo', label: t('重做') },
        { type: 'separator' },
        { id: 'edit-cut', role: 'cut', label: t('剪切') },
        { id: 'edit-copy', role: 'copy', label: t('复制') },
        { id: 'edit-paste', role: 'paste', label: t('粘贴') },
        { type: 'separator' },
        { id: 'edit-select-all', role: 'selectAll', label: t('全选') }
      ]
    },
    {
      label: t('工具'),
      submenu: [{ id: 'open-debug-panel', label: t('调试面板'), click: showDebugPanel }]
    },
    {
      id: 'language-menu',
      label: 'Language',
      submenu: [
        {
          id: 'language-zh-CN', label: '简体中文', type: 'radio',
          checked: settingsStore.getLanguage() === 'zh-CN',
          click: () => void changeLanguage('zh-CN')
        },
        {
          id: 'language-en', label: 'English', type: 'radio',
          checked: settingsStore.getLanguage() === 'en',
          click: () => void changeLanguage('en')
        }
      ]
    }
  ])
  settingsWindow?.setMenu(menu)
  Menu.setApplicationMenu(menu)
}

function updateWindowTitle(window: BrowserWindow, view: string): void {
  const titles: Record<string, string> = {
    settings: 'Art Creator 设置',
    debug: 'Art Creator 调试',
    properties: '图片属性',
    details: '确认生成请求',
    upscale: '放大 / 改尺寸'
  }
  const title = titles[view]
  if (title) window.setTitle(t(title))
}

async function changeLanguage(rawLanguage: Language): Promise<void> {
  const language = languageSchema.parse(rawLanguage)
  try {
    await settingsStore.updateLanguage(language)
    setLanguage(language)
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.settingsLanguageChanged, language)
        const url = window.webContents.getURL()
        const view = url ? new URL(url).searchParams.get('view') : undefined
        if (view) updateWindowTitle(window, view)
      }
    })
    refreshSettingsMenu()
    refreshTray()
  } catch (error) {
    refreshSettingsMenu()
    applicationLogger.unexpected('language_save_failed', error)
    dialog.showErrorBox(t('语言切换失败'), t('无法保存语言设置，请检查本地数据目录是否可写。'))
  }
}

function showDebugPanel(): void {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.show()
    debugWindow.focus()
    return
  }

  debugWindow = createWindow('debug', {
    width: 620,
    height: 520,
    minWidth: 520,
    minHeight: 420,
    backgroundColor: '#f3ecdc',
    autoHideMenuBar: true
  })
  debugWindow.on('closed', () => {
    debugWindow = undefined
  })
}

function onCaptureShortcut(): void {
  void captureController?.start()
}

function registerConfiguredShortcut(accelerator: string): boolean {
  const registered = shortcutManager.register(accelerator, onCaptureShortcut)
  hotkeyError = registered ? undefined : t('快捷键 {0} 已被其他应用占用。', accelerator)
  return registered
}

function refreshTray(): void {
  if (!tray) return
  const previews = previewController?.getTrayMenuTemplate() ?? []
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('开始截图生成'), click: onCaptureShortcut },
      { label: t('设置'), click: showSettings },
      {
        label: t('置顶预览'),
        submenu: previews.length > 0 ? previews : [{ label: t('暂无预览'), enabled: false }]
      },
      { id: 'open-log-directory', label: t('打开日志目录'), click: () => void openLogDirectory() },
      { type: 'separator' },
      { label: t('退出'), click: () => app.quit() }
    ])
  )
}

function createTray(): void {
  const icon = nativeImage.createFromPath(runtimeAssetPath(
    process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'
  ))
  if (icon.isEmpty()) throw new Error('Tray icon asset is missing.')
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Art Creator')
  tray.on('click', showSettings)
  refreshTray()
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.settingsGet, (): PublicSettings => settingsStore.getPublic(hotkeyError))
  ipcMain.handle(IPC_CHANNELS.settingsUpdate, async (_event, rawUpdate: unknown): Promise<PublicSettings> => {
    const update = settingsUpdateSchema.parse(rawUpdate)
    const oldHotkey = settingsStore.getHotkey()

    if (update.hotkey !== oldHotkey && !registerConfiguredShortcut(update.hotkey)) {
      return settingsStore.getPublic(hotkeyError)
    }

    try {
      await settingsStore.update(update)
    } catch (error) {
      if (update.hotkey !== oldHotkey) registerConfiguredShortcut(oldHotkey)
      throw error
    }

    hotkeyError = undefined
    refreshTray()
    return settingsStore.getPublic()
  })
  ipcMain.handle(
    IPC_CHANNELS.settingsUpdateCaptureOverlayProtection,
    async (_event, rawEnabled: unknown): Promise<PublicSettings> => {
      const enabled = captureOverlayProtectionSchema.parse(rawEnabled)
      await settingsStore.updateCaptureOverlayProtection(enabled)
      captureController?.refreshOverlayContentProtection()
      return settingsStore.getPublic(hotkeyError)
    }
  )
  ipcMain.handle(
    IPC_CHANNELS.settingsClearCredential,
    async (_event, rawTarget: unknown): Promise<PublicSettings> => {
      await settingsStore.clearCredential(credentialTargetSchema.parse(rawTarget))
      refreshTray()
      return settingsStore.getPublic(hotkeyError)
    }
  )
  ipcMain.handle(
    IPC_CHANNELS.settingsTestConnection,
    async (_event, rawInput: unknown): Promise<ConnectionTestResult> => {
      const validation = connectionTestInputSchema.safeParse(rawInput)
      if (!validation.success) {
        return { ok: false, message: t('测试配置无效，请检查填写内容。') }
      }
      try {
        return testApiConnection(
          validation.data,
          {
            textApiKey: settingsStore.getTextApiKey(),
            openaiImageApiKey: settingsStore.getOpenAIImageApiKey(),
            liblibAccessKey: settingsStore.getLiblibAccessKey(),
            liblibSecretKey: settingsStore.getLiblibSecretKey()
          },
          providerFetch,
          (diagnostic) => applicationLogger.diagnostic(
            'connection_test_failed',
            {
              target: diagnostic.target,
              status: diagnostic.status,
              errorName: diagnostic.errorName
            },
            diagnostic
          ),
          !app.isPackaged
        )
      } catch {
        return { ok: false, message: t('无法读取已保存的 API Key，请重新输入后测试。') }
      }
    }
  )
  ipcMain.handle(IPC_CHANNELS.settingsListComfyUiWorkflows, async (
    _event,
    rawInput: unknown
  ) => {
    const input = comfyUiWorkflowListInputSchema.parse(rawInput)
    return listComfyUiWorkflows(
      { baseUrl: input.baseUrl },
      providerFetch,
      AbortSignal.timeout(10_000)
    )
  })
  ipcMain.handle(IPC_CHANNELS.settingsInspectComfyUiWorkflow, async (
    _event,
    rawInput: unknown
  ) => {
    const input = comfyUiWorkflowInspectInputSchema.parse(rawInput)
    return comfyUiWorkflowConverter.inspect(
      input.baseUrl,
      input.workflowPath,
      AbortSignal.timeout(30_000)
    )
  })
  ipcMain.handle(IPC_CHANNELS.debugChooseImage, async (event): Promise<string | undefined> => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? settingsWindow
    const options: Electron.OpenDialogOptions = {
      title: t('选择调试图片'),
      properties: ['openFile'],
      filters: [{ name: t('图片'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    }
    const choice = owner && !owner.isDestroyed()
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    return choice.canceled ? undefined : choice.filePaths[0]
  })
  ipcMain.handle(IPC_CHANNELS.debugCreatePreview, (
    _event,
    rawPath: unknown,
    rawEffectChoice: unknown
  ): void => {
    const imagePath = debugImagePathSchema.parse(rawPath)
    const effectChoice = rawEffectChoice === undefined
      ? undefined
      : generationEffectChoiceSchema.parse(rawEffectChoice)
    if (!generationManager || !previewController) throw new Error(t('调试预览暂不可用。'))
    const image = nativeImage.createFromPath(imagePath)
    if (image.isEmpty()) throw new Error(t('无法读取指定图片，请确认文件存在且格式受支持。'))

    const size = image.getSize()
    const display = screen.getPrimaryDisplay()
    const scaleFactor = display.scaleFactor || 1
    const naturalWidth = Math.max(1, Math.round(size.width / scaleFactor))
    const naturalHeight = Math.max(1, Math.round(size.height / scaleFactor))
    const maxWidth = Math.max(24, Math.floor(display.workArea.width * 0.6))
    const maxHeight = Math.max(24, Math.floor(display.workArea.height * 0.6))
    const scale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight)
    const width = Math.max(24, Math.round(naturalWidth * scale))
    const height = Math.max(24, Math.round(naturalHeight * scale))
    previewController.createDebugPreview(image.toPNG(), {
      x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
      width,
      height
    }, basename(imagePath, extname(imagePath)) || t('调试图片'), effectChoice)
  })
  ipcMain.handle(IPC_CHANNELS.jobsList, (): GenerationJobSnapshot[] => generationManager?.list() ?? [])
  ipcMain.handle(IPC_CHANNELS.jobsGet, (_event, rawId: unknown) =>
    generationManager?.get(jobIdSchema.parse(rawId)))
  ipcMain.handle(IPC_CHANNELS.jobsCancel, (_event, rawId: unknown): void => {
    generationManager?.cancel(jobIdSchema.parse(rawId))
  })
  ipcMain.handle(IPC_CHANNELS.previewGetState, (_event, rawId: unknown) =>
    previewController?.getState(jobIdSchema.parse(rawId)))
  ipcMain.on(IPC_CHANNELS.previewStartDrag, (event, rawId: unknown): void => {
    try {
      previewController?.startDrag(jobIdSchema.parse(rawId), event.sender)
    } catch (error) {
      applicationLogger.unexpected('preview_file_drag_start_failed', error)
    }
  })
  ipcMain.on(
    IPC_CHANNELS.previewStartMoveDrag,
    (event, rawId: unknown, rawStart: unknown): void => {
      try {
        if (!previewController) throw new Error('Preview controller is unavailable.')
        previewController.startMoveDrag(
          jobIdSchema.parse(rawId),
          event.sender,
          screenPointDipSchema.parse(rawStart)
        )
      } catch (error) {
        applicationLogger.unexpected('preview_move_start_failed', error)
      }
    }
  )
  ipcMain.on(IPC_CHANNELS.previewMoveDrag, (event, rawId: unknown, rawCurrent: unknown): void => {
    try {
      previewController?.moveDrag(
        jobIdSchema.parse(rawId),
        event.sender,
        screenPointDipSchema.parse(rawCurrent)
      )
    } catch (error) {
      applicationLogger.unexpected('preview_move_failed', error)
    }
  })
  ipcMain.on(IPC_CHANNELS.previewEndMoveDrag, (event, rawId: unknown): void => {
    try {
      previewController?.endMoveDrag(jobIdSchema.parse(rawId), event.sender)
    } catch (error) {
      applicationLogger.unexpected('preview_move_finish_failed', error)
    }
  })
  ipcMain.handle(
    IPC_CHANNELS.previewStartCloneDrag,
    (event, rawId: unknown, rawStart: unknown, rawCurrent: unknown): void => {
      if (!previewController) throw new Error('Preview controller is unavailable.')
      previewController.startCloneDrag(
        jobIdSchema.parse(rawId),
        event.sender,
        screenPointDipSchema.parse(rawStart),
        screenPointDipSchema.parse(rawCurrent)
      )
    }
  )
  ipcMain.on(IPC_CHANNELS.previewMoveCloneDrag, (event, rawId: unknown, rawCurrent: unknown): void => {
    try {
      previewController?.moveCloneDrag(
        jobIdSchema.parse(rawId),
        event.sender,
        screenPointDipSchema.parse(rawCurrent)
      )
    } catch (error) {
      applicationLogger.unexpected('preview_clone_move_failed', error)
    }
  })
  ipcMain.on(IPC_CHANNELS.previewEndCloneDrag, (event, rawId: unknown): void => {
    try {
      previewController?.endCloneDrag(jobIdSchema.parse(rawId), event.sender)
    } catch (error) {
      applicationLogger.unexpected('preview_clone_move_finish_failed', error)
    }
  })
  ipcMain.handle(IPC_CHANNELS.previewCopy, (_event, rawId: unknown): Promise<void> | undefined =>
    previewController?.copy(jobIdSchema.parse(rawId)))
  ipcMain.handle(IPC_CHANNELS.previewSave, (_event, rawId: unknown): Promise<boolean> =>
    previewController?.save(jobIdSchema.parse(rawId)) ?? Promise.resolve(false))
  ipcMain.handle(IPC_CHANNELS.previewOpenProperties, (_event, rawId: unknown): void =>
    previewController?.openProperties(jobIdSchema.parse(rawId)))
  ipcMain.handle(IPC_CHANNELS.previewGetProperties, (_event, rawId: unknown) =>
    previewController?.getProperties(jobIdSchema.parse(rawId)))
  ipcMain.handle(
    IPC_CHANNELS.previewApplyVersion,
    (_event, rawId: unknown, rawVersionId: unknown): GenerationJobSnapshot => {
      if (!previewController) throw new Error('Preview controller is unavailable.')
      return previewController.applyVersion(
        jobIdSchema.parse(rawId),
        resultVersionIdSchema.parse(rawVersionId)
      )
    }
  )
  ipcMain.handle(
    IPC_CHANNELS.previewSaveVersion,
    (_event, rawId: unknown, rawVersionId: unknown): Promise<boolean> =>
      previewController?.saveVersion(
        jobIdSchema.parse(rawId),
        resultVersionIdSchema.parse(rawVersionId)
      ) ?? Promise.resolve(false)
  )
  ipcMain.handle(IPC_CHANNELS.previewOpenDetails, (_event, rawId: unknown): void =>
    previewController?.openDetails(jobIdSchema.parse(rawId)))
  ipcMain.handle(
    IPC_CHANNELS.previewGetGenerationReview,
    (_event, rawId: unknown, rawDraft: unknown): GenerationRequestReview => {
      if (!previewController) throw new Error('Preview controller is unavailable.')
      return previewController.getGenerationReview(
        jobIdSchema.parse(rawId),
        generationRequestDraftSchema.parse(rawDraft)
      )
    }
  )
  ipcMain.handle(
    IPC_CHANNELS.previewConfirmGeneration,
    (_event, rawId: unknown, rawDraft: unknown): GenerationJobSnapshot => {
      if (!previewController) throw new Error('Preview controller is unavailable.')
      return previewController.confirmGeneration(
        jobIdSchema.parse(rawId),
        generationRequestDraftSchema.parse(rawDraft)
      )
    }
  )
  ipcMain.handle(
    IPC_CHANNELS.previewRegenerate,
    (_event, rawId: unknown, generatorPrompt?: unknown): GenerationJobSnapshot => {
      const id = jobIdSchema.parse(rawId)
      if (generatorPrompt !== undefined && typeof generatorPrompt !== 'string') {
        throw new Error('Generator prompt must be a string.')
      }
      if (!previewController) throw new Error('Preview controller is unavailable.')
      return previewController.regenerate(id, generatorPrompt)
    }
  )
  ipcMain.handle(
    IPC_CHANNELS.previewProcess,
    (_event, rawId: unknown, rawRequest: unknown): GenerationJobSnapshot => {
      if (!previewController) throw new Error('Preview controller is unavailable.')
      return previewController.process(
        jobIdSchema.parse(rawId),
        previewProcessRequestSchema.parse(rawRequest)
      )
    }
  )
  ipcMain.handle(
    IPC_CHANNELS.previewSetClickThrough,
    (_event, rawId: unknown, rawEnabled: unknown): void =>
      previewController?.setClickThrough(
        jobIdSchema.parse(rawId),
        clickThroughSchema.parse(rawEnabled)
      )
  )
  ipcMain.handle(IPC_CHANNELS.previewShowMenu, (_event, rawId: unknown): void =>
    previewController?.showMenu(jobIdSchema.parse(rawId)))
  ipcMain.handle(IPC_CHANNELS.previewClose, (_event, rawId: unknown): void =>
    previewController?.close(jobIdSchema.parse(rawId)))
}

function broadcastJob(job: GenerationJobSnapshot): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.jobsChanged, job)
  })
  previewController?.onJobChanged(job)
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  applicationLogger.info('application_started', {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  })
  app.on('second-instance', () => {
    applicationLogger.info('second_instance_activated')
    showSettings()
  })
  app.on('render-process-gone', (_event, webContents, details) => {
    if (details.reason === 'clean-exit') return
    applicationLogger.error('render_process_gone', {
      webContentsId: webContents.id,
      reason: details.reason,
      exitCode: details.exitCode
    })
  })
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    applicationLogger.error('child_process_gone', {
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode
    })
  })

  void app.whenReady().then(async () => {
    timing({
      flow: 'application',
      event: 'electron_ready',
      totalMs: elapsedTimingMs(applicationStartedAtMs)
    })
    electronApp.setAppUserModelId('com.artcreator.desktop')
    if (process.platform === 'darwin') app.dock?.setIcon(runtimeAssetPath('app-icon.png'))
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    await settingsStore.load()
    setLanguage(settingsStore.getLanguage())
    generationManager = new GenerationManager({
      createPromptPolisher: () => {
        const connection = settingsStore.getTextApiConnection()
        if (!connection) return undefined
        return new OpenAIPromptPolisher(
          new OpenAI({
            apiKey: connection.apiKey,
            baseURL: connection.baseUrl,
            maxRetries: 0,
            fetch: providerFetch
          }),
          connection.model,
          (sourcePng) => compressScreenshot(sourcePng, settingsStore.getScreenshotCompression())
        )
      },
      createImageGenerator: (
        selection: ImageModelSelection,
        configuration?: ImageGeneratorConfiguration
      ): ImageGenerator | undefined => {
        if (selection.provider === 'liblib') {
          const connection = settingsStore.getLiblibApiConnection()
          return connection
              ? new LiblibImageGenerator(connection, selection.model, {
                requestFetch: providerFetch,
                generationOptions: configuration?.liblibGenerationOptions
              })
            : undefined
        }
        if (selection.provider === 'comfyui') {
          if ('workflowPath' in selection) {
            const binding = configuration?.comfyUiWorkflowBinding
            if (!binding || binding.workflowPath !== selection.workflowPath) return undefined
            return new ComfyUiWorkflowImageGenerator(
              settingsStore.getComfyUiConnection(),
              {
                requestFetch: providerFetch,
                converter: comfyUiWorkflowConverter,
                binding,
                seed: configuration?.comfyUiWorkflowSeed
              }
            )
          }
          const generationOptions = configuration?.comfyUiGenerationOptions
          if (!generationOptions) return undefined
          return new ComfyUiImageGenerator(
            settingsStore.getComfyUiConnection(),
            selection.model,
            { requestFetch: providerFetch, generationOptions }
          )
        }
        const connection = settingsStore.getOpenAIImageApiConnection()
        return connection
          ? new OpenAIImageGenerator(
              new OpenAI({
                apiKey: connection.apiKey,
                baseURL: connection.baseUrl,
                timeout: IMAGE_REQUEST_TIMEOUT_MS,
                maxRetries: 0,
                fetch: providerFetch
              }),
              selection.model,
              providerFetch
            )
          : undefined
      },
      normalizeImage: normalizeGeneratedImage,
      onChanged: broadcastJob,
      onRequestFailed: (diagnostic) => applicationLogger.diagnostic(
        'generation_request_failed',
        {
          stage: diagnostic.stage,
          status: diagnostic.status,
          code: diagnostic.code,
          type: diagnostic.type,
          param: diagnostic.param,
          reason: diagnostic.reason,
          requestId: diagnostic.requestId
        },
        diagnostic
      ),
      onTiming: timing,
      includeDevelopmentDiagnostics: !app.isPackaged
    })
    previewController = new PreviewController({
      createWindow,
      generationManager,
      getGenerationEffectChoice: () => settingsStore.getGenerationEffectChoice(),
      onStartCapture: onCaptureShortcut,
      onFollowUpCapture: (request) => captureController?.startFollowUp(request),
      onListChanged: refreshTray
    })
    captureController = new CaptureController({
      createWindow: (view, options) => createWindow(view, options, {}, false),
      shouldIncludeWindowInCapture: (window) =>
        previewController?.shouldIncludeWindowInCapture(window) ?? false,
      shouldProtectOverlayContent: () => settingsStore.getCaptureOverlayProtection(),
      getDefaultGenerationOptions: () => settingsStore.getLastGenerationOptions(),
      getComfyUiWorkflowBindings: () => settingsStore.getComfyUiWorkflowBindings(),
      persistLastGenerationOptions: (options) => settingsStore.updateLastGenerationOptions(options),
      loadComfyUiCapabilities: (signal) => getComfyUiCapabilities(
        settingsStore.getComfyUiConnection(),
        providerFetch,
        signal
      ),
      allowFakeGeneration: !app.isPackaged,
      onSubmitted: (capture) => {
        if (!generationManager || !previewController) return
        if (capture.followUp) {
          generationManager.applyCaptureUpdate(
            capture.followUp.jobId,
            capture,
            settingsStore.getPreviewMaxEdge()
          )
          previewController.applyCaptureUpdate(
            capture.followUp.jobId,
            capture.globalOutputRectDip
          )
          return
        }
        const job = generationManager.start(capture, settingsStore.getPreviewMaxEdge())
        previewController.create(job, capture.globalOutputRectDip)
      },
      onTiming: timing,
      onUnexpectedError: (event, error) => applicationLogger.unexpected(event, error)
    })
    registerConfiguredShortcut(settingsStore.getHotkey())
    registerIpc()
    createTray()

    const publicSettings = settingsStore.getPublic()
    if (!publicSettings.hasTextApiKey ||
      (!publicSettings.hasOpenaiImageApiKey && !publicSettings.hasLiblibCredentials)) {
      showSettings()
    }
    try {
      await captureController.initialize()
      timing({
        flow: 'application',
        event: 'application_ready',
        totalMs: elapsedTimingMs(applicationStartedAtMs)
      })
    } catch (error) {
      applicationLogger.unexpected('capture_overlays_initialize_failed', error)
    }
  }).catch((error: unknown) => {
    applicationLogger.unexpected('application_initialize_failed', error)
  })

  app.on('activate', showSettings)
  app.on('window-all-closed', () => undefined)
  let quitFinalizing = false
  app.on('before-quit', (event) => {
    if (quitFinalizing) return
    event.preventDefault()
    quitFinalizing = true
    captureController?.dispose()
    previewController?.dispose()
    generationManager?.dispose()
    comfyUiWorkflowConverter.dispose()
    shortcutManager.dispose()
    applicationLogger.info('application_quitting')
    void applicationLogger.close().finally(() => app.quit())
  })
}
