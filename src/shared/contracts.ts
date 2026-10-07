import { z } from 'zod'
import {
  DEFAULT_IMAGE_MODEL_SELECTION,
  comfyUiCheckpointSchema,
  comfyUiWorkflowPathSchema,
  DEFAULT_LIBLIB_BASE_URL,
  getImageModelDefinition,
  imageGenerationSchema,
  imageModelSelectionSchema,
  supportsImageGeneration,
  type ComfyUiWorkflowSelection
} from './image-models'

export {
  DEFAULT_IMAGE_MODEL_SELECTION,
  DEFAULT_LIBLIB_BASE_URL,
  comfyUiCheckpointSchema,
  comfyUiWorkflowPathSchema,
  imageGenerationSchema,
  imageModelSelectionSchema,
  type ImageGeneration,
  type ImageModelSelection,
  type ImageProvider,
  type ComfyUiWorkflowSelection
} from './image-models'

export const DEFAULT_HOTKEY = 'Alt+Shift+G'
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_COMFYUI_BASE_URL = 'http://127.0.0.1:8188'
export const DEFAULT_TEXT_MODEL = 'gpt-5.6-luna'
export const DEFAULT_PREVIEW_MAX_EDGE = 512
export const MAX_GENERATION_COUNT = 8
export const DEFAULT_CAPTURE_OVERLAY_PROTECTION = true
export const GENERATION_EFFECT_SCHEME_IDS = [
  'frosted-orbit',
  'aperture-fold',
  'pixel-weave'
] as const
export const GENERATION_EFFECT_CHOICES = ['random', ...GENERATION_EFFECT_SCHEME_IDS] as const
export const generationEffectSchemeSchema = z.enum(GENERATION_EFFECT_SCHEME_IDS)
export const generationEffectChoiceSchema = z.enum(GENERATION_EFFECT_CHOICES)
export const DEFAULT_GENERATION_EFFECT_CHOICE = 'random'
export type GenerationEffectSchemeId = z.infer<typeof generationEffectSchemeSchema>
export type GenerationEffectChoice = z.infer<typeof generationEffectChoiceSchema>

export const textModelSchema = z.string().trim().min(1).max(200)
export const generationCountSchema = z.number().int().min(1).max(MAX_GENERATION_COUNT)
export const previewMaxEdgeSchema = z.number().int().min(64).max(2048)
export const screenshotCompressionMaxEdgeSchema = z.number().int().min(256).max(2048)
export const screenshotCompressionQualitySchema = z.number().int().min(1).max(100)
export const screenshotCompressionSchema = z.object({
  enabled: z.boolean(),
  maxEdge: screenshotCompressionMaxEdgeSchema,
  quality: screenshotCompressionQualitySchema
})

export type ScreenshotCompression = z.infer<typeof screenshotCompressionSchema>
export const DEFAULT_SCREENSHOT_COMPRESSION = {
  enabled: true,
  maxEdge: 1024,
  quality: 80
} as const satisfies ScreenshotCompression

export const captureOverlayProtectionSchema = z.boolean()

export const apiBaseUrlSchema = z.string().trim().min(1).transform((value, context) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    context.addIssue({ code: 'custom', message: '请输入有效的完整 API Base URL。' })
    return z.NEVER
  }

  if (url.username || url.password) {
    context.addIssue({ code: 'custom', message: 'API Base URL 不能包含用户名或密码。' })
    return z.NEVER
  }
  if (url.search || url.hash) {
    context.addIssue({ code: 'custom', message: 'API Base URL 不能包含查询参数或片段。' })
    return z.NEVER
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
  const isAllowedProtocol = url.protocol === 'https:' ||
    (url.protocol === 'http:' && loopbackHosts.has(url.hostname.toLowerCase()))
  if (!isAllowedProtocol) {
    context.addIssue({ code: 'custom', message: '仅允许 HTTPS；本机回环地址可使用 HTTP。' })
    return z.NEVER
  }

  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
})

export const comfyUiBaseUrlSchema = z.string().trim().min(1).transform((value, context) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    context.addIssue({ code: 'custom', message: '请输入有效的完整 ComfyUI Base URL。' })
    return z.NEVER
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !loopbackHosts.has(url.hostname.toLowerCase())) {
    context.addIssue({ code: 'custom', message: 'ComfyUI 只允许连接本机回环地址。' })
    return z.NEVER
  }
  if (url.username || url.password) {
    context.addIssue({ code: 'custom', message: 'ComfyUI Base URL 不能包含用户名或密码。' })
    return z.NEVER
  }
  if (url.search || url.hash) {
    context.addIssue({ code: 'custom', message: 'ComfyUI Base URL 不能包含查询参数或片段。' })
    return z.NEVER
  }

  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
})

