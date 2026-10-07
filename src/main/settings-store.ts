import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  apiBaseUrlSchema,
  comfyUiBaseUrlSchema,
  comfyUiWorkflowSelection,
  comfyUiWorkflowBindingsSchema,
  captureOverlayProtectionSchema,
  credentialTargetSchema,
  DEFAULT_CAPTURE_OVERLAY_PROTECTION,
  DEFAULT_COMFYUI_BASE_URL,
  DEFAULT_GENERATION_EFFECT_CHOICE,
  DEFAULT_HOTKEY,
  DEFAULT_IMAGE_MODEL_SELECTION,
  DEFAULT_LIBLIB_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_PREVIEW_MAX_EDGE,
  DEFAULT_SCREENSHOT_COMPRESSION,
  DEFAULT_TEXT_MODEL,
  generationEffectChoiceSchema,
  generationOptionsSchema,
  defaultGenerationOptions,
  imageModelSelectionSchema,
  previewMaxEdgeSchema,
  screenshotCompressionSchema,
  textModelSchema,
  type CredentialTarget,
  type ComfyUiWorkflowBinding,
  type GenerationEffectChoice,
  type GenerationOptions,
  type PublicSettings,
  type ScreenshotCompression,
  type SettingsUpdate
} from '../shared/contracts'

const legacyPersistedSettingsSchema = z.object({
  version: z.literal(1),
  hotkey: z.string().min(1),
  encryptedApiKey: z.string().optional()
})

const persistedSettingsV2Schema = z.object({
  version: z.literal(2),
  hotkey: z.string().min(1),
  textBaseUrl: apiBaseUrlSchema,
  imageBaseUrl: apiBaseUrlSchema,
  encryptedTextApiKey: z.string().optional(),
  encryptedImageApiKey: z.string().optional()
})

const persistedSettingsV3Schema = z.object({
  version: z.literal(3),
  hotkey: z.string().min(1),
  textBaseUrl: apiBaseUrlSchema,
  textModel: textModelSchema,
  imageBaseUrl: apiBaseUrlSchema,
  encryptedTextApiKey: z.string().optional(),
  encryptedImageApiKey: z.string().optional()
})

const persistedSettingsV4Schema = persistedSettingsV3Schema.extend({
  version: z.literal(4),
  previewMaxEdge: previewMaxEdgeSchema
})

const persistedSettingsV5Schema = persistedSettingsV4Schema.extend({
  version: z.literal(5),
  screenshotCompression: screenshotCompressionSchema
})

const persistedSettingsV6Schema = persistedSettingsV5Schema.extend({
  version: z.literal(6),
  captureOverlayProtection: captureOverlayProtectionSchema
})

const persistedSettingsV7Schema = persistedSettingsV6Schema.extend({
  version: z.literal(7),
  generationEffectChoice: generationEffectChoiceSchema
})

const persistedSettingsV8Schema = z.object({
  version: z.literal(8),
  hotkey: z.string().min(1),
  textBaseUrl: apiBaseUrlSchema,
  textModel: textModelSchema,
  openaiImageBaseUrl: apiBaseUrlSchema,
  liblibImageBaseUrl: apiBaseUrlSchema,
  lastImageModel: imageModelSelectionSchema,
  encryptedTextApiKey: z.string().optional(),
  encryptedOpenaiImageApiKey: z.string().optional(),
  encryptedLiblibAccessKey: z.string().optional(),
  encryptedLiblibSecretKey: z.string().optional(),
  previewMaxEdge: previewMaxEdgeSchema,
  screenshotCompression: screenshotCompressionSchema,
  captureOverlayProtection: captureOverlayProtectionSchema,
  generationEffectChoice: generationEffectChoiceSchema
})

const persistedSettingsV9Schema = persistedSettingsV8Schema.extend({
  version: z.literal(9),
  comfyUiBaseUrl: comfyUiBaseUrlSchema
})

