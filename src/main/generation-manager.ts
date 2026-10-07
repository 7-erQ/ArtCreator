import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  captureSelectionSchema,
  generationOptionsSchema,
  assetSpecSchema,
  generationRequestDraftSchema,
  generationErrorCategorySchema,
  generationJobSnapshotSchema,
  previewMaxEdgeSchema,
  type CaptureSelection,
  type ComfyUiGenerationOptions,
  type ComfyUiWorkflowBinding,
  type GenerationErrorCategory,
  type GenerationJobSnapshot,
  type GenerationRequestDraft,
  type GenerationRequestReview,
  type ImageModelSelection,
  type PreviewProcess,
  type PreviewProcessRequest,
  type ResultVersionAction,
  type Star3GenerationOptions
} from '../shared/contracts'
import { getImageModelDefinition } from '../shared/image-models'
import { resolveCaptureRegions } from '../shared/capture-regions'
import type { CaptureResult } from './capture-controller'
import {
  calculateSpecifiedImageLayout,
  calculateTargetSizeImageLayout,
  PREVIEW_MAX_EDGE,
  type ImageLayout
} from './image-layout'
import {
  elapsedTimingMs,
  timingNow,
  type TimingLogger
} from './application-logger'
import type {
  ImageBackground,
  ImageGenerator,
  ImageQuality,
  ReferencePngs
} from './image-generator'
import type { PromptPolisher } from './openai-asset-generator'
import { createLiblibTaskRequest, liblibMaxBatchSize } from './liblib-image-generator'
import { sanitizedProviderMessage } from './provider-error'

interface InternalJob {
  snapshot: GenerationJobSnapshot
  controller: AbortController
  workflowId: string
  workflowStartedAtMs: number
  stageStartedAtMs: number
  operation: 'initial' | 'reconfigure' | 'continue_edit' | 'regenerate' | PreviewProcess
  resultPng?: Buffer
  resultVersions: GenerationResultVersion[]
  currentResultVersionId?: string
  placeholderPng?: Buffer
  captureScreenshotPng?: Buffer
  referenceInputPngs?: ReferencePngs
  inpaintSourcePng?: Buffer
  inpaintMaskPng?: Buffer
  captureUpdateRollback?: CaptureUpdateRollback
}

interface CaptureUpdateRollback {
  snapshot: GenerationJobSnapshot
  captureScreenshotPng?: Buffer
  referenceInputPngs?: ReferencePngs
  inpaintSourcePng?: Buffer
  inpaintMaskPng?: Buffer
}

export interface GenerationResultVersion {
  id: string
  png: Buffer
  background: ImageBackground
  action: ResultVersionAction
  prompt?: string
  createdAt: number
}

interface GenerationManagerOptions {
  createPromptPolisher(): PromptPolisher | undefined
  createImageGenerator(
    selection: ImageModelSelection,
    options?: ImageGeneratorConfiguration
  ): ImageGenerator | undefined
  normalizeImage(
    png: Buffer,
    layout: ImageLayout,
    mode?: 'contain' | 'cover'
  ): Buffer
  onChanged?(job: GenerationJobSnapshot): void
  onRequestFailed?(diagnostic: GenerationFailureDiagnostic): void
  onTiming?: TimingLogger
  includeDevelopmentDiagnostics?: boolean
  retryDelayMs?: number
}

export interface ImageGeneratorConfiguration {
  liblibGenerationOptions?: Star3GenerationOptions
  comfyUiGenerationOptions?: ComfyUiGenerationOptions
  comfyUiWorkflowBinding?: ComfyUiWorkflowBinding
  comfyUiWorkflowSeed?: number
}

interface GenerationFailureDiagnostic {
  stage: 'processing_prompt' | 'generating'
  status?: number
  code?: string
  type?: string
  param?: string
  reason?: ProviderErrorReason
  requestId?: string
  providerMessage?: string
  source?: 'response_validation'
  responseStatus?: string
  responseOutputTypes?: string[]
  responseContentTypes?: string[]
  responseOutputCount?: number
  responseIncompleteReason?: string
  responseHasRefusal?: boolean
  responseStreamEventTypes?: string[]
  responseOutputTextDeltaCount?: number
  responseOutputTextDeltaCharacters?: number
  responseOutputText?: string
  responseStreamedOutputJsonValid?: boolean
  responseStreamedOutputShape?: string[]
  responseUsageOutputTokens?: number
  responseUsageReasoningTokens?: number
  elapsedMs?: number
  transport?: TransportFailure
  errorName?: string
  causeName?: string
  causeCode?: string
  imageResponseDataState?: ImageResponseDataState
  imageResponseDataCount?: number
  imageResponseFields?: string[]
  imageResponseOtherFieldCount?: number
  imageResponse?: unknown
}

type ProviderErrorReason = 'unknown' | 'unsupported' | 'missing' | 'invalid' | 'rejected'
type TransportFailure = 'timeout' | 'connection_terminated' | 'connection_error'
type ImageResponseDataState = 'missing' | 'not_array' | 'empty' | 'missing_png'

const KNOWN_PROVIDER_FIELDS = [
  'reasoning.effort',
  'text.format.schema',
  'text.format.type',
  'text.format',
  'response_format',
  'instructions',
  'reasoning',
  'stream',
  'store',
  'input',
  'model'
] as const

const FAKE_PROMPT_PROCESSING_MS = 1_000
const FAKE_IMAGE_GENERATION_MS = 3_000

const PROVIDER_ERROR_REASON_PATTERNS: ReadonlyArray<readonly [ProviderErrorReason, RegExp]> = [
  ['unknown', /unknown|unrecognized/],
  ['unsupported', /unsupported|not supported/],
  ['missing', /missing|required/],
  ['invalid', /invalid/],
  ['rejected', /bad request|request rejected/]
]

class MissingApiConnectionError extends Error {}

const ERROR_MESSAGES: Record<GenerationErrorCategory, string> = {
  authentication: '文本或图片 API 连接无效或尚未完整配置。',
  quota: 'LiblibAI API 积分不足，请充值后重试。',
  rate_limit: '图片服务请求达到限流或并发上限，请稍后重试。',
  moderation: '素材说明可能不符合内容政策，请修改后重试。',
  no_approved_image: 'LiblibAI 未返回审核通过的图片，请调整内容后重试。',
  timeout: '图片生成超时；供应商可能仍在执行已提交的任务。',
  unsupported_transparency: '当前图片服务可能不支持透明背景，请关闭“透明背景（实验）”后重试。',
  invalid_request: '模型服务拒绝了请求，请检查模型与 Base URL 的兼容性。',
  invalid_response: '图片服务返回了无法验证的结果。',
  network: '图片服务连接中断或超时，请检查网络或图片 API 后重试。',
  service: '模型服务暂时不可用，请稍后重试。',
  unknown: '生成任务失败，请稍后重试。'
}