export const comfyUiNodeIdSchema = z.string().trim().min(1).max(128).refine(
  (value) => !value.includes('\0') && !value.includes('\r') && !value.includes('\n'),
  'ComfyUI node identifier contains unsupported characters.'
)
export const comfyUiInputNameSchema = z.string().trim().min(1).max(200).refine(
  (value) => !value.includes('\0') && !value.includes('\r') && !value.includes('\n'),
  'ComfyUI input name contains unsupported characters.'
)
export const comfyUiWorkflowInputBindingSchema = z.object({
  nodeId: comfyUiNodeIdSchema,
  inputName: comfyUiInputNameSchema
})
export type ComfyUiWorkflowInputBinding = z.infer<typeof comfyUiWorkflowInputBindingSchema>

export const comfyUiWorkflowModeOverrideSchema = z.object({
  alwaysNodeIds: z.array(comfyUiNodeIdSchema).max(2_048).default([]),
  bypassNodeIds: z.array(comfyUiNodeIdSchema).max(2_048).default([])
}).superRefine((value, context) => {
  const always = new Set(value.alwaysNodeIds)
  if (always.size !== value.alwaysNodeIds.length ||
    new Set(value.bypassNodeIds).size !== value.bypassNodeIds.length) {
    context.addIssue({ code: 'custom', message: 'ComfyUI workflow node mode lists must be unique.' })
  }
  if (value.bypassNodeIds.some((nodeId) => always.has(nodeId))) {
    context.addIssue({ code: 'custom', message: 'A ComfyUI node cannot be both Always and Bypass.' })
  }
})

const comfyUiGenerateModeBindingSchema = comfyUiWorkflowModeOverrideSchema
const comfyUiReferenceModeBindingSchema = comfyUiWorkflowModeOverrideSchema.extend({
  sourceImage: comfyUiWorkflowInputBindingSchema
})
const comfyUiInpaintModeBindingSchema = comfyUiWorkflowModeOverrideSchema.extend({
  sourceImage: comfyUiWorkflowInputBindingSchema,
  maskImage: comfyUiWorkflowInputBindingSchema
})

export const comfyUiWorkflowBindingSchema = z.object({
  workflowPath: comfyUiWorkflowPathSchema,
  prompt: comfyUiWorkflowInputBindingSchema,
  negativePrompt: comfyUiWorkflowInputBindingSchema.optional(),
  seed: comfyUiWorkflowInputBindingSchema.optional(),
  outputNodeId: comfyUiNodeIdSchema,
  transparentOutput: z.boolean(),
  modes: z.object({
    generate: comfyUiGenerateModeBindingSchema.optional(),
    reference: comfyUiReferenceModeBindingSchema.optional(),
    inpaint: comfyUiInpaintModeBindingSchema.optional()
  }).refine((modes) => Boolean(modes.generate || modes.reference || modes.inpaint), {
    message: 'At least one ComfyUI workflow generation mode is required.'
  })
})
export type ComfyUiWorkflowBinding = z.infer<typeof comfyUiWorkflowBindingSchema>

export const comfyUiWorkflowBindingsSchema = z.array(comfyUiWorkflowBindingSchema).max(128)
  .refine((bindings) => new Set(bindings.map((binding) => binding.workflowPath)).size === bindings.length, {
    message: 'ComfyUI workflow bindings must have unique paths.'
  })

export const comfyUiWorkflowSummarySchema = z.object({
  path: comfyUiWorkflowPathSchema,
  modified: z.number().int().nonnegative().optional()
})
export type ComfyUiWorkflowSummary = z.infer<typeof comfyUiWorkflowSummarySchema>
export const comfyUiWorkflowSummariesSchema = z.array(comfyUiWorkflowSummarySchema).max(2_048)

export const comfyUiWorkflowNodeSchema = z.object({
  id: comfyUiNodeIdSchema,
  title: z.string().trim().min(1).max(500),
  classType: z.string().trim().min(1).max(500),
  mode: z.number().int(),
  outputNode: z.boolean(),
  inputs: z.array(z.object({
    name: comfyUiInputNameSchema,
    valueType: z.enum(['string', 'number', 'boolean'])
  })).max(512)
})
export type ComfyUiWorkflowNode = z.infer<typeof comfyUiWorkflowNodeSchema>
export const comfyUiWorkflowDescriptorSchema = z.object({
  path: comfyUiWorkflowPathSchema,
  nodes: z.array(comfyUiWorkflowNodeSchema).min(1).max(2_048)
})
export type ComfyUiWorkflowDescriptor = z.infer<typeof comfyUiWorkflowDescriptorSchema>

export function comfyUiWorkflowSelection(
  binding: ComfyUiWorkflowBinding
): ComfyUiWorkflowSelection {
  return {
    provider: 'comfyui',
    workflowPath: binding.workflowPath,
    generationModes: imageGenerationSchema.options.filter((mode) => Boolean(binding.modes[mode])),
    transparentOutput: binding.transparentOutput
  }
}