const persistedSettingsV10Schema = persistedSettingsV9Schema.extend({
  version: z.literal(10),
  comfyUiWorkflowBindings: comfyUiWorkflowBindingsSchema
})

const persistedSettingsSchema = persistedSettingsV10Schema.omit({ lastImageModel: true }).extend({
  version: z.literal(11),
  lastGenerationOptions: generationOptionsSchema
})

const storedSettingsSchema = z.union([
  persistedSettingsSchema,
  persistedSettingsV10Schema,
  persistedSettingsV9Schema,
  persistedSettingsV8Schema,
  persistedSettingsV7Schema,
  persistedSettingsV6Schema,
  persistedSettingsV5Schema,
  persistedSettingsV4Schema,
  persistedSettingsV3Schema,
  persistedSettingsV2Schema,
  legacyPersistedSettingsSchema
])

type PersistedSettings = z.infer<typeof persistedSettingsSchema>
type StoredSettings = z.infer<typeof storedSettingsSchema>

export interface TextApiConnection {
  baseUrl: string
  model: string
  apiKey: string
}

export interface OpenAIImageApiConnection {
  baseUrl: string
  apiKey: string
}

export interface LiblibApiConnection {
  baseUrl: string
  accessKey: string
  secretKey: string
}

export interface ComfyUiConnection {
  baseUrl: string
}