const PROCESSING_PROMPTS: Record<PreviewProcess, string> = {
  upscale: 'Use the source image as the single visual authority. Preserve its composition, subject, style, colors, proportions, and visible content exactly. Render it at the requested resolution with clean edges and faithful detail. Do not add, remove, crop, or alter elements.',
  refine: 'Use the source image as the single visual authority. Preserve its composition, subject, style, colors, proportions, and visible content exactly. Improve fine details, edges, textures, and rendering quality. Do not add, remove, crop, or alter elements.',
  cutout: 'Use the source image as the single visual authority. Preserve the foreground subject, its composition, style, colors, proportions, and visible details exactly. Remove the entire background and return only the foreground on a transparent background. Do not add, remove, crop, or alter foreground elements.'
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined
  return typeof error.status === 'number' ? error.status : undefined
}

function diagnosticToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const token = value.trim()
  if (!token || token.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(token)) {
    return undefined
  }
  return token
}

function errorToken(error: unknown, property: string): string | undefined {
  if (typeof error !== 'object' || error === null || !(property in error)) return undefined
  return diagnosticToken((error as Record<string, unknown>)[property])
}

function errorCode(error: unknown): string | undefined {
  return errorToken(error, 'code')
}

function errorType(error: unknown): string | undefined {
  return errorToken(error, 'type')
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error !== 'object' || error === null || !('message' in error)) return ''
  return typeof error.message === 'string' ? error.message : ''
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<object>()
  let current: unknown = error
  while (current !== undefined && current !== null && chain.length < 4) {
    chain.push(current)
    if (typeof current !== 'object' || seen.has(current)) break
    seen.add(current)
    current = 'cause' in current ? current.cause : undefined
  }
  return chain
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? diagnosticToken(error.name) : errorToken(error, 'name')
}

function transportFailure(error: unknown): TransportFailure | undefined {
  const chain = errorChain(error)
  const messages = chain.map(errorMessage).map((message) => message.toLowerCase())
  if (messages.some((message) => /\b(?:timed?\s*out|timeout)\b/.test(message))) return 'timeout'
  if (messages.some((message) => message.trim() === 'terminated')) return 'connection_terminated'
  if (messages.some((message) => message.includes('connection error') || message.includes('fetch failed'))) {
    return 'connection_error'
  }
  return undefined
}

function transportCause(error: unknown): {
  causeName?: string
  causeCode?: string
} {
  for (const cause of errorChain(error).slice(1)) {
    const causeName = errorName(cause)
    const causeCode = errorToken(cause, 'code')
    if (causeName || causeCode) return { causeName, causeCode }
  }
  return {}
}

function errorParam(error: unknown): string | undefined {
  if (error instanceof z.ZodError) return undefined
  const direct = errorToken(error, 'param')
  if (direct) return direct

  const message = errorMessage(error).toLowerCase()
  return KNOWN_PROVIDER_FIELDS.find((field) => message.includes(field))
}

function errorReason(error: unknown): ProviderErrorReason | undefined {
  if (error instanceof z.ZodError) return undefined
  const message = `${errorCode(error) ?? ''} ${errorMessage(error)}`.toLowerCase()
  return PROVIDER_ERROR_REASON_PATTERNS.find(([, pattern]) => pattern.test(message))?.[0]
}

function errorTokenList(error: unknown, property: string): string[] | undefined {
  if (typeof error !== 'object' || error === null || !(property in error)) return undefined
  const value = (error as Record<string, unknown>)[property]
  if (!Array.isArray(value)) return undefined
  const tokens = [...new Set(value.map(diagnosticToken).filter((token): token is string => Boolean(token)))]
  return tokens.slice(0, 16)
}

function errorBoolean(error: unknown, property: string): boolean | undefined {
  if (typeof error !== 'object' || error === null || !(property in error)) return undefined
  const value = (error as Record<string, unknown>)[property]
  return typeof value === 'boolean' ? value : undefined
}