export const promptProcessingSchema = z.enum(['direct', 'polish', 'polish_with_selection'])
export type PromptProcessing = z.infer<typeof promptProcessingSchema>

export const promptLanguageSchema = z.enum(['en', 'zh'])
export type PromptLanguage = z.infer<typeof promptLanguageSchema>

export const star3GenerationOptionsSchema = z.object({
  promptMagic: z.boolean(),
  steps: z.number().int().min(1).max(100),
  denoisingStrength: z.number().min(0).max(1)
})
export type Star3GenerationOptions = z.infer<typeof star3GenerationOptionsSchema>
export const DEFAULT_STAR3_GENERATION_OPTIONS = {
  promptMagic: true,
  steps: 30,
  denoisingStrength: 0.5
} as const satisfies Star3GenerationOptions

export const comfyUiOptionNameSchema = z.string().trim().min(1).max(200).refine(
  (value) => !value.includes('\0') && !value.includes('\r') && !value.includes('\n'),
  'ComfyUI option name contains unsupported characters.'
)
export const comfyUiGenerationOptionsSchema = z.object({
  steps: z.number().int().min(1).max(100),
  cfg: z.number().min(0).max(100),
  samplerName: comfyUiOptionNameSchema,
  scheduler: comfyUiOptionNameSchema,
  denoisingStrength: z.number().min(0).max(1),
  seed: z.number().int().safe().nonnegative().optional()
})
export type ComfyUiGenerationOptions = z.infer<typeof comfyUiGenerationOptionsSchema>
export const DEFAULT_COMFYUI_GENERATION_OPTIONS = {
  steps: 24,
  cfg: 6.5,
  samplerName: 'dpmpp_2m',
  scheduler: 'karras',
  denoisingStrength: 0.65
} as const satisfies ComfyUiGenerationOptions

export const generationOptionsSchema = z.object({
  promptProcessing: promptProcessingSchema,
  promptLanguage: promptLanguageSchema,
  imageModel: imageModelSelectionSchema,
  imageGeneration: imageGenerationSchema,
  generationCount: generationCountSchema.default(1),
  liblibGenerationOptions: star3GenerationOptionsSchema.optional(),
  comfyUiGenerationOptions: comfyUiGenerationOptionsSchema.optional(),
  comfyUiWorkflowSeed: z.number().int().safe().nonnegative().optional(),
  confirmBeforeGeneration: z.boolean().optional(),
  transparentBackground: z.boolean()
})
export type GenerationOptions = z.infer<typeof generationOptionsSchema>

export function defaultGenerationOptions(
  imageModel: GenerationOptions['imageModel'] = DEFAULT_IMAGE_MODEL_SELECTION
): GenerationOptions {
  return {
    imageModel,
    imageGeneration: getImageModelDefinition(imageModel).generationModes[0]!,
    generationCount: 1,
    promptProcessing: 'polish',
    promptLanguage: 'en',
    confirmBeforeGeneration: false,
    transparentBackground: imageModel.provider === 'comfyui' && 'workflowPath' in imageModel
      ? imageModel.transparentOutput : false
  }
}

export const publicSettingsSchema = z.object({
  hotkey: z.string().min(1),
  textBaseUrl: apiBaseUrlSchema,
  textModel: textModelSchema,
  openaiImageBaseUrl: apiBaseUrlSchema,
  liblibImageBaseUrl: apiBaseUrlSchema,
  comfyUiBaseUrl: comfyUiBaseUrlSchema,
  comfyUiWorkflowBindings: comfyUiWorkflowBindingsSchema,
  lastGenerationOptions: generationOptionsSchema,
  previewMaxEdge: previewMaxEdgeSchema,
  screenshotCompression: screenshotCompressionSchema,
  generationEffectChoice: generationEffectChoiceSchema,
  captureOverlayProtection: captureOverlayProtectionSchema,
  hasTextApiKey: z.boolean(),
  hasOpenaiImageApiKey: z.boolean(),
  hasLiblibCredentials: z.boolean(),
  hotkeyError: z.string().optional()
})

export type PublicSettings = z.infer<typeof publicSettingsSchema>

export const credentialTargetSchema = z.enum(['text', 'openai_image', 'liblib'])
export type CredentialTarget = z.infer<typeof credentialTargetSchema>