export interface SecureValueCodec {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

function defaultSettings(): PersistedSettings {
  return {
    version: 11,
    hotkey: DEFAULT_HOTKEY,
    textBaseUrl: DEFAULT_OPENAI_BASE_URL,
    textModel: DEFAULT_TEXT_MODEL,
    openaiImageBaseUrl: DEFAULT_OPENAI_BASE_URL,
    liblibImageBaseUrl: DEFAULT_LIBLIB_BASE_URL,
    comfyUiBaseUrl: DEFAULT_COMFYUI_BASE_URL,
    comfyUiWorkflowBindings: [],
    lastGenerationOptions: defaultGenerationOptions(),
    previewMaxEdge: DEFAULT_PREVIEW_MAX_EDGE,
    screenshotCompression: { ...DEFAULT_SCREENSHOT_COMPRESSION },
    generationEffectChoice: DEFAULT_GENERATION_EFFECT_CHOICE,
    captureOverlayProtection: DEFAULT_CAPTURE_OVERLAY_PROTECTION
  }
}

function migrateLegacySettings(
  stored: Exclude<StoredSettings, { version: 11 }>
): z.infer<typeof persistedSettingsV10Schema> {
  if (stored.version === 10) return stored
  if (stored.version === 9) {
    return {
      ...stored,
      version: 10,
      comfyUiWorkflowBindings: []
    }
  }
  if (stored.version === 8) {
    return {
      ...stored,
      version: 10,
      comfyUiBaseUrl: DEFAULT_COMFYUI_BASE_URL,
      comfyUiWorkflowBindings: []
    }
  }
  const legacy = stored.version === 1
    ? {
        hotkey: stored.hotkey,
        textBaseUrl: DEFAULT_OPENAI_BASE_URL,
        textModel: DEFAULT_TEXT_MODEL,
        imageBaseUrl: DEFAULT_OPENAI_BASE_URL,
        previewMaxEdge: DEFAULT_PREVIEW_MAX_EDGE,
        screenshotCompression: { ...DEFAULT_SCREENSHOT_COMPRESSION },
        captureOverlayProtection: DEFAULT_CAPTURE_OVERLAY_PROTECTION,
        generationEffectChoice: DEFAULT_GENERATION_EFFECT_CHOICE,
        encryptedTextApiKey: stored.encryptedApiKey,
        encryptedImageApiKey: stored.encryptedApiKey
      }
    : {
        hotkey: stored.hotkey,
        textBaseUrl: stored.textBaseUrl,
        textModel: 'textModel' in stored ? stored.textModel : DEFAULT_TEXT_MODEL,
        imageBaseUrl: stored.imageBaseUrl,
        previewMaxEdge: 'previewMaxEdge' in stored
          ? stored.previewMaxEdge
          : DEFAULT_PREVIEW_MAX_EDGE,
        screenshotCompression: 'screenshotCompression' in stored
          ? { ...stored.screenshotCompression }
          : { ...DEFAULT_SCREENSHOT_COMPRESSION },
        captureOverlayProtection: 'captureOverlayProtection' in stored
          ? stored.captureOverlayProtection
          : DEFAULT_CAPTURE_OVERLAY_PROTECTION,
        generationEffectChoice: 'generationEffectChoice' in stored
          ? stored.generationEffectChoice
          : DEFAULT_GENERATION_EFFECT_CHOICE,
        encryptedTextApiKey: stored.encryptedTextApiKey,
        encryptedImageApiKey: stored.encryptedImageApiKey
      }

  return {
    version: 10,
    hotkey: legacy.hotkey,
    textBaseUrl: legacy.textBaseUrl,
    textModel: legacy.textModel,
    openaiImageBaseUrl: legacy.imageBaseUrl,
    liblibImageBaseUrl: DEFAULT_LIBLIB_BASE_URL,
    comfyUiBaseUrl: DEFAULT_COMFYUI_BASE_URL,
    comfyUiWorkflowBindings: [],
    lastImageModel: DEFAULT_IMAGE_MODEL_SELECTION,
    previewMaxEdge: legacy.previewMaxEdge,
    screenshotCompression: { ...legacy.screenshotCompression },
    captureOverlayProtection: legacy.captureOverlayProtection,
    generationEffectChoice: generationEffectChoiceSchema.parse(legacy.generationEffectChoice),
    ...(legacy.encryptedTextApiKey ? { encryptedTextApiKey: legacy.encryptedTextApiKey } : {}),
    ...(legacy.encryptedImageApiKey
      ? { encryptedOpenaiImageApiKey: legacy.encryptedImageApiKey }
      : {})
  }
}

function migrateSettings(stored: StoredSettings): PersistedSettings {
  if (stored.version === 11) return stored
  const { lastImageModel, ...legacy } = migrateLegacySettings(stored)
  return { ...legacy, version: 11, lastGenerationOptions: defaultGenerationOptions(lastImageModel) }
}

function normalizeLastWorkflowSelection(settings: PersistedSettings): PersistedSettings {
  const selection = settings.lastGenerationOptions.imageModel
  if (selection.provider !== 'comfyui' || !('workflowPath' in selection)) return settings
  const binding = settings.comfyUiWorkflowBindings.find((candidate) =>
    candidate.workflowPath === selection.workflowPath)
  const normalizedSelection = binding
    ? comfyUiWorkflowSelection(binding)
    : DEFAULT_IMAGE_MODEL_SELECTION
  if (JSON.stringify(selection) === JSON.stringify(normalizedSelection)) return settings
  return {
    ...settings,
    lastGenerationOptions: {
      ...settings.lastGenerationOptions,
      imageModel: normalizedSelection,
      imageGeneration: normalizedSelection.provider === 'comfyui' && 'workflowPath' in normalizedSelection
        && !normalizedSelection.generationModes.includes(settings.lastGenerationOptions.imageGeneration)
        ? normalizedSelection.generationModes[0]!
        : settings.lastGenerationOptions.imageGeneration,
      ...(normalizedSelection.provider === 'comfyui' && 'workflowPath' in normalizedSelection
        ? { transparentBackground: normalizedSelection.transparentOutput } : {})
    }
  }
}

export class SettingsStore {
  private state: PersistedSettings = defaultSettings()