function errorNonNegativeInteger(error: unknown, property: string): number | undefined {
  if (typeof error !== 'object' || error === null || !(property in error)) return undefined
  const value = (error as Record<string, unknown>)[property]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function errorString(error: unknown, property: string): string | undefined {
  if (typeof error !== 'object' || error === null || !(property in error)) return undefined
  const value = (error as Record<string, unknown>)[property]
  return typeof value === 'string' ? value : undefined
}

function errorImageResponseDataState(error: unknown): ImageResponseDataState | undefined {
  const value = errorToken(error, 'imageResponseDataState')
  return value === 'missing' || value === 'not_array' || value === 'empty' || value === 'missing_png'
    ? value
    : undefined
}

function errorValue(error: unknown, property: string): unknown {
  if (typeof error !== 'object' || error === null || !(property in error)) return undefined
  return (error as Record<string, unknown>)[property]
}

function errorRequestId(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if ('requestID' in error) return diagnosticToken(error.requestID)
  if ('request_id' in error) return diagnosticToken(error.request_id)
  return undefined
}

function classifyError(
  error: unknown,
  stage: GenerationFailureDiagnostic['stage'],
  transparentBackground: boolean
): GenerationErrorCategory {
  if (error instanceof MissingApiConnectionError) return 'authentication'
  if (error instanceof z.ZodError) return 'invalid_response'
  const providerCategory = generationErrorCategorySchema.safeParse(
    errorValue(error, 'providerCategory')
  )
  if (providerCategory.success) return providerCategory.data

  const status = errorStatus(error)
  const code = (errorCode(error) ?? '').toLowerCase()
  const message = errorMessage(error).toLowerCase()
  if (status === 401 || status === 403) return 'authentication'
  if (status === 429) return 'rate_limit'
  if (code.includes('moderation') || code.includes('content_policy') || code.includes('safety') ||
    message.includes('content policy') || message.includes('safety system')) {
    return 'moderation'
  }
  if (status !== undefined && status >= 500) return 'service'
  if (status !== undefined && status >= 400 && status < 500) {
    if (stage === 'generating' && transparentBackground) return 'unsupported_transparency'
    return 'invalid_request'
  }
  if (message.includes('no png data') || message.includes('invalid png')) {
    return 'invalid_response'
  }
  if (transportFailure(error)) return 'network'
  return 'unknown'
}

function isRetryable(error: unknown): boolean {
  if (errorValue(error, 'retryable') === false) return false
  const status = errorStatus(error)
  return status === 429 || (status !== undefined && status >= 500)
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  if (delayMs === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(signal.reason)
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function directAssetSpec(selection: CaptureSelection): NonNullable<GenerationJobSnapshot['assetSpec']> {
  const instruction = selection.instruction
  const output = resolveCaptureRegions(selection).outputRectDip
  return assetSpecSchema.parse({
    version: 1,
    assetName: instruction.slice(0, 80),
    subject: instruction,
    style: '按用户原始提示词',
    composition: '按用户原始提示词',
    palette: [],
    mustPreserve: [],
    avoid: [],
    targetAspectRatio: Number((
      output.width / output.height
    ).toFixed(6)),
    generatorPrompt: instruction
  })
}

function requiresGenerationConfirmation(selection: CaptureSelection): boolean {
  return selection.imageModel.provider === 'liblib' && selection.confirmBeforeGeneration === true
}

function isJobBusy(status: GenerationJobSnapshot['status']): boolean {
  return status === 'processing_prompt' || status === 'awaiting_confirmation' || status === 'generating'
}

function copyReferencePngs(referencePngs: ReferencePngs): [Buffer, ...Buffer[]] {
  const [first, ...remaining] = referencePngs
  return [Buffer.from(first), ...remaining.map((png) => Buffer.from(png))]
}

function generationRequestLayout(
  selection: CaptureSelection,
  previewMaxEdge: number
): ImageLayout {
  const output = resolveCaptureRegions(selection).outputRectDip
  return calculateTargetSizeImageLayout(output.width, output.height, previewMaxEdge)
}

export class GenerationManager {
  private readonly jobs = new Map<string, InternalJob>()

  constructor(private readonly options: GenerationManagerOptions) {}

  start(capture: CaptureResult, previewMaxEdge = PREVIEW_MAX_EDGE): GenerationJobSnapshot {
    const selection = captureSelectionSchema.parse(capture.selection)
    if (!capture.placeholderPng || !capture.screenshotPng) {
      throw new Error('Capture screenshots are missing.')
    }
    if (selection.imageGeneration === 'reference' && capture.referencePngs.length === 0) {
      throw new Error('Reference images are missing.')
    }
    if (selection.imageGeneration === 'inpaint' &&
      (!capture.inpaintSourcePng || !capture.inpaintMaskPng)) {
      throw new Error('Inpaint inputs are missing.')
    }
    if (selection.promptProcessing === 'polish_with_selection' && !capture.markedContextPng) {
      throw new Error('Marked prompt context is missing.')
    }
    const directSpec = capture.submissionMode === 'generate' && selection.promptProcessing === 'direct'
      ? directAssetSpec(selection)
      : undefined
    const awaitingConfirmation = Boolean(directSpec) && requiresGenerationConfirmation(selection)
    const captureVersion: GenerationResultVersion = {
      id: randomUUID(),
      png: Buffer.from(capture.placeholderPng),
      background: 'opaque',
      action: 'capture',
      prompt: selection.instruction,
      createdAt: Date.now()
    }
    const snapshot: GenerationJobSnapshot = {
      id: randomUUID(),
      status: awaitingConfirmation ? 'awaiting_confirmation' : directSpec ? 'generating' : 'processing_prompt',
      selection,
      generationProgress: { completed: 0, total: selection.generationCount },
      previewMaxEdge: previewMaxEdgeSchema.parse(previewMaxEdge),
      ...(directSpec ? { assetSpec: directSpec } : {}),
      hasResult: true,
      resultBackground: 'opaque'
    }
    const job: InternalJob = {
      snapshot,
      controller: new AbortController(),
      workflowId: capture.timing?.workflowId ?? snapshot.id,
      workflowStartedAtMs: capture.timing?.startedAtMs ?? timingNow(),
      stageStartedAtMs: timingNow(),
      operation: 'initial',
      resultPng: Buffer.from(captureVersion.png),
      resultVersions: [captureVersion],
      currentResultVersionId: captureVersion.id,
      captureScreenshotPng: Buffer.from(capture.screenshotPng),
      ...(selection.imageGeneration === 'reference'
        ? { referenceInputPngs: copyReferencePngs(capture.referencePngs) }
        : selection.imageGeneration === 'inpaint'
          ? {
              inpaintSourcePng: Buffer.from(capture.inpaintSourcePng!),
              inpaintMaskPng: Buffer.from(capture.inpaintMaskPng!)
            }
          : {})
    }
    this.jobs.set(snapshot.id, job)
    this.logTiming(job, 'generation_queued', { simulated: capture.submissionMode === 'fake' })
    this.emit(job)
    if (capture.submissionMode === 'fake') {
      void this.runFake(job, capture.placeholderPng)
    } else if (awaitingConfirmation) {
      return this.copySnapshot(snapshot)
    } else {
      void this.run(job, capture)
    }
    return this.copySnapshot(snapshot)
  }

  applyCaptureUpdate(
    id: string,
    capture: CaptureResult,
    previewMaxEdge = PREVIEW_MAX_EDGE
  ): GenerationJobSnapshot {
    const job = this.jobs.get(id)
    if (!job) throw new Error('Preview job no longer exists.')
    if (isJobBusy(job.snapshot.status)) {
      throw new Error('Job is already running.')
    }
    if (!capture.placeholderPng || !capture.screenshotPng) {
      throw new Error('Capture screenshots are missing.')
    }
    if (!capture.followUp || capture.followUp.jobId !== id) {
      throw new Error('Capture update target is missing or mismatched.')
    }

    const selection = captureSelectionSchema.parse(capture.selection)
    if (capture.followUp.action === 'continue_edit' && selection.imageGeneration !== 'reference') {
      throw new Error('Continue edit requires reference generation.')
    }
    if (selection.imageGeneration === 'reference' && capture.referencePngs.length === 0) {
      throw new Error('Reference images are missing.')
    }
    if (selection.imageGeneration === 'inpaint' &&
      (!capture.inpaintSourcePng || !capture.inpaintMaskPng)) {
      throw new Error('Inpaint inputs are missing.')
    }
    if (selection.promptProcessing === 'polish_with_selection' && !capture.markedContextPng) {
      throw new Error('Marked prompt context is missing.')
    }

    const directSpec = capture.submissionMode === 'generate' && selection.promptProcessing === 'direct'
      ? directAssetSpec(selection)
      : undefined
    const awaitingConfirmation = Boolean(directSpec) && requiresGenerationConfirmation(selection)
    job.captureUpdateRollback = {
      snapshot: this.copySnapshot(job.snapshot),
      ...(job.captureScreenshotPng
        ? { captureScreenshotPng: Buffer.from(job.captureScreenshotPng) }
        : {}),
      ...(job.referenceInputPngs
        ? { referenceInputPngs: copyReferencePngs(job.referenceInputPngs) }
        : {}),
      ...(job.inpaintSourcePng ? { inpaintSourcePng: Buffer.from(job.inpaintSourcePng) } : {}),
      ...(job.inpaintMaskPng ? { inpaintMaskPng: Buffer.from(job.inpaintMaskPng) } : {})
    }
    job.controller = new AbortController()
    job.workflowId = capture.timing?.workflowId ?? randomUUID()
    job.workflowStartedAtMs = capture.timing?.startedAtMs ?? timingNow()
    job.stageStartedAtMs = timingNow()
    job.operation = capture.followUp.action
    job.captureScreenshotPng = Buffer.from(capture.screenshotPng)
    job.placeholderPng = undefined
    job.referenceInputPngs = selection.imageGeneration === 'reference'
      ? copyReferencePngs(capture.referencePngs)
      : undefined
    job.inpaintSourcePng = selection.imageGeneration === 'inpaint'
      ? Buffer.from(capture.inpaintSourcePng!)
      : undefined
    job.inpaintMaskPng = selection.imageGeneration === 'inpaint'
      ? Buffer.from(capture.inpaintMaskPng!)
      : undefined
    job.snapshot = {
      ...job.snapshot,
      status: awaitingConfirmation ? 'awaiting_confirmation' : directSpec ? 'generating' : 'processing_prompt',
      selection,
      generationProgress: { completed: 0, total: selection.generationCount },
      previewMaxEdge: previewMaxEdgeSchema.parse(previewMaxEdge),
      assetSpec: directSpec,
      hasResult: Boolean(job.resultPng),
      pendingAction: capture.followUp.action,
      error: undefined
    }
    this.logTiming(job, 'generation_queued', { simulated: capture.submissionMode === 'fake' })
    this.emit(job)
    if (capture.submissionMode === 'fake') {
      void this.runFake(job, capture.placeholderPng)
    } else if (awaitingConfirmation) {
      return this.copySnapshot(job.snapshot)
    } else {
      void this.run(job, capture)
    }
    return this.copySnapshot(job.snapshot)
  }

  createDebugPreview(
    png: Buffer,
    width: number,
    height: number,
    assetName: string
  ): GenerationJobSnapshot {
    if (png.length === 0) throw new Error('Debug image is empty.')
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error('Debug image dimensions are invalid.')
    }

    const selection = captureSelectionSchema.parse({
      displayId: 'debug',
      contextRectDip: { x: 0, y: 0, width, height },
      outputRectDip: { x: 0, y: 0, width, height },
      scaleFactor: 1,
      instruction: assetName.trim() || '调试图片',
      promptProcessing: 'direct',
      promptLanguage: 'zh',
      imageModel: { provider: 'openai', model: 'gpt-image-2' },
      imageGeneration: 'generate',
      transparentBackground: false
    })
    const safeAssetName = assetName.trim().slice(0, 80) || '调试图片'
    const assetSpec = assetSpecSchema.parse({
      version: 1,
      assetName: safeAssetName,
      subject: '调试图片',
      style: '原图',
      composition: '原图',
      palette: [],
      mustPreserve: [],
      avoid: [],
      targetAspectRatio: Math.min(200, Number((width / height).toFixed(6))),
      generatorPrompt: 'Use the supplied debug image as-is.'
    })
    const snapshot = generationJobSnapshotSchema.parse({
      id: randomUUID(),
      status: 'ready',
      selection,
      previewMaxEdge: PREVIEW_MAX_EDGE,
      assetSpec,
      hasResult: true,
      resultBackground: 'opaque'
    })
    const version: GenerationResultVersion = {
      id: randomUUID(),
      png: Buffer.from(png),
      background: 'opaque',
      action: 'initial',
      prompt: assetSpec.generatorPrompt,
      createdAt: Date.now()
    }
    const job: InternalJob = {
      snapshot,
      controller: new AbortController(),
      workflowId: snapshot.id,
      workflowStartedAtMs: timingNow(),
      stageStartedAtMs: timingNow(),
      operation: 'initial',
      resultPng: Buffer.from(version.png),
      resultVersions: [version],
      currentResultVersionId: version.id
    }
    this.jobs.set(snapshot.id, job)
    this.emit(job)
    return this.copySnapshot(snapshot)
  }

  list(): GenerationJobSnapshot[] {
    return [...this.jobs.values()].map((job) => this.copySnapshot(job.snapshot))
  }

  get(id: string): GenerationJobSnapshot | undefined {
    const job = this.jobs.get(id)
    return job ? this.copySnapshot(job.snapshot) : undefined
  }

  getResult(id: string): Buffer | undefined {
    return this.jobs.get(id)?.resultPng
  }

  getPlaceholder(id: string): Buffer | undefined {
    const job = this.jobs.get(id)
    if (!job || job.resultPng) return undefined
    return job.placeholderPng
  }

  getCaptureScreenshot(id: string): Buffer | undefined {
    const png = this.jobs.get(id)?.captureScreenshotPng
    return png ? Buffer.from(png) : undefined
  }

  getResultVersions(id: string): GenerationResultVersion[] {
    const job = this.jobs.get(id)
    if (!job) return []
    return job.resultVersions.map((version) => ({ ...version, png: Buffer.from(version.png) }))
  }

  getCurrentResultVersionId(id: string): string | undefined {
    return this.jobs.get(id)?.currentResultVersionId
  }

  getAdjacentResultVersionIds(id: string): { previousVersionId?: string; nextVersionId?: string } {
    const job = this.jobs.get(id)
    if (!job) return {}
    const index = job.resultVersions.findIndex((version) => version.id === job.currentResultVersionId)
    if (index < 0) return {}
    return {
      previousVersionId: job.resultVersions[index - 1]?.id,
      nextVersionId: job.resultVersions[index + 1]?.id
    }
  }

  clone(id: string): GenerationJobSnapshot {
    const source = this.jobs.get(id)
    if (!source?.resultPng) throw new Error('Preview image is not ready.')

    const cloneId = randomUUID()
    const resultVersions = source.resultVersions.map((version) => ({
      ...version,
      id: randomUUID(),
      png: Buffer.from(version.png)
    }))
    const currentVersionIndex = source.resultVersions.findIndex(
      (version) => version.id === source.currentResultVersionId
    )
    const snapshot = generationJobSnapshotSchema.parse({
      ...source.snapshot,
      id: cloneId,
      status: 'ready',
      hasResult: true,
      generationProgress: undefined,
      pendingAction: undefined,
      error: undefined
    })
    const clone: InternalJob = {
      snapshot,
      controller: new AbortController(),
      workflowId: cloneId,
      workflowStartedAtMs: timingNow(),
      stageStartedAtMs: timingNow(),
      operation: 'initial',
      resultPng: Buffer.from(source.resultPng),
      resultVersions,
      ...(currentVersionIndex < 0
        ? {}
        : { currentResultVersionId: resultVersions[currentVersionIndex]!.id }),
      ...(source.referenceInputPngs
        ? { referenceInputPngs: copyReferencePngs(source.referenceInputPngs) }
        : {}),
      ...(source.inpaintSourcePng
        ? { inpaintSourcePng: Buffer.from(source.inpaintSourcePng) }
        : {}),
      ...(source.inpaintMaskPng ? { inpaintMaskPng: Buffer.from(source.inpaintMaskPng) } : {}),
      ...(source.captureScreenshotPng
        ? { captureScreenshotPng: Buffer.from(source.captureScreenshotPng) }
        : {})
    }
    this.jobs.set(cloneId, clone)
    this.emit(clone)
    return this.copySnapshot(snapshot)
  }

  applyResultVersion(id: string, versionId: string): GenerationJobSnapshot {
    const job = this.jobs.get(id)
    if (!job) throw new Error('Preview job no longer exists.')
    if (isJobBusy(job.snapshot.status)) {
      throw new Error('Cannot change versions while generation is running.')
    }
    const version = job.resultVersions.find((candidate) => candidate.id === versionId)
    if (!version) throw new Error('Image version no longer exists.')

    job.resultPng = Buffer.from(version.png)
    job.currentResultVersionId = version.id
    job.snapshot = {
      ...job.snapshot,
      status: 'ready',
      hasResult: true,
      resultBackground: version.background,
      generationProgress: undefined,
      pendingAction: undefined,
      error: undefined
    }
    this.emit(job)
    return this.copySnapshot(job.snapshot)
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job || job.snapshot.status === 'ready' || job.snapshot.status === 'failed' ||
      job.snapshot.status === 'canceled') return
    job.controller.abort(new DOMException('Generation canceled.', 'AbortError'))
    this.rollbackCaptureUpdate(job)
    job.placeholderPng = undefined
    job.snapshot = {
      ...job.snapshot,
      status: 'canceled',
      hasResult: Boolean(job.resultPng),
      pendingAction: undefined
    }
    this.logTiming(job, 'generation_canceled')
    this.emit(job)
  }

  getGenerationReview(id: string, rawDraft: GenerationRequestDraft): GenerationRequestReview {
    const job = this.jobs.get(id)
    if (!job?.snapshot.assetSpec) throw new Error('Job has no generation request to review.')
    if (job.snapshot.status !== 'awaiting_confirmation') {
      throw new Error('Job is not awaiting generation confirmation.')
    }
    const selection = job.snapshot.selection
    if (selection.imageModel.provider !== 'liblib') {
      throw new Error('Generation request review is only available for LiblibAI models.')
    }
    const draft = generationRequestDraftSchema.parse(rawDraft)
    const updatedSelection = captureSelectionSchema.parse({
      ...selection,
      ...(draft.liblibGenerationOptions
        ? { liblibGenerationOptions: draft.liblibGenerationOptions }
        : {})
    })
    const layout = generationRequestLayout(updatedSelection, job.snapshot.previewMaxEdge)
    const mode = updatedSelection.imageGeneration
    const model = selection.imageModel.model
    const maxBatchSize = liblibMaxBatchSize(model)
    return Array.from({ length: Math.ceil(selection.generationCount / maxBatchSize) }, (_, index) => {
      const request = createLiblibTaskRequest(
        model,
        mode,
        draft.generatorPrompt,
        layout,
        'low',
        mode === 'reference'
          ? { referenceUrl: 'https://upload.invalid/reference.png' }
          : mode === 'inpaint'
            ? {
                imageUrl: 'https://upload.invalid/context.png',
                maskUrl: 'https://upload.invalid/mask.png'
              }
            : {},
        updatedSelection.liblibGenerationOptions,
        Math.min(maxBatchSize, selection.generationCount - index * maxBatchSize)
      )
      return { uri: request.uri, body: request.body }
    })
  }

  confirmGeneration(id: string, rawDraft: GenerationRequestDraft): GenerationJobSnapshot {
    const job = this.jobs.get(id)
    if (!job?.snapshot.assetSpec) throw new Error('Job has no generation request to confirm.')
    if (job.snapshot.status !== 'awaiting_confirmation') {
      throw new Error('Job is not awaiting generation confirmation.')
    }
    const draft = generationRequestDraftSchema.parse(rawDraft)
    const selection = captureSelectionSchema.parse({
      ...job.snapshot.selection,
      ...(draft.liblibGenerationOptions
        ? { liblibGenerationOptions: draft.liblibGenerationOptions }
        : {})
    })
    const assetSpec = assetSpecSchema.parse({
      ...job.snapshot.assetSpec,
      generatorPrompt: draft.generatorPrompt
    })

    job.controller = new AbortController()
    job.stageStartedAtMs = timingNow()
    job.snapshot = {
      ...job.snapshot,
      selection,
      assetSpec,
      status: 'generating',
      error: undefined,
      hasResult: Boolean(job.resultPng)
    }
    this.logTiming(job, 'generation_confirmed')
    this.emit(job)
    void this.runImageGeneration(job)
    return this.copySnapshot(job.snapshot)
  }

  regenerate(id: string, generatorPrompt?: string): GenerationJobSnapshot {
    const job = this.jobs.get(id)
    if (!job?.snapshot.assetSpec) throw new Error('Job has no editable asset specification.')
    if (isJobBusy(job.snapshot.status)) {
      throw new Error('Job is already running.')
    }

    job.controller = new AbortController()
    job.stageStartedAtMs = timingNow()
    job.operation = 'regenerate'
    const assetSpec = assetSpecSchema.parse({
      ...job.snapshot.assetSpec,
      ...(generatorPrompt === undefined ? {} : { generatorPrompt })
    })
    job.snapshot = {
      ...job.snapshot,
      assetSpec,
      status: 'generating',
      error: undefined,
      pendingAction: 'regenerate',
      generationProgress: { completed: 0, total: job.snapshot.selection.generationCount },
      hasResult: Boolean(job.resultPng)
    }
    this.logTiming(job, 'generation_queued')
    this.emit(job)
    void this.runImageGeneration(job)
    return this.copySnapshot(job.snapshot)
  }

  process(id: string, request: PreviewProcessRequest): GenerationJobSnapshot {
    const job = this.jobs.get(id)
    if (!job?.snapshot.assetSpec || !job.resultPng) {
      throw new Error('Preview has no image available for processing.')
    }
    if (isJobBusy(job.snapshot.status)) {
      throw new Error('Job is already running.')
    }
    const action = request.action
    const capabilities = getImageModelDefinition(job.snapshot.selection.imageModel)
    if (!capabilities.supportsEdit || (action === 'cutout' && !capabilities.supportsTransparency)) {
      throw new Error('当前模型不支持此图片处理操作。')
    }

    job.controller = new AbortController()
    job.stageStartedAtMs = timingNow()
    job.operation = action
    job.snapshot = {
      ...job.snapshot,
      status: 'generating',
      error: undefined,
      pendingAction: action,
      generationProgress: undefined,
      hasResult: true
    }
    this.logTiming(job, 'post_process_queued', { action })
    this.emit(job)
    void this.runProcessing(job, request)
    return this.copySnapshot(job.snapshot)
  }

  remove(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.controller.abort()
    job.resultPng = undefined
    job.resultVersions = []
    job.currentResultVersionId = undefined
    job.placeholderPng = undefined
    job.captureScreenshotPng = undefined
    job.referenceInputPngs = undefined
    job.inpaintSourcePng = undefined
    job.inpaintMaskPng = undefined
    job.captureUpdateRollback = undefined
    this.jobs.delete(id)
  }

  dispose(): void {
    this.jobs.forEach((job) => {
      job.controller.abort()
      job.resultPng = undefined
      job.resultVersions = []
      job.currentResultVersionId = undefined
      job.placeholderPng = undefined
      job.captureScreenshotPng = undefined
      job.referenceInputPngs = undefined
      job.inpaintSourcePng = undefined
      job.inpaintMaskPng = undefined
      job.captureUpdateRollback = undefined
    })
    this.jobs.clear()
  }

  private async run(job: InternalJob, capture: CaptureResult): Promise<void> {
    const signal = job.controller.signal
    try {
      const generator = this.createImageGenerator(job)
      if (!generator) throw new MissingApiConnectionError()
      const polisher = job.snapshot.assetSpec ? undefined : this.options.createPromptPolisher()
      if (!job.snapshot.assetSpec && !polisher) throw new MissingApiConnectionError()
      let spec = job.snapshot.assetSpec
      if (!spec) {
        const requestStartedAtMs = timingNow()
        this.logTiming(job, 'prompt_processing_started')
        spec = await this.withRetry(
          () => polisher!.polishPrompt(capture, signal),
          signal,
          job,
          'prompt_processing'
        )
        this.logTiming(job, 'prompt_processing_completed', undefined, requestStartedAtMs)
        if (signal.aborted) return
        const status = requiresGenerationConfirmation(job.snapshot.selection)
          ? 'awaiting_confirmation'
          : 'generating'
        job.snapshot = { ...job.snapshot, assetSpec: spec, status }
        job.stageStartedAtMs = timingNow()
        this.emit(job)
        if (status === 'awaiting_confirmation') return
      }
      await this.generate(job, generator, spec, signal)
    } catch (error) {
      this.fail(job, error, signal)
    }
  }

  private async runFake(job: InternalJob, outputPng: Buffer): Promise<void> {
    const signal = job.controller.signal
    try {
      const promptStartedAtMs = timingNow()
      this.logTiming(job, 'fake_prompt_processing_started')
      await waitForDelay(FAKE_PROMPT_PROCESSING_MS, signal)
      if (signal.aborted) return

      job.snapshot = {
        ...job.snapshot,
        assetSpec: directAssetSpec(job.snapshot.selection),
        status: 'generating'
      }
      job.stageStartedAtMs = timingNow()
      this.logTiming(job, 'fake_prompt_processing_completed', undefined, promptStartedAtMs)
      this.logTiming(job, 'fake_image_generation_started')
      this.emit(job)

      const count = job.snapshot.selection.generationCount
      for (let index = 0; index < count; index += 1) {
        if (signal.aborted) return
        const generationStartedAtMs = timingNow()
        await waitForDelay(FAKE_IMAGE_GENERATION_MS, signal)
        if (signal.aborted) return

        this.publishResult(job, outputPng, 'opaque', job.snapshot.assetSpec!.generatorPrompt)
        job.captureUpdateRollback = undefined
        job.snapshot = {
          ...job.snapshot,
          status: index === count - 1 ? 'ready' : 'generating',
          hasResult: true,
          resultBackground: 'opaque',
          pendingAction: index === count - 1 ? undefined : job.snapshot.pendingAction,
          generationProgress: { completed: index + 1, total: count }
        }
        this.logTiming(job, 'fake_image_generation_completed', undefined, generationStartedAtMs)
        this.emit(job)
      }
      this.logTiming(job, 'generation_completed', { simulated: true })
    } catch (error) {
      this.fail(job, error, signal)
    }
  }

  private async runImageGeneration(job: InternalJob): Promise<void> {
    const signal = job.controller.signal
    try {
      const generator = this.createImageGenerator(job)
      if (!generator) throw new MissingApiConnectionError()
      await this.generate(job, generator, job.snapshot.assetSpec!, signal)
    } catch (error) {
      this.fail(job, error, signal)
    }
  }

  private async generate(
    job: InternalJob,
    generator: ImageGenerator,
    spec: NonNullable<GenerationJobSnapshot['assetSpec']>,
    signal: AbortSignal
  ): Promise<void> {
    const selection = job.snapshot.selection
    const layout = generationRequestLayout(selection, job.snapshot.previewMaxEdge)
    const background: ImageBackground = job.snapshot.selection.transparentBackground
      ? 'transparent'
      : 'opaque'
    const quality: ImageQuality = 'low'
    let completed = 0
    for (let offset = 0; offset < selection.generationCount; offset += generator.maxBatchSize) {
      if (signal.aborted) return
      const count = Math.min(generator.maxBatchSize, selection.generationCount - offset)
      const requestStartedAtMs = timingNow()
      this.logTiming(job, 'image_request_started', {
        count, requestSize: layout.requestSize, canvasWidth: layout.canvasWidth,
        canvasHeight: layout.canvasHeight, background, quality
      })
      const batch = {
        count,
        onImage: (generated: Buffer): void => {
          signal.throwIfAborted()
          const normalizationStartedAtMs = timingNow()
          const normalized = this.options.normalizeImage(
            generated,
            layout,
            getImageModelDefinition(selection.imageModel).normalization
          )
          this.logTiming(job, 'image_normalization_completed', undefined, normalizationStartedAtMs)
          signal.throwIfAborted()
          this.publishResult(job, normalized, background, spec.generatorPrompt)
          completed += 1
          job.captureUpdateRollback = undefined
          job.snapshot = {
            ...job.snapshot,
            hasResult: true,
            resultBackground: background,
            generationProgress: { completed, total: selection.generationCount }
          }
          this.emit(job)
        }
      }
      await this.withRetry(
        () => selection.imageGeneration === 'reference'
          ? generator.reference(spec, job.referenceInputPngs!, layout, background, quality, signal, batch)
          : selection.imageGeneration === 'inpaint'
            ? generator.inpaint(spec, job.inpaintSourcePng!, job.inpaintMaskPng!, layout, background, quality, signal, batch)
            : generator.generate(spec, layout, background, quality, signal, batch),
        signal,
        job,
        'image_generation'
      )
      this.logTiming(job, 'image_request_completed', { count }, requestStartedAtMs)
      if (signal.aborted) return
    }
    job.snapshot = { ...job.snapshot, status: 'ready', pendingAction: undefined }
    this.emit(job)
    this.logTiming(job, 'generation_completed')
  }

  private async runProcessing(job: InternalJob, request: PreviewProcessRequest): Promise<void> {
    const signal = job.controller.signal
    const action = request.action
    try {
      const generator = this.createImageGenerator(job, false)
      if (!generator) throw new MissingApiConnectionError()

      const layout = action === 'upscale'
        ? calculateSpecifiedImageLayout(request.dimensions.width, request.dimensions.height)
        : this.previewLayout(job)
      const background: ImageBackground = action === 'cutout'
        ? 'transparent'
        : job.snapshot.resultBackground ?? (job.snapshot.selection.transparentBackground
          ? 'transparent'
          : 'opaque')
      const quality: ImageQuality = action === 'refine' || action === 'cutout' ? 'high' : 'medium'
      const requestStartedAtMs = timingNow()
      this.logTiming(job, 'post_process_request_started', {
        action, requestSize: layout.requestSize, canvasWidth: layout.canvasWidth,
        canvasHeight: layout.canvasHeight, background, quality
      })
      const processed = await this.withRetry(
        () => generator.edit(
          job.resultPng!,
          PROCESSING_PROMPTS[action],
          layout,
          background,
          quality,
          signal,
          job.snapshot.assetSpec!.avoid
        ),
        signal,
        job,
        'post_process'
      )
      this.logTiming(job, 'post_process_request_completed', { action }, requestStartedAtMs)
      if (signal.aborted) return

      const normalizationStartedAtMs = timingNow()
      const normalized = this.options.normalizeImage(
        processed,
        layout,
        getImageModelDefinition(job.snapshot.selection.imageModel).normalization
      )
      this.logTiming(job, 'image_normalization_completed', { action }, normalizationStartedAtMs)
      if (signal.aborted) return
      this.publishResult(job, normalized, background, PROCESSING_PROMPTS[action])
      job.snapshot = {
        ...job.snapshot,
        status: 'ready',
        hasResult: true,
        resultBackground: background,
        pendingAction: undefined
      }
      this.logTiming(job, 'post_process_completed', { action })
      this.emit(job)
    } catch (error) {
      this.fail(job, error, signal)
    }
  }

  private fail(job: InternalJob, error: unknown, signal: AbortSignal): void {
    if (signal.aborted || job.snapshot.status === 'canceled') return
    const stage = job.snapshot.status === 'generating' ? 'generating' : 'processing_prompt'
    const category = classifyError(error, stage, job.snapshot.selection.transparentBackground)
    const transport = transportFailure(error)
    const cause = transportCause(error)
    this.logTiming(job, 'generation_failed', { category })
    this.options.onRequestFailed?.({
      stage,
      ...(errorStatus(error) === undefined ? {} : { status: errorStatus(error) }),
      ...(errorCode(error) ? { code: errorCode(error) } : {}),
      ...(errorType(error) ? { type: errorType(error) } : {}),
      ...(errorParam(error) ? { param: errorParam(error) } : {}),
      ...(errorReason(error) ? { reason: errorReason(error) } : {}),
      ...(errorRequestId(error) ? { requestId: errorRequestId(error) } : {}),
      ...(this.options.includeDevelopmentDiagnostics
        ? {
            providerMessage: sanitizedProviderMessage(error),
            ...(transport
              ? {
                  elapsedMs: Math.max(0, Math.round(timingNow() - job.stageStartedAtMs)),
                  transport,
                  ...(errorName(error) ? { errorName: errorName(error) } : {}),
                  ...(cause.causeName ? { causeName: cause.causeName } : {}),
                  ...(cause.causeCode ? { causeCode: cause.causeCode } : {})
                }
              : {}),
            ...(errorImageResponseDataState(error)
              ? {
                  imageResponseDataState: errorImageResponseDataState(error),
                  ...(errorNonNegativeInteger(error, 'imageResponseDataCount') === undefined
                    ? {}
                    : { imageResponseDataCount: errorNonNegativeInteger(error, 'imageResponseDataCount') }),
                  ...(errorTokenList(error, 'imageResponseFields')
                    ? { imageResponseFields: errorTokenList(error, 'imageResponseFields') }
                    : {}),
                  ...(errorNonNegativeInteger(error, 'imageResponseOtherFieldCount') === undefined
                    ? {}
                    : {
                        imageResponseOtherFieldCount:
                          errorNonNegativeInteger(error, 'imageResponseOtherFieldCount')
                      }),
                  ...(errorValue(error, 'imageResponse') === undefined
                    ? {}
                    : { imageResponse: errorValue(error, 'imageResponse') })
                }
              : {}),
            ...(error instanceof z.ZodError ? { source: 'response_validation' as const } : {}),
            ...(errorToken(error, 'responseStatus')
              ? { responseStatus: errorToken(error, 'responseStatus') }
              : {}),
            ...(errorTokenList(error, 'responseOutputTypes')
              ? { responseOutputTypes: errorTokenList(error, 'responseOutputTypes') }
              : {}),
            ...(errorTokenList(error, 'responseContentTypes')
              ? { responseContentTypes: errorTokenList(error, 'responseContentTypes') }
              : {}),
            ...(errorNonNegativeInteger(error, 'responseOutputCount') === undefined
              ? {}
              : { responseOutputCount: errorNonNegativeInteger(error, 'responseOutputCount') }),
            ...(errorToken(error, 'responseIncompleteReason')
              ? { responseIncompleteReason: errorToken(error, 'responseIncompleteReason') }
              : {}),
            ...(errorBoolean(error, 'responseHasRefusal') === undefined
              ? {}
              : { responseHasRefusal: errorBoolean(error, 'responseHasRefusal') }),
            ...(errorTokenList(error, 'responseStreamEventTypes')
              ? { responseStreamEventTypes: errorTokenList(error, 'responseStreamEventTypes') }
              : {}),
            ...(errorNonNegativeInteger(error, 'responseOutputTextDeltaCount') === undefined
              ? {}
              : {
                  responseOutputTextDeltaCount:
                    errorNonNegativeInteger(error, 'responseOutputTextDeltaCount')
                }),
            ...(errorNonNegativeInteger(error, 'responseOutputTextDeltaCharacters') === undefined
              ? {}
              : {
                  responseOutputTextDeltaCharacters:
                    errorNonNegativeInteger(error, 'responseOutputTextDeltaCharacters')
                }),
            ...(errorString(error, 'responseOutputText') === undefined
              ? {}
              : { responseOutputText: errorString(error, 'responseOutputText') }),
            ...(errorBoolean(error, 'responseStreamedOutputJsonValid') === undefined
              ? {}
              : {
                  responseStreamedOutputJsonValid:
                    errorBoolean(error, 'responseStreamedOutputJsonValid')
                }),
            ...(errorTokenList(error, 'responseStreamedOutputShape')
              ? { responseStreamedOutputShape: errorTokenList(error, 'responseStreamedOutputShape') }
              : {}),
            ...(errorNonNegativeInteger(error, 'responseUsageOutputTokens') === undefined
              ? {}
              : {
                  responseUsageOutputTokens:
                    errorNonNegativeInteger(error, 'responseUsageOutputTokens')
                }),
            ...(errorNonNegativeInteger(error, 'responseUsageReasoningTokens') === undefined
              ? {}
              : {
                  responseUsageReasoningTokens:
                    errorNonNegativeInteger(error, 'responseUsageReasoningTokens')
                })
          }
        : {})
    })
    this.rollbackCaptureUpdate(job)
    job.snapshot = {
      ...job.snapshot,
      status: 'failed',
      hasResult: Boolean(job.resultPng),
      error: {
        category,
        message: category === 'unsupported_transparency' && job.snapshot.pendingAction === 'cutout'
          ? '当前图片服务可能不支持透明背景，无法完成抠图。'
          : category === 'invalid_response' && stage === 'processing_prompt'
            ? '文本模型返回了无法验证的提示词结果。'
          : ERROR_MESSAGES[category]
      }
    }
    this.emit(job)
  }

  private rollbackCaptureUpdate(job: InternalJob): void {
    const rollback = job.captureUpdateRollback
    if (!rollback) return
    job.snapshot = {
      ...job.snapshot,
      selection: rollback.snapshot.selection,
      previewMaxEdge: rollback.snapshot.previewMaxEdge,
      assetSpec: rollback.snapshot.assetSpec
    }
    job.captureScreenshotPng = rollback.captureScreenshotPng
    job.referenceInputPngs = rollback.referenceInputPngs
    job.inpaintSourcePng = rollback.inpaintSourcePng
    job.inpaintMaskPng = rollback.inpaintMaskPng
    job.captureUpdateRollback = undefined
  }

  private publishResult(
    job: InternalJob,
    png: Buffer,
    background: ImageBackground,
    prompt?: string
  ): void {
    const version: GenerationResultVersion = {
      id: randomUUID(),
      png: Buffer.from(png),
      background,
      action: job.operation,
      ...(prompt ? { prompt } : {}),
      createdAt: Date.now()
    }
    job.resultVersions.push(version)
    job.currentResultVersionId = version.id
    job.resultPng = Buffer.from(version.png)
    job.placeholderPng = undefined
  }

  private previewLayout(job: InternalJob): ImageLayout {
    const output = resolveCaptureRegions(job.snapshot.selection).outputRectDip
    return calculateTargetSizeImageLayout(output.width, output.height, job.snapshot.previewMaxEdge)
  }

  private createImageGenerator(
    job: InternalJob,
    includeGenerationOptions = true
  ): ImageGenerator | undefined {
    const {
      imageModel,
      liblibGenerationOptions,
      comfyUiGenerationOptions,
      comfyUiWorkflowBinding,
      comfyUiWorkflowSeed
    } = job.snapshot.selection
    const options: ImageGeneratorConfiguration = {
      ...(includeGenerationOptions && liblibGenerationOptions
        ? { liblibGenerationOptions }
        : {}),
      ...(comfyUiGenerationOptions ? { comfyUiGenerationOptions } : {}),
      ...(comfyUiWorkflowBinding ? { comfyUiWorkflowBinding } : {}),
      ...(comfyUiWorkflowSeed !== undefined ? { comfyUiWorkflowSeed } : {})
    }
    return Object.keys(options).length > 0
      ? this.options.createImageGenerator(imageModel, options)
      : this.options.createImageGenerator(imageModel)
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
    job: InternalJob,
    stage: 'prompt_processing' | 'image_generation' | 'post_process'
  ): Promise<T> {
    const initialCompleted = job.snapshot.generationProgress?.completed
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        if (signal.aborted || !isRetryable(error) || attempt >= 2 ||
          job.snapshot.generationProgress?.completed !== initialCompleted) throw error
        this.logTiming(job, 'request_retry_scheduled', { stage, attempt: attempt + 1 })
        await waitForDelay((this.options.retryDelayMs ?? 250) * (2 ** attempt), signal)
      }
    }
  }

  private logTiming(
    job: InternalJob,
    event: string,
    details?: Record<string, string | number | boolean>,
    stageStartedAtMs = job.stageStartedAtMs
  ): void {
    this.options.onTiming?.({
      flow: 'generation',
      event,
      workflowId: job.workflowId.slice(0, 8),
      generation: {
        jobId: job.snapshot.id,
        status: event === 'generation_failed' ? 'failed' : job.snapshot.status,
        options: generationOptionsSchema.parse(job.snapshot.selection),
        completed: job.snapshot.generationProgress?.completed,
        ...(['generation_queued', 'post_process_queued'].includes(event)
          ? { instruction: job.snapshot.selection.instruction } : {}),
        ...((event === 'image_request_started' || event === 'fake_image_generation_started')
          ? { generatorPrompt: job.snapshot.assetSpec!.generatorPrompt } : {}),
        ...(event === 'post_process_request_started' &&
          (job.operation === 'upscale' || job.operation === 'refine' || job.operation === 'cutout')
          ? { generatorPrompt: PROCESSING_PROMPTS[job.operation] } : {})
      },
      totalMs: elapsedTimingMs(job.workflowStartedAtMs),
      stageMs: elapsedTimingMs(stageStartedAtMs),
      details: {
        operation: job.operation,
        ...(details ?? {})
      }
    })
  }

  private emit(job: InternalJob): void {
    this.options.onChanged?.(this.copySnapshot(job.snapshot))
  }

  private copySnapshot(snapshot: GenerationJobSnapshot): GenerationJobSnapshot {
    return generationJobSnapshotSchema.parse(snapshot)
  }
}