export const settingsUpdateSchema = z.object({
  hotkey: z.string().trim().min(1).max(80),
  textBaseUrl: apiBaseUrlSchema,
  textModel: textModelSchema,
  openaiImageBaseUrl: apiBaseUrlSchema,
  liblibImageBaseUrl: apiBaseUrlSchema,
  comfyUiBaseUrl: comfyUiBaseUrlSchema,
  comfyUiWorkflowBindings: comfyUiWorkflowBindingsSchema.optional(),
  previewMaxEdge: previewMaxEdgeSchema,
  screenshotCompression: screenshotCompressionSchema,
  generationEffectChoice: generationEffectChoiceSchema,
  textApiKey: z.string().trim().min(1).max(4096).optional(),
  openaiImageApiKey: z.string().trim().min(1).max(4096).optional(),
  liblibAccessKey: z.string().trim().min(1).max(4096).optional(),
  liblibSecretKey: z.string().trim().min(1).max(4096).optional()
})

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>

const connectionTestApiKeySchema = z.string().trim().min(1).max(4096).optional()

export const connectionTestInputSchema = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('text'),
    baseUrl: apiBaseUrlSchema,
    model: textModelSchema,
    apiKey: connectionTestApiKeySchema
  }),
  z.object({
    target: z.literal('openai_image'),
    baseUrl: apiBaseUrlSchema,
    apiKey: connectionTestApiKeySchema
  }),
  z.object({
    target: z.literal('liblib'),
    baseUrl: apiBaseUrlSchema.default(DEFAULT_LIBLIB_BASE_URL),
    accessKey: connectionTestApiKeySchema,
    secretKey: connectionTestApiKeySchema
  }),
  z.object({
    target: z.literal('comfyui'),
    baseUrl: comfyUiBaseUrlSchema.default(DEFAULT_COMFYUI_BASE_URL)
  })
])

export type ConnectionTestInput = z.infer<typeof connectionTestInputSchema>

export const connectionTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().min(1).max(200)
})

export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>

export const comfyUiWorkflowListInputSchema = z.object({
  baseUrl: comfyUiBaseUrlSchema
})
export const comfyUiWorkflowInspectInputSchema = comfyUiWorkflowListInputSchema.extend({
  workflowPath: comfyUiWorkflowPathSchema
})

export interface SettingsApi {
  get(): Promise<PublicSettings>
  update(update: SettingsUpdate): Promise<PublicSettings>
  updateCaptureOverlayProtection(enabled: boolean): Promise<PublicSettings>
  clearCredential(target: CredentialTarget): Promise<PublicSettings>
  testConnection(input: ConnectionTestInput): Promise<ConnectionTestResult>
  listComfyUiWorkflows(baseUrl: string): Promise<ComfyUiWorkflowSummary[]>
  inspectComfyUiWorkflow(baseUrl: string, workflowPath: string): Promise<ComfyUiWorkflowDescriptor>
}

export interface AppApi {
  platform: string
  settings: SettingsApi
  capture: CaptureApi
  jobs: JobsApi
  preview: PreviewApi
  debug: DebugApi
}

export const IPC_CHANNELS = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsUpdateCaptureOverlayProtection: 'settings:update-capture-overlay-protection',
  settingsClearCredential: 'settings:clear-credential',
  settingsTestConnection: 'settings:test-connection',
  settingsListComfyUiWorkflows: 'settings:list-comfyui-workflows',
  settingsInspectComfyUiWorkflow: 'settings:inspect-comfyui-workflow',
  captureStart: 'capture:start',
  captureOverlayReady: 'capture:overlay-ready',
  captureSessionStarted: 'capture:session-started',
  captureSessionReady: 'capture:session-ready',
  captureSessionEnded: 'capture:session-ended',
  captureActivate: 'capture:activate',
  captureSubmit: 'capture:submit',
  captureCancel: 'capture:cancel',
  captureLocked: 'capture:locked',
  captureGetComfyUiCapabilities: 'capture:get-comfyui-capabilities',
  jobsList: 'jobs:list',
  jobsGet: 'jobs:get',
  jobsCancel: 'jobs:cancel',
  jobsChanged: 'jobs:changed',
  previewGetState: 'preview:get-state',
  previewStartDrag: 'preview:start-drag',
  previewStartMoveDrag: 'preview:start-move-drag',
  previewMoveDrag: 'preview:move-drag',
  previewEndMoveDrag: 'preview:end-move-drag',
  previewStartCloneDrag: 'preview:start-clone-drag',
  previewMoveCloneDrag: 'preview:move-clone-drag',
  previewEndCloneDrag: 'preview:end-clone-drag',
  previewCopy: 'preview:copy',
  previewSave: 'preview:save',
  previewOpenProperties: 'preview:open-properties',
  previewGetProperties: 'preview:get-properties',
  previewApplyVersion: 'preview:apply-version',
  previewSaveVersion: 'preview:save-version',
  previewOpenDetails: 'preview:open-details',
  previewGetGenerationReview: 'preview:get-generation-review',
  previewConfirmGeneration: 'preview:confirm-generation',
  previewRegenerate: 'preview:regenerate',
  previewProcess: 'preview:process',
  previewSetClickThrough: 'preview:set-click-through',
  previewShowMenu: 'preview:show-menu',
  previewClose: 'preview:close',
  previewDetailsChanged: 'preview:details-changed',
  previewPropertiesChanged: 'preview:properties-changed',
  debugChooseImage: 'debug:choose-image',
  debugCreatePreview: 'debug:create-preview'
} as const

