import { contextBridge, ipcRenderer } from 'electron'
import { languageSchema } from '../shared/language'
import {
  credentialTargetSchema,
  captureOverlaySessionSchema,
  captureSessionIdSchema,
  captureSelectionSchema,
  captureSubmissionModeSchema,
  captureOverlayProtectionSchema,
  comfyUiCapabilitiesSchema,
  comfyUiWorkflowDescriptorSchema,
  comfyUiWorkflowInspectInputSchema,
  comfyUiWorkflowListInputSchema,
  comfyUiWorkflowSummariesSchema,
  clickThroughSchema,
  connectionTestInputSchema,
  debugImagePathSchema,
  generationEffectChoiceSchema,
  generationRequestDraftSchema,
  generationRequestReviewSchema,
  connectionTestResultSchema,
  generatorPromptSchema,
  generationJobSnapshotSchema,
  imagePropertiesViewStateSchema,
  IPC_CHANNELS,
  jobIdSchema,
  publicSettingsSchema,
  previewProcessRequestSchema,
  previewViewStateSchema,
  resultVersionIdSchema,
  screenPointDipSchema,
  settingsUpdateSchema,
  type AppApi
} from '../shared/contracts'

const api: AppApi = {
  platform: process.platform,
  settings: {
    onLanguageChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
        callback(languageSchema.parse(value))
      }
      ipcRenderer.on(IPC_CHANNELS.settingsLanguageChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.settingsLanguageChanged, listener)
    },
    get: async () => publicSettingsSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.settingsGet)),
    update: async (update) => {
      const validated = settingsUpdateSchema.parse(update)
      return publicSettingsSchema.parse(
        await ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, validated)
      )
    },
    updateCaptureOverlayProtection: async (enabled) => publicSettingsSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.settingsUpdateCaptureOverlayProtection,
        captureOverlayProtectionSchema.parse(enabled)
      )
    ),
    clearCredential: async (target) => publicSettingsSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.settingsClearCredential,
        credentialTargetSchema.parse(target)
      )
    ),
    testConnection: async (input) => connectionTestResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.settingsTestConnection,
        connectionTestInputSchema.parse(input)
      )
    ),
    listComfyUiWorkflows: async (baseUrl) => comfyUiWorkflowSummariesSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.settingsListComfyUiWorkflows,
        comfyUiWorkflowListInputSchema.parse({ baseUrl })
      )
    ),
    inspectComfyUiWorkflow: async (baseUrl, workflowPath) =>
      comfyUiWorkflowDescriptorSchema.parse(
        await ipcRenderer.invoke(
          IPC_CHANNELS.settingsInspectComfyUiWorkflow,
          comfyUiWorkflowInspectInputSchema.parse({ baseUrl, workflowPath })
        )
      )
  },
  capture: {
    start: async () => ipcRenderer.invoke(IPC_CHANNELS.captureStart),
    notifyOverlayReady: async () => ipcRenderer.invoke(IPC_CHANNELS.captureOverlayReady),
    notifySessionReady: async (sessionId) => ipcRenderer.invoke(
      IPC_CHANNELS.captureSessionReady,
      captureSessionIdSchema.parse(sessionId)
    ),
    activate: async () => ipcRenderer.invoke(IPC_CHANNELS.captureActivate),
    getComfyUiCapabilities: async (sessionId) => comfyUiCapabilitiesSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.captureGetComfyUiCapabilities,
        captureSessionIdSchema.parse(sessionId)
      )
    ),
    submit: async (selection, mode = 'generate') => {
      const validated = captureSelectionSchema.parse(selection)
      await ipcRenderer.invoke(
        IPC_CHANNELS.captureSubmit,
        validated,
        captureSubmissionModeSchema.parse(mode)
      )
    },
    cancel: async () => ipcRenderer.invoke(IPC_CHANNELS.captureCancel),
    onSessionStarted: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, rawSession: unknown): void => {
        callback(captureOverlaySessionSchema.parse(rawSession))
      }
      ipcRenderer.on(IPC_CHANNELS.captureSessionStarted, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.captureSessionStarted, listener)
    },
    onSessionEnded: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, rawSessionId: unknown): void => {
        callback(captureSessionIdSchema.parse(rawSessionId))
      }
      ipcRenderer.on(IPC_CHANNELS.captureSessionEnded, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.captureSessionEnded, listener)
    },
    onLocked: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, displayId: string): void => {
        callback(displayId)
      }
      ipcRenderer.on(IPC_CHANNELS.captureLocked, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.captureLocked, listener)
    }
  },
  jobs: {
    list: async () => generationJobSnapshotSchema.array().parse(
      await ipcRenderer.invoke(IPC_CHANNELS.jobsList)
    ),
    get: async (id) => {
      const value = await ipcRenderer.invoke(IPC_CHANNELS.jobsGet, jobIdSchema.parse(id))
      return value === undefined ? undefined : generationJobSnapshotSchema.parse(value)
    },
    cancel: async (id) => ipcRenderer.invoke(IPC_CHANNELS.jobsCancel, jobIdSchema.parse(id)),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, rawJob: unknown): void => {
        callback(generationJobSnapshotSchema.parse(rawJob))
      }
      ipcRenderer.on(IPC_CHANNELS.jobsChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.jobsChanged, listener)
    }
  },
  preview: {
    getState: async (id) => previewViewStateSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.previewGetState, jobIdSchema.parse(id))
    ),
    startDrag: (id) => ipcRenderer.send(IPC_CHANNELS.previewStartDrag, jobIdSchema.parse(id)),
    startMoveDrag: (id, start) => ipcRenderer.send(
      IPC_CHANNELS.previewStartMoveDrag,
      jobIdSchema.parse(id),
      screenPointDipSchema.parse(start)
    ),
    moveDrag: (id, current) => ipcRenderer.send(
      IPC_CHANNELS.previewMoveDrag,
      jobIdSchema.parse(id),
      screenPointDipSchema.parse(current)
    ),
    endMoveDrag: (id) => ipcRenderer.send(
      IPC_CHANNELS.previewEndMoveDrag,
      jobIdSchema.parse(id)
    ),
    startCloneDrag: async (id, start, current) => ipcRenderer.invoke(
      IPC_CHANNELS.previewStartCloneDrag,
      jobIdSchema.parse(id),
      screenPointDipSchema.parse(start),
      screenPointDipSchema.parse(current)
    ),
    moveCloneDrag: (id, current) => ipcRenderer.send(
      IPC_CHANNELS.previewMoveCloneDrag,
      jobIdSchema.parse(id),
      screenPointDipSchema.parse(current)
    ),
    endCloneDrag: (id) => ipcRenderer.send(
      IPC_CHANNELS.previewEndCloneDrag,
      jobIdSchema.parse(id)
    ),
    copy: async (id) => ipcRenderer.invoke(IPC_CHANNELS.previewCopy, jobIdSchema.parse(id)),
    save: async (id) => ipcRenderer.invoke(IPC_CHANNELS.previewSave, jobIdSchema.parse(id)),
    openProperties: async (id) => ipcRenderer.invoke(
      IPC_CHANNELS.previewOpenProperties,
      jobIdSchema.parse(id)
    ),
    getProperties: async (id) => imagePropertiesViewStateSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.previewGetProperties, jobIdSchema.parse(id))
    ),
    applyVersion: async (id, versionId) => generationJobSnapshotSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.previewApplyVersion,
        jobIdSchema.parse(id),
        resultVersionIdSchema.parse(versionId)
      )
    ),
    saveVersion: async (id, versionId) => ipcRenderer.invoke(
      IPC_CHANNELS.previewSaveVersion,
      jobIdSchema.parse(id),
      resultVersionIdSchema.parse(versionId)
    ),
    openDetails: async (id) => ipcRenderer.invoke(
      IPC_CHANNELS.previewOpenDetails,
      jobIdSchema.parse(id)
    ),
    getGenerationReview: async (id, draft) => generationRequestReviewSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.previewGetGenerationReview,
        jobIdSchema.parse(id),
        generationRequestDraftSchema.parse(draft)
      )
    ),
    confirmGeneration: async (id, draft) => generationJobSnapshotSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.previewConfirmGeneration,
        jobIdSchema.parse(id),
        generationRequestDraftSchema.parse(draft)
      )
    ),
    regenerate: async (id, generatorPrompt) => generationJobSnapshotSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.previewRegenerate,
        jobIdSchema.parse(id),
        generatorPrompt === undefined ? undefined : generatorPromptSchema.parse(generatorPrompt)
      )
    ),
    process: async (id, request) => generationJobSnapshotSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.previewProcess,
        jobIdSchema.parse(id),
        previewProcessRequestSchema.parse(request)
      )
    ),
    setClickThrough: async (id, enabled) => ipcRenderer.invoke(
      IPC_CHANNELS.previewSetClickThrough,
      jobIdSchema.parse(id),
      clickThroughSchema.parse(enabled)
    ),
    showMenu: async (id) => ipcRenderer.invoke(IPC_CHANNELS.previewShowMenu, jobIdSchema.parse(id)),
    close: async (id) => ipcRenderer.invoke(IPC_CHANNELS.previewClose, jobIdSchema.parse(id)),
    onDetailsJobChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, rawId: unknown): void => {
        callback(jobIdSchema.parse(rawId))
      }
      ipcRenderer.on(IPC_CHANNELS.previewDetailsChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.previewDetailsChanged, listener)
    },
    onPropertiesJobChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, rawId: unknown): void => {
        callback(jobIdSchema.parse(rawId))
      }
      ipcRenderer.on(IPC_CHANNELS.previewPropertiesChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.previewPropertiesChanged, listener)
    }
  },
  debug: {
    chooseImage: async () => {
      const value = await ipcRenderer.invoke(IPC_CHANNELS.debugChooseImage)
      return value === undefined ? undefined : debugImagePathSchema.parse(value)
    },
    createPreview: async (imagePath, effectChoice) => {
      await ipcRenderer.invoke(
        IPC_CHANNELS.debugCreatePreview,
        debugImagePathSchema.parse(imagePath),
        effectChoice === undefined ? undefined : generationEffectChoiceSchema.parse(effectChoice)
      )
    }
  }
}

contextBridge.exposeInMainWorld('artCreator', api)