  constructor(
    private readonly filePath: string,
    private readonly codec: SecureValueCodec
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const stored = storedSettingsSchema.parse(JSON.parse(raw))
      const migrated = migrateSettings(stored)
      const normalized = normalizeLastWorkflowSelection(migrated)
      if (stored.version !== 11 || normalized !== migrated) {
        await this.write(normalized)
      }
      this.state = normalized
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && !(error instanceof z.ZodError) && !(error instanceof SyntaxError)) {
        throw error
      }
      this.state = defaultSettings()
    }
  }

  getPublic(hotkeyError?: string): PublicSettings {
    return {
      hotkey: this.state.hotkey,
      textBaseUrl: this.state.textBaseUrl,
      textModel: this.state.textModel,
      openaiImageBaseUrl: this.state.openaiImageBaseUrl,
      liblibImageBaseUrl: this.state.liblibImageBaseUrl,
      comfyUiBaseUrl: this.state.comfyUiBaseUrl,
      comfyUiWorkflowBindings: this.state.comfyUiWorkflowBindings.map((binding) => structuredClone(binding)),
      lastGenerationOptions: structuredClone(this.state.lastGenerationOptions),
      previewMaxEdge: this.state.previewMaxEdge,
      screenshotCompression: { ...this.state.screenshotCompression },
      generationEffectChoice: this.state.generationEffectChoice,
      captureOverlayProtection: this.state.captureOverlayProtection,
      hasTextApiKey: Boolean(this.state.encryptedTextApiKey),
      hasOpenaiImageApiKey: Boolean(this.state.encryptedOpenaiImageApiKey),
      hasLiblibCredentials: Boolean(
        this.state.encryptedLiblibAccessKey && this.state.encryptedLiblibSecretKey
      ),
      ...(hotkeyError ? { hotkeyError } : {})
    }
  }

  getHotkey(): string {
    return this.state.hotkey
  }

  getPreviewMaxEdge(): number {
    return this.state.previewMaxEdge
  }

  getScreenshotCompression(): ScreenshotCompression {
    return { ...this.state.screenshotCompression }
  }

  getGenerationEffectChoice(): GenerationEffectChoice {
    return this.state.generationEffectChoice
  }

  getCaptureOverlayProtection(): boolean {
    return this.state.captureOverlayProtection
  }

  getLastGenerationOptions(): GenerationOptions {
    return structuredClone(this.state.lastGenerationOptions)
  }

  getComfyUiWorkflowBindings(): ComfyUiWorkflowBinding[] {
    return this.state.comfyUiWorkflowBindings.map((binding) => structuredClone(binding))
  }

  getTextApiKey(): string | undefined {
    return this.decryptApiKey(this.state.encryptedTextApiKey)
  }

  getOpenAIImageApiKey(): string | undefined {
    return this.decryptApiKey(this.state.encryptedOpenaiImageApiKey)
  }

  getLiblibAccessKey(): string | undefined {
    return this.decryptApiKey(this.state.encryptedLiblibAccessKey)
  }

  getLiblibSecretKey(): string | undefined {
    return this.decryptApiKey(this.state.encryptedLiblibSecretKey)
  }

  getTextApiConnection(): TextApiConnection | undefined {
    const apiKey = this.getTextApiKey()
    return apiKey
      ? { baseUrl: this.state.textBaseUrl, model: this.state.textModel, apiKey }
      : undefined
  }

  getOpenAIImageApiConnection(): OpenAIImageApiConnection | undefined {
    const apiKey = this.getOpenAIImageApiKey()
    return apiKey
      ? { baseUrl: this.state.openaiImageBaseUrl, apiKey }
      : undefined
  }

  getLiblibApiConnection(): LiblibApiConnection | undefined {
    const accessKey = this.getLiblibAccessKey()
    const secretKey = this.getLiblibSecretKey()
    return accessKey && secretKey
      ? { baseUrl: this.state.liblibImageBaseUrl, accessKey, secretKey }
      : undefined
  }

  getComfyUiConnection(): ComfyUiConnection {
    return { baseUrl: this.state.comfyUiBaseUrl }
  }

  async update(update: SettingsUpdate): Promise<void> {
    const workflowBindings = (update.comfyUiWorkflowBindings ?? this.state.comfyUiWorkflowBindings)
      .map((binding) => structuredClone(binding))
    const next: PersistedSettings = normalizeLastWorkflowSelection({
      ...this.state,
      hotkey: update.hotkey,
      textBaseUrl: update.textBaseUrl,
      textModel: update.textModel,
      openaiImageBaseUrl: update.openaiImageBaseUrl,
      liblibImageBaseUrl: update.liblibImageBaseUrl,
      comfyUiBaseUrl: update.comfyUiBaseUrl,
      comfyUiWorkflowBindings: workflowBindings,
      previewMaxEdge: update.previewMaxEdge,
      screenshotCompression: { ...update.screenshotCompression },
      generationEffectChoice: update.generationEffectChoice
    })

    if (update.textApiKey) {
      if (!this.codec.isEncryptionAvailable()) {
        throw new Error('Secure credential storage is unavailable on this device.')
      }
      next.encryptedTextApiKey = this.codec.encryptString(update.textApiKey).toString('base64')
    }

    if (update.openaiImageApiKey) {
      if (!this.codec.isEncryptionAvailable()) {
        throw new Error('Secure credential storage is unavailable on this device.')
      }
      next.encryptedOpenaiImageApiKey = this.codec.encryptString(update.openaiImageApiKey).toString('base64')
    }

    const accessKey = update.liblibAccessKey ?? this.getLiblibAccessKey()
    const secretKey = update.liblibSecretKey ?? this.getLiblibSecretKey()
    if (Boolean(accessKey) !== Boolean(secretKey)) {
      throw new Error('LiblibAI AccessKey 和 SecretKey 必须同时配置。')
    }
    if (update.liblibAccessKey || update.liblibSecretKey) {
      if (!this.codec.isEncryptionAvailable()) {
        throw new Error('Secure credential storage is unavailable on this device.')
      }
      if (update.liblibAccessKey) {
        next.encryptedLiblibAccessKey = this.codec.encryptString(update.liblibAccessKey).toString('base64')
      }
      if (update.liblibSecretKey) {
        next.encryptedLiblibSecretKey = this.codec.encryptString(update.liblibSecretKey).toString('base64')
      }
    }

    await this.write(next)
    this.state = next
  }

  async updateCaptureOverlayProtection(enabled: boolean): Promise<void> {
    const next: PersistedSettings = {
      ...this.state,
      captureOverlayProtection: enabled
    }
    await this.write(next)
    this.state = next
  }

  async updateLastGenerationOptions(options: GenerationOptions): Promise<void> {
    const parsed = generationOptionsSchema.parse(options)
    const imageModel = parsed.imageModel
    if (imageModel.provider === 'comfyui' && 'workflowPath' in imageModel &&
      !this.state.comfyUiWorkflowBindings.some((binding) =>
        binding.workflowPath === imageModel.workflowPath)) {
      throw new Error('Cannot persist an unconfigured ComfyUI workflow selection.')
    }
    const next = normalizeLastWorkflowSelection({ ...this.state, lastGenerationOptions: parsed })
    await this.write(next)
    this.state = next
  }

  async clearCredential(target: CredentialTarget): Promise<void> {
    credentialTargetSchema.parse(target)
    const next = { ...this.state }
    if (target === 'text') delete next.encryptedTextApiKey
    else if (target === 'openai_image') delete next.encryptedOpenaiImageApiKey
    else {
      delete next.encryptedLiblibAccessKey
      delete next.encryptedLiblibSecretKey
    }
    await this.write(next)
    this.state = next
  }

  private async write(next: PersistedSettings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }

  private decryptApiKey(value: string | undefined): string | undefined {
    if (!value) return undefined
    if (!this.codec.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable on this device.')
    }
    return this.codec.decryptString(Buffer.from(value, 'base64'))
  }
}