export const rectDipSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive()
})

export type RectDip = z.infer<typeof rectDipSchema>

export const CAPTURE_DOODLE_STROKE_WIDTH_DIP = 12
const doodlePointDipSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite()
})
const doodleStrokesDipSchema = z
  .array(z.array(doodlePointDipSchema).min(1).max(2_048))
  .min(1)
  .max(64)

export const comfyUiCapabilitiesSchema = z.object({
  available: z.boolean(),
  checkpoints: z.array(comfyUiCheckpointSchema).max(2_048),
  samplers: z.array(comfyUiOptionNameSchema).max(512),
  schedulers: z.array(comfyUiOptionNameSchema).max(512),
  workflows: comfyUiWorkflowSummariesSchema
}).superRefine((value, context) => {
  const completeCoreCapabilities = value.checkpoints.length > 0 &&
    value.samplers.length > 0 && value.schedulers.length > 0
  const emptyCoreCapabilities = value.checkpoints.length === 0 &&
    value.samplers.length === 0 && value.schedulers.length === 0
  if (value.available && !completeCoreCapabilities &&
    !(emptyCoreCapabilities && value.workflows.length > 0)) {
    context.addIssue({
      code: 'custom',
      message: 'Available ComfyUI capabilities must include a complete core model or saved workflow.'
    })
  }
})
export type ComfyUiCapabilities = z.infer<typeof comfyUiCapabilitiesSchema>
export const UNAVAILABLE_COMFYUI_CAPABILITIES = {
  available: false,
  checkpoints: [],
  samplers: [],
  schedulers: [],
  workflows: []
} as const satisfies ComfyUiCapabilities

export const captureSubmissionModeSchema = z.enum(['generate', 'fake'])
export type CaptureSubmissionMode = z.infer<typeof captureSubmissionModeSchema>

export const MAX_REFERENCE_IMAGE_COUNT = 4

export const captureSelectionSchema = z
  .object({
    displayId: z.string().min(1),
    contextRectDip: rectDipSchema,
    outputRectDip: rectDipSchema.optional(),
    referenceRectsDip: z.array(rectDipSchema).max(MAX_REFERENCE_IMAGE_COUNT).optional(),
    // Existing task snapshots used one rectangle. Normalize it to the ordered list at this boundary.
    referenceRectDip: rectDipSchema.optional(),
    doodleStrokesDip: doodleStrokesDipSchema.optional(),
    scaleFactor: z.number().positive(),
    instruction: z.string().trim().min(1).max(500),
    ...generationOptionsSchema.shape,
    comfyUiWorkflowBinding: comfyUiWorkflowBindingSchema.optional()
  })
  .refine((value) => value.referenceRectDip === undefined ||
    value.referenceRectsDip === undefined, {
    path: ['referenceRectsDip'],
    message: 'Use either the legacy reference rectangle or the ordered reference list.'
  })
  .transform(({ referenceRectDip, referenceRectsDip, ...selection }) => ({
    ...selection,
    ...(referenceRectsDip !== undefined
      ? { referenceRectsDip }
      : referenceRectDip
        ? { referenceRectsDip: [referenceRectDip] }
        : {})
  }))
  .superRefine((value, context) => {
    const outer = value.contextRectDip
    const output = value.outputRectDip ?? outer
    if (
      output.x < outer.x - 0.01 ||
      output.y < outer.y - 0.01 ||
      output.x + output.width > outer.x + outer.width + 0.01 ||
      output.y + output.height > outer.y + outer.height + 0.01
    ) {
      context.addIssue({
        code: 'custom',
        path: ['outputRectDip'],
        message: 'Output rectangle must stay inside the context rectangle.'
      })
    }

    const strokes = value.doodleStrokesDip
    if (value.imageGeneration === 'inpaint' && !strokes) {
      context.addIssue({
        code: 'custom',
        path: ['doodleStrokesDip'],
        message: 'Inpaint requires a doodle mask.'
      })
    }
    if (strokes) {
      const pointCount = strokes.reduce((total, stroke) => total + stroke.length, 0)
      if (pointCount > 4_096) {
        context.addIssue({
          code: 'custom',
          path: ['doodleStrokesDip'],
          message: 'Doodle mark contains too many points.'
        })
      }
      const hasOutsidePoint = strokes.some((stroke) => stroke.some((point) =>
        point.x < 0 ||
        point.y < 0 ||
        point.x < output.x - 0.01 ||
        point.y < output.y - 0.01 ||
        point.x > output.x + output.width + 0.01 ||
        point.y > output.y + output.height + 0.01
      ))
      if (hasOutsidePoint) {
        context.addIssue({
          code: 'custom',
          path: ['doodleStrokesDip'],
          message: 'Doodle points must stay inside the resolved output rectangle.'
        })
      }
    }

    if (!supportsImageGeneration(value.imageModel, value.imageGeneration)) {
      context.addIssue({
        code: 'custom',
        path: ['imageGeneration'],
        message: 'The selected image model does not support this generation mode.'
      })
    }
    if (value.liblibGenerationOptions && !(
      value.imageModel.provider === 'liblib' && value.imageModel.model === 'star-3-alpha'
    )) {
      context.addIssue({
        code: 'custom',
        path: ['liblibGenerationOptions'],
        message: 'The selected model does not support these LiblibAI generation options.'
      })
    }
    if (value.confirmBeforeGeneration && value.imageModel.provider !== 'liblib') {
      context.addIssue({
        code: 'custom',
        path: ['confirmBeforeGeneration'],
        message: 'Generation confirmation is only available for LiblibAI models.'
      })
    }
    const workflowSelection = value.imageModel.provider === 'comfyui' &&
      'workflowPath' in value.imageModel ? value.imageModel : undefined
    if (value.imageModel.provider === 'comfyui' && !workflowSelection &&
      !value.comfyUiGenerationOptions) {
      context.addIssue({
        code: 'custom',
        path: ['comfyUiGenerationOptions'],
        message: 'ComfyUI generation options are required for ComfyUI tasks.'
      })
    }
    if (value.comfyUiGenerationOptions &&
      (value.imageModel.provider !== 'comfyui' || workflowSelection)) {
      context.addIssue({
        code: 'custom',
        path: ['comfyUiGenerationOptions'],
        message: 'ComfyUI generation options are only available for core ComfyUI tasks.'
      })
    }
    if (workflowSelection) {
      const binding = value.comfyUiWorkflowBinding
      if (!binding || binding.workflowPath !== workflowSelection.workflowPath ||
        !binding.modes[value.imageGeneration] ||
        binding.transparentOutput !== workflowSelection.transparentOutput) {
        context.addIssue({
          code: 'custom',
          path: ['comfyUiWorkflowBinding'],
          message: 'A matching ComfyUI workflow binding is required.'
        })
      }
      if (value.transparentBackground !== workflowSelection.transparentOutput) {
        context.addIssue({
          code: 'custom',
          path: ['transparentBackground'],
          message: 'ComfyUI workflow background is controlled by its binding.'
        })
      }
      if (value.comfyUiWorkflowSeed !== undefined && !binding?.seed) {
        context.addIssue({
          code: 'custom',
          path: ['comfyUiWorkflowSeed'],
          message: 'This ComfyUI workflow has no configured seed input.'
        })
      }
    } else if (value.comfyUiWorkflowBinding) {
      context.addIssue({
        code: 'custom',
        path: ['comfyUiWorkflowBinding'],
        message: 'ComfyUI workflow bindings are only available for workflow tasks.'
      })
    } else if (value.comfyUiWorkflowSeed !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['comfyUiWorkflowSeed'],
        message: 'ComfyUI workflow seed is only available for workflow tasks.'
      })
    }
    if (value.transparentBackground &&
      !getImageModelDefinition(value.imageModel).supportsTransparency) {
      context.addIssue({
        code: 'custom',
        path: ['transparentBackground'],
        message: 'The selected image model does not support transparent backgrounds.'
      })
    }
  })

export type CaptureSelection = z.infer<typeof captureSelectionSchema>

export const captureSessionIdSchema = z.string().uuid()

export const captureFollowUpActionSchema = z.enum(['reconfigure', 'continue_edit'])
export type CaptureFollowUpAction = z.infer<typeof captureFollowUpActionSchema>

const screenshotBytesSchema = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array,
  { message: 'Screenshot payload must be a Uint8Array.' }
)

export const captureOverlaySessionSchema = z.object({
  sessionId: captureSessionIdSchema,
  displayId: z.string(),
  displayBoundsDip: rectDipSchema,
  scaleFactor: z.number().positive(),
  canFakeGenerate: z.boolean(),
  defaultGenerationOptions: generationOptionsSchema,
  comfyUiWorkflowBindings: comfyUiWorkflowBindingsSchema,
  screenshotPng: screenshotBytesSchema,
  lockedDisplayId: z.string().min(1).optional(),
  followUp: z.object({
    action: captureFollowUpActionSchema,
    selection: captureSelectionSchema,
    currentImagePng: screenshotBytesSchema
  }).optional()
})

export type CaptureOverlaySession = z.infer<typeof captureOverlaySessionSchema>

export interface CaptureApi {
  start(): Promise<void>
  notifyOverlayReady(): Promise<void>
  notifySessionReady(sessionId: string): Promise<void>
  activate(): Promise<void>
  getComfyUiCapabilities(sessionId: string): Promise<ComfyUiCapabilities>
  submit(selection: CaptureSelection, mode?: CaptureSubmissionMode): Promise<void>
  cancel(): Promise<void>
  onSessionStarted(callback: (session: CaptureOverlaySession) => void): () => void
  onSessionEnded(callback: (sessionId: string) => void): () => void
  onLocked(callback: (displayId: string) => void): () => void
}

export const ASSET_SPEC_LIMITS = {
  assetName: 80,
  subject: 500,
  style: 500,
  composition: 500,
  paletteItems: 8,
  paletteItem: 80,
  mustPreserveItems: 12,
  mustPreserveItem: 200,
  avoidItems: 12,
  avoidItem: 200,
  generatorPrompt: 12_000
} as const

export const assetSpecSchema = z.object({
  version: z.literal(1),
  assetName: z.string().trim().min(1).max(ASSET_SPEC_LIMITS.assetName),
  subject: z.string().trim().min(1).max(ASSET_SPEC_LIMITS.subject),
  style: z.string().trim().min(1).max(ASSET_SPEC_LIMITS.style),
  composition: z.string().trim().min(1).max(ASSET_SPEC_LIMITS.composition),
  palette: z.array(z.string().trim().min(1).max(ASSET_SPEC_LIMITS.paletteItem))
    .max(ASSET_SPEC_LIMITS.paletteItems),
  mustPreserve: z.array(z.string().trim().min(1).max(ASSET_SPEC_LIMITS.mustPreserveItem))
    .max(ASSET_SPEC_LIMITS.mustPreserveItems),
  avoid: z.array(z.string().trim().min(1).max(ASSET_SPEC_LIMITS.avoidItem))
    .max(ASSET_SPEC_LIMITS.avoidItems),
  targetAspectRatio: z.number().positive().max(200),
  generatorPrompt: z.string().trim().min(1).max(ASSET_SPEC_LIMITS.generatorPrompt)
})

export type AssetSpec = z.infer<typeof assetSpecSchema>

export const generationJobStatusSchema = z.enum([
  'processing_prompt',
  'awaiting_confirmation',
  'generating',
  'ready',
  'failed',
  'canceled'
])

export type GenerationJobStatus = z.infer<typeof generationJobStatusSchema>

export const generationErrorCategorySchema = z.enum([
  'authentication',
  'quota',
  'rate_limit',
  'moderation',
  'no_approved_image',
  'timeout',
  'unsupported_transparency',
  'invalid_request',
  'invalid_response',
  'network',
  'service',
  'unknown'
])

export type GenerationErrorCategory = z.infer<typeof generationErrorCategorySchema>

export const generationErrorSchema = z.object({
  category: generationErrorCategorySchema,
  message: z.string()
})

export const previewProcessSchema = z.enum(['upscale', 'refine', 'cutout'])
export type PreviewProcess = z.infer<typeof previewProcessSchema>

export const UPSCALE_DIMENSION_MIN = 16
export const UPSCALE_DIMENSION_MAX = 8192
export const upscaleDimensionsSchema = z.object({
  width: z.number().int().min(UPSCALE_DIMENSION_MIN).max(UPSCALE_DIMENSION_MAX),
  height: z.number().int().min(UPSCALE_DIMENSION_MIN).max(UPSCALE_DIMENSION_MAX)
})
export type UpscaleDimensions = z.infer<typeof upscaleDimensionsSchema>

export const previewProcessRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('upscale'),
    dimensions: upscaleDimensionsSchema
  }).strict(),
  z.object({ action: z.literal('refine') }).strict(),
  z.object({ action: z.literal('cutout') }).strict()
])
export type PreviewProcessRequest = z.infer<typeof previewProcessRequestSchema>

export const previewActionSchema = z.enum([
  'reconfigure',
  'continue_edit',
  'regenerate',
  ...previewProcessSchema.options
])
export type PreviewAction = z.infer<typeof previewActionSchema>

export const imageBackgroundSchema = z.enum(['opaque', 'transparent'])
export type ImageBackground = z.infer<typeof imageBackgroundSchema>

export const generationJobSnapshotSchema = z.object({
  id: z.string().uuid(),
  status: generationJobStatusSchema,
  selection: captureSelectionSchema,
  previewMaxEdge: previewMaxEdgeSchema,
  assetSpec: assetSpecSchema.optional(),
  hasResult: z.boolean(),
  resultBackground: imageBackgroundSchema.optional(),
  pendingAction: previewActionSchema.optional(),
  generationProgress: z.object({
    completed: z.number().int().min(0).max(MAX_GENERATION_COUNT),
    total: generationCountSchema
  }).refine((value) => value.completed <= value.total).optional(),
  error: generationErrorSchema.optional()
})

export type GenerationJobSnapshot = z.infer<typeof generationJobSnapshotSchema>

export const jobIdSchema = z.string().uuid()

export interface JobsApi {
  list(): Promise<GenerationJobSnapshot[]>
  get(id: string): Promise<GenerationJobSnapshot | undefined>
  cancel(id: string): Promise<void>
  onChanged(callback: (job: GenerationJobSnapshot) => void): () => void
}

export const resultVersionIdSchema = z.string().uuid()

export const previewViewStateSchema = z.object({
  job: generationJobSnapshotSchema,
  imageDataUrl: z.string().startsWith('data:image/png;base64,').optional(),
  placeholderDataUrl: z.string().startsWith('data:image/png;base64,').optional(),
  clickThrough: z.boolean(),
  previousVersionId: resultVersionIdSchema.optional(),
  nextVersionId: resultVersionIdSchema.optional()
})

export type PreviewViewState = z.infer<typeof previewViewStateSchema>

export const resultVersionActionSchema = z.enum([
  'capture',
  'initial',
  ...previewActionSchema.options
])
export type ResultVersionAction = z.infer<typeof resultVersionActionSchema>

export const resultVersionSchema = z.object({
  id: resultVersionIdSchema,
  imageDataUrl: z.string().startsWith('data:image/png;base64,'),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  sizeBytes: z.number().int().nonnegative(),
  background: imageBackgroundSchema,
  action: resultVersionActionSchema,
  prompt: z.string().trim().min(1).max(12_000).optional(),
  createdAt: z.number().int().nonnegative()
})

export type ResultVersion = z.infer<typeof resultVersionSchema>

export const imagePropertiesViewStateSchema = z.object({
  jobId: jobIdSchema,
  assetName: z.string().min(1),
  versions: z.array(resultVersionSchema),
  currentVersionId: resultVersionIdSchema.optional(),
  busy: z.boolean()
})

export type ImagePropertiesViewState = z.infer<typeof imagePropertiesViewStateSchema>

export const generatorPromptSchema = z.string().trim().min(1).max(12_000)
export const generationRequestDraftSchema = z.object({
  generatorPrompt: generatorPromptSchema,
  liblibGenerationOptions: star3GenerationOptionsSchema.optional()
})
export type GenerationRequestDraft = z.infer<typeof generationRequestDraftSchema>
export const generationRequestReviewSchema = z.array(z.object({
  uri: z.string().startsWith('/'),
  body: z.record(z.string(), z.unknown())
}))
export type GenerationRequestReview = z.infer<typeof generationRequestReviewSchema>
export const clickThroughSchema = z.boolean()
export const debugImagePathSchema = z.string().trim().min(1).max(4_096)
export const screenPointDipSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite()
})
export type ScreenPointDip = z.infer<typeof screenPointDipSchema>

export interface PreviewApi {
  getState(id: string): Promise<PreviewViewState>
  startDrag(id: string): void
  startMoveDrag(id: string, start: ScreenPointDip): void
  moveDrag(id: string, current: ScreenPointDip): void
  endMoveDrag(id: string): void
  startCloneDrag(id: string, start: ScreenPointDip, current: ScreenPointDip): Promise<void>
  moveCloneDrag(id: string, current: ScreenPointDip): void
  endCloneDrag(id: string): void
  copy(id: string): Promise<void>
  save(id: string): Promise<boolean>
  openProperties(id: string): Promise<void>
  getProperties(id: string): Promise<ImagePropertiesViewState>
  applyVersion(id: string, versionId: string): Promise<GenerationJobSnapshot>
  saveVersion(id: string, versionId: string): Promise<boolean>
  openDetails(id: string): Promise<void>
  getGenerationReview(id: string, draft: GenerationRequestDraft): Promise<GenerationRequestReview>
  confirmGeneration(id: string, draft: GenerationRequestDraft): Promise<GenerationJobSnapshot>
  regenerate(id: string, generatorPrompt?: string): Promise<GenerationJobSnapshot>
  process(id: string, request: PreviewProcessRequest): Promise<GenerationJobSnapshot>
  setClickThrough(id: string, enabled: boolean): Promise<void>
  showMenu(id: string): Promise<void>
  close(id: string): Promise<void>
  onDetailsJobChanged(callback: (id: string) => void): () => void
  onPropertiesJobChanged(callback: (id: string) => void): () => void
}

export interface DebugApi {
  chooseImage(): Promise<string | undefined>
  createPreview(imagePath: string, effectChoice?: GenerationEffectChoice): Promise<void>
}
