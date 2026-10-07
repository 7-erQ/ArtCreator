import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  comfyUiCapabilitiesSchema,
  comfyUiGenerationOptionsSchema,
  comfyUiCheckpointSchema,
  comfyUiWorkflowBindingSchema,
  comfyUiWorkflowSummariesSchema,
  type AssetSpec,
  type ComfyUiCapabilities,
  type ComfyUiGenerationOptions,
  type ComfyUiWorkflowBinding,
  type GenerationErrorCategory
} from '../shared/contracts'
import { calculateImageLayout, type ImageLayout } from './image-layout'
import type {
  ImageBackground,
  ImageBatch,
  ImageGenerator,
  ImageQuality,
  ReferencePngs
} from './image-generator'
import { prepareSingleImageReference } from './reference-images'
import type {
  ComfyUiWorkflowConverter,
  ComfyUiWorkflowConversion
} from './comfyui-workflow-converter'

export interface ComfyUiConnection {
  baseUrl: string
}

export interface ComfyUiGeneratorOptions {
  requestFetch?: typeof fetch
  pollIntervalMs?: number
  timeoutMs?: number
  cancelTimeoutMs?: number
  delay?: (durationMs: number, signal: AbortSignal) => Promise<void>
  randomSeed?: () => number
  generationOptions: ComfyUiGenerationOptions
}

export type ComfyUiWorkflow = Record<string, {
  class_type: string
  inputs: Record<string, unknown>
}>

type WorkflowMode = 'generate' | 'reference' | 'inpaint' | 'upscale' | 'refine'

interface WorkflowInput {
  source?: string
  mask?: string
}

const CORE_NODE_CLASSES = [
  'CheckpointLoaderSimple',
  'CLIPTextEncode',
  'EmptyLatentImage',
  'KSampler',
  'VAEDecode',
  'PreviewImage',
  'LoadImage',
  'ImageScale',
  'VAEEncode',
  'VAEEncodeForInpaint'
] as const
const DEFAULT_POLL_INTERVAL_MS = 500
export const COMFYUI_REQUEST_TIMEOUT_MS = 600_000
const DEFAULT_CANCEL_TIMEOUT_MS = 2_000
const MAX_REFINEMENT_DENOISING_STRENGTH = 0.15
const MAX_RESULT_BYTES = 25 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const promptResponseSchema = z.object({
  prompt_id: z.string().uuid(),
  node_errors: z.record(z.string(), z.unknown())
}).passthrough()

const uploadResponseSchema = z.object({
  name: z.string().min(1).max(512),
  subfolder: z.string().max(512),
  type: z.literal('temp')
})

const historyImageSchema = z.object({
  filename: z.string().min(1).max(512),
  subfolder: z.string().max(512),
  type: z.enum(['temp', 'output'])
}).passthrough()

const userdataWorkflowListSchema = z.array(z.union([
  z.string(),
  z.object({
    path: z.string(),
    modified: z.number().int().nonnegative().optional()
  })
])).max(2_048)

const historyEntrySchema = z.object({
  outputs: z.record(z.string(), z.object({
    images: z.array(historyImageSchema).optional()
  }).passthrough()),
  status: z.object({
    status_str: z.string().optional(),
    completed: z.boolean().optional(),
    messages: z.array(z.unknown()).optional()
  }).passthrough().optional()
}).passthrough()

const historyResponseSchema = z.record(z.string(), historyEntrySchema)
const objectInfoResponseSchema = z.record(z.string(), z.unknown())
const systemStatsSchema = z.record(z.string(), z.unknown()).refine(
  (value) => Object.keys(value).length > 0,
  'ComfyUI returned empty system status.'
)

export class ComfyUiApiError extends Error {
  readonly retryable = false

  constructor(
    message: string,
    readonly status?: number,
    readonly providerCategory: GenerationErrorCategory = 'invalid_response'
  ) {
    super(message)
    this.name = 'ComfyUiApiError'
  }
}

function waitForDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, durationMs)
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function randomSafeSeed(): number {
  return randomBytes(6).readUIntBE(0, 6)
}

function safeRelativePath(value: string, allowEmpty = false): string {
  if (allowEmpty && value === '') return value
  if (!value || value.includes('\0') || value.includes('\r') || value.includes('\n') ||
    /^(?:[A-Za-z]:|[\\/])/.test(value) ||
    value.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..')) {
    throw new ComfyUiApiError('ComfyUI returned an unsafe relative image path.')
  }
  return value.replaceAll('\\', '/')
}

function annotatedTempName(file: { name: string; subfolder: string }): string {
  const name = safeRelativePath(file.name)
  const subfolder = safeRelativePath(file.subfolder, true)
  return `${subfolder ? `${subfolder}/` : ''}${name} [temp]`
}

function nodeDefinition(raw: unknown, nodeClass: string): Record<string, unknown> {
  const parsed = objectInfoResponseSchema.parse(raw)
  const definition = parsed[nodeClass]
  if (typeof definition !== 'object' || definition === null) {
    throw new ComfyUiApiError(`ComfyUI is missing required core node ${nodeClass}.`)
  }
  return definition as Record<string, unknown>
}

function requiredInputs(definition: Record<string, unknown>): Record<string, unknown> {
  const input = definition.input
  if (typeof input !== 'object' || input === null) {
    throw new ComfyUiApiError('ComfyUI returned an invalid core node definition.')
  }
  const required = (input as Record<string, unknown>).required
  if (typeof required !== 'object' || required === null) {
    throw new ComfyUiApiError('ComfyUI returned an incomplete core node definition.')
  }
  return required as Record<string, unknown>
}

function enumChoices(
  definition: Record<string, unknown>,
  field: string,
  schema: z.ZodType<string>
): string[] {
  const descriptor = requiredInputs(definition)[field]
  const choices = Array.isArray(descriptor) ? descriptor[0] : undefined
  if (!Array.isArray(choices)) {
    throw new ComfyUiApiError(`ComfyUI core node is missing ${field} choices.`)
  }
  const parsed = z.array(schema).min(1).parse(choices)
  return [...new Set(parsed)]
}

function executionFailed(entry: z.infer<typeof historyEntrySchema>): boolean {
  if (entry.status?.status_str === 'error') return true
  return entry.status?.messages?.some((message) =>
    Array.isArray(message) && message[0] === 'execution_error') ?? false
}

function workflowBase(
  checkpoint: string,
  prompt: string,
  negativePrompt: string
): ComfyUiWorkflow {
  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: checkpoint }
    },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: { text: prompt, clip: ['1', 1] }
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: negativePrompt, clip: ['1', 1] }
    }
  }
}

function samplerInputs(
  latentNodeId: string,
  options: ComfyUiGenerationOptions,
  seed: number,
  denoise: number
): Record<string, unknown> {
  return {
    model: ['1', 0],
    seed,
    steps: options.steps,
    cfg: options.cfg,
    sampler_name: options.samplerName,
    scheduler: options.scheduler,
    positive: ['2', 0],
    negative: ['3', 0],
    latent_image: [latentNodeId, 0],
    denoise
  }
}

export function comfyUiSamplingDimensions(layout: ImageLayout): { width: number; height: number } {
  const sampling = calculateImageLayout(layout.requestWidth, layout.requestHeight)
  return { width: sampling.requestWidth, height: sampling.requestHeight }
}

export function createComfyUiWorkflow(
  mode: WorkflowMode,
  checkpoint: string,
  prompt: string,
  negativePrompt: string,
  layout: ImageLayout,
  options: ComfyUiGenerationOptions,
  seed: number,
  input: WorkflowInput = {}
): { prompt: ComfyUiWorkflow; outputNodeId: string } {
  const validatedCheckpoint = comfyUiCheckpointSchema.parse(checkpoint)
  const validatedOptions = comfyUiGenerationOptionsSchema.parse(options)
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new ComfyUiApiError('ComfyUI seed must be a non-negative safe integer.', undefined, 'invalid_request')
  }
  const { width, height } = mode === 'upscale'
    ? { width: layout.requestWidth, height: layout.requestHeight }
    : comfyUiSamplingDimensions(layout)

  if (mode === 'upscale') {
    if (!input.source) throw new ComfyUiApiError('ComfyUI upscale input is missing.', undefined, 'invalid_request')
    return {
      prompt: {
        '1': { class_type: 'LoadImage', inputs: { image: input.source } },
        '2': {
          class_type: 'ImageScale',
          inputs: {
            image: ['1', 0],
            upscale_method: 'lanczos',
            width,
            height,
            crop: 'center'
          }
        },
        '3': { class_type: 'PreviewImage', inputs: { images: ['2', 0] } }
      },
      outputNodeId: '3'
    }
  }

  const promptGraph = workflowBase(validatedCheckpoint, prompt, negativePrompt)

  if (mode === 'generate') {
    promptGraph['4'] = {
      class_type: 'EmptyLatentImage',
      inputs: { width, height, batch_size: 1 }
    }
    promptGraph['5'] = {
      class_type: 'KSampler',
      inputs: samplerInputs('4', validatedOptions, seed, 1)
    }
    promptGraph['6'] = {
      class_type: 'VAEDecode',
      inputs: { samples: ['5', 0], vae: ['1', 2] }
    }
    promptGraph['7'] = { class_type: 'PreviewImage', inputs: { images: ['6', 0] } }
    return { prompt: promptGraph, outputNodeId: '7' }
  }

  if (mode === 'reference' || mode === 'refine') {
    if (!input.source) throw new ComfyUiApiError('ComfyUI reference input is missing.', undefined, 'invalid_request')
    promptGraph['4'] = { class_type: 'LoadImage', inputs: { image: input.source } }
    promptGraph['5'] = {
      class_type: 'ImageScale',
      inputs: {
        image: ['4', 0],
        upscale_method: 'lanczos',
        width,
        height,
        crop: 'center'
      }
    }
    promptGraph['6'] = {
      class_type: 'VAEEncode',
      inputs: { pixels: ['5', 0], vae: ['1', 2] }
    }
    promptGraph['7'] = {
      class_type: 'KSampler',
      inputs: samplerInputs(
        '6',
        validatedOptions,
        seed,
        mode === 'refine'
          ? Math.min(validatedOptions.denoisingStrength, MAX_REFINEMENT_DENOISING_STRENGTH)
          : validatedOptions.denoisingStrength
      )
    }
    promptGraph['8'] = {
      class_type: 'VAEDecode',
      inputs: { samples: ['7', 0], vae: ['1', 2] }
    }
    promptGraph['9'] = { class_type: 'PreviewImage', inputs: { images: ['8', 0] } }
    return { prompt: promptGraph, outputNodeId: '9' }
  }

  if (!input.source || !input.mask) {
    throw new ComfyUiApiError('ComfyUI inpaint inputs are missing.', undefined, 'invalid_request')
  }
  promptGraph['4'] = { class_type: 'LoadImage', inputs: { image: input.source } }
  promptGraph['5'] = {
    class_type: 'ImageScale',
    inputs: {
      image: ['4', 0],
      upscale_method: 'lanczos',
      width,
      height,
      crop: 'disabled'
    }
  }
  promptGraph['6'] = { class_type: 'LoadImage', inputs: { image: input.mask } }
  promptGraph['7'] = {
    class_type: 'VAEEncodeForInpaint',
    inputs: {
      pixels: ['5', 0],
      vae: ['1', 2],
      mask: ['6', 1],
      grow_mask_by: 6
    }
  }
  promptGraph['8'] = {
    class_type: 'KSampler',
    inputs: samplerInputs('7', validatedOptions, seed, validatedOptions.denoisingStrength)
  }
  promptGraph['9'] = {
    class_type: 'VAEDecode',
    inputs: { samples: ['8', 0], vae: ['1', 2] }
  }
  promptGraph['10'] = { class_type: 'PreviewImage', inputs: { images: ['9', 0] } }
  return { prompt: promptGraph, outputNodeId: '10' }
}

class ComfyUiProtocol {
  private readonly requestFetch: typeof fetch
  private readonly delay: (durationMs: number, signal: AbortSignal) => Promise<void>

  constructor(
    private readonly connection: ComfyUiConnection,
    requestFetch: typeof fetch = fetch,
    delay: (durationMs: number, signal: AbortSignal) => Promise<void> = waitForDelay
  ) {
    this.requestFetch = requestFetch
    this.delay = delay
  }

  async capabilities(signal: AbortSignal): Promise<ComfyUiCapabilities> {
    const [systemStats, workflows, coreCapabilities] = await Promise.all([
      this.retrySafe(() => this.json('/system_stats', { signal }, signal), signal),
      this.workflows(signal).catch((error: unknown) => {
        if (signal.aborted) throw error
        return []
      }),
      Promise.all(CORE_NODE_CLASSES.map((nodeClass) => this.retrySafe(
        () => this.json(`/object_info/${encodeURIComponent(nodeClass)}`, { signal }, signal),
        signal
      ))).then((nodeResponses) => {
        const definitions = new Map(CORE_NODE_CLASSES.map((nodeClass, index) => [
          nodeClass,
          nodeDefinition(nodeResponses[index], nodeClass)
        ]))
        const checkpointLoader = definitions.get('CheckpointLoaderSimple')!
        const sampler = definitions.get('KSampler')!
        return {
          checkpoints: enumChoices(checkpointLoader, 'ckpt_name', comfyUiCheckpointSchema),
          samplers: enumChoices(sampler, 'sampler_name', z.string().trim().min(1).max(200)),
          schedulers: enumChoices(sampler, 'scheduler', z.string().trim().min(1).max(200))
        }
      }).catch((error: unknown) => {
        if (signal.aborted) throw error
        return undefined
      })
    ])
    systemStatsSchema.parse(systemStats)
    if (!coreCapabilities && workflows.length === 0) {
      throw new ComfyUiApiError('ComfyUI has no usable core model or saved workflow.')
    }
    return comfyUiCapabilitiesSchema.parse({
      available: true,
      checkpoints: coreCapabilities?.checkpoints ?? [],
      samplers: coreCapabilities?.samplers ?? [],
      schedulers: coreCapabilities?.schedulers ?? [],
      workflows
    })
  }

  async workflows(signal: AbortSignal): Promise<ComfyUiCapabilities['workflows']> {
    const raw = await this.retrySafe(() => this.json(
      '/api/userdata?dir=workflows&recurse=true&split=false&full_info=true',
      { signal },
      signal
    ), signal)
    const listed = userdataWorkflowListSchema.parse(raw)
    const summaries = listed.flatMap((entry) => {
      const path = typeof entry === 'string' ? entry : entry.path
      const workflowPath = `workflows/${path.replaceAll('\\', '/')}`
      if (!workflowPath.toLowerCase().endsWith('.json')) return []
      return [{
        path: workflowPath,
        ...(typeof entry === 'object' && entry.modified !== undefined
          ? { modified: entry.modified }
          : {})
      }]
    })
    return comfyUiWorkflowSummariesSchema.parse(summaries)
  }

  async upload(png: Buffer, signal: AbortSignal): Promise<string> {
    if (png.length < PNG_SIGNATURE.length ||
      !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new ComfyUiApiError('ComfyUI upload input is not a valid PNG.', undefined, 'invalid_request')
    }
    const form = new FormData()
    form.append(
      'image',
      new Blob([new Uint8Array(png)], { type: 'image/png' }),
      `art-creator-${randomUUID()}.png`
    )
    form.append('type', 'temp')
    form.append('overwrite', 'false')
    const raw = await this.json('/upload/image', { method: 'POST', body: form, signal }, signal, 'invalid_request')
    const uploaded = uploadResponseSchema.parse(raw)
    return annotatedTempName(uploaded)
  }

  async submit(
    promptId: string,
    prompt: ComfyUiWorkflow,
    signal: AbortSignal
  ): Promise<void> {
    const raw = await this.json('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt_id: promptId, prompt }),
      signal
    }, signal, 'invalid_request')
    const submitted = promptResponseSchema.parse(raw)
    if (submitted.prompt_id !== promptId) {
      throw new ComfyUiApiError('ComfyUI returned a mismatched prompt identifier.')
    }
    if (Object.keys(submitted.node_errors).length > 0) {
      throw new ComfyUiApiError('ComfyUI rejected the workflow.', undefined, 'invalid_request')
    }
  }

  async poll(
    promptId: string,
    outputNodeId: string,
    intervalMs: number,
    signal: AbortSignal
  ): Promise<Buffer> {
    for (;;) {
      await this.delay(intervalMs, signal)
      const raw = await this.retrySafe(
        () => this.json(`/history/${encodeURIComponent(promptId)}`, { signal }, signal),
        signal
      )
      const history = historyResponseSchema.parse(raw)
      const entry = history[promptId]
      if (!entry) continue
      if (executionFailed(entry)) {
        throw new ComfyUiApiError('ComfyUI workflow execution failed.', undefined, 'service')
      }
      const images = entry.outputs[outputNodeId]?.images
      if (images) {
        if (images.length !== 1) {
          throw new ComfyUiApiError('ComfyUI returned an unexpected number of preview images.')
        }
        return this.retrySafe(() => this.download(images[0]!, signal), signal)
      }
      if (entry.status?.completed) {
        throw new ComfyUiApiError('ComfyUI completed without a preview PNG.')
      }
    }
  }

  async cancel(promptId: string, timeoutMs: number): Promise<void> {
    const request = async (uri: string, body: unknown): Promise<void> => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        await this.noContent(uri, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        })
      } catch {
        // Cancellation is best-effort and must not replace the original failure.
      } finally {
        clearTimeout(timeout)
      }
    }
    await Promise.all([
      request('/queue', { delete: [promptId] }),
      request('/interrupt', { prompt_id: promptId })
    ])
  }

  private async download(
    image: z.infer<typeof historyImageSchema>,
    signal: AbortSignal
  ): Promise<Buffer> {
    const filename = safeRelativePath(image.filename)
    const subfolder = safeRelativePath(image.subfolder, true)
    const target = this.url('/view')
    target.searchParams.set('filename', filename)
    target.searchParams.set('subfolder', subfolder)
    target.searchParams.set('type', image.type)
    const response = await this.request(target, { signal, redirect: 'error' })
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    const declaredLength = Number(response.headers.get('content-length'))
    if (!response.ok || contentType !== 'image/png' || !response.body ||
      (Number.isSafeInteger(declaredLength) && declaredLength > MAX_RESULT_BYTES)) {
      throw this.responseError(response.status, 'invalid_response')
    }

    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_RESULT_BYTES) {
          await reader.cancel()
          throw new ComfyUiApiError('ComfyUI preview PNG exceeds the size limit.')
        }
        chunks.push(Buffer.from(value))
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof ComfyUiApiError) throw error
      throw new ComfyUiApiError('ComfyUI preview download failed.', undefined, 'network')
    } finally {
      reader.releaseLock()
    }
    const png = Buffer.concat(chunks, total)
    if (png.length < PNG_SIGNATURE.length ||
      !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new ComfyUiApiError('ComfyUI returned an invalid PNG signature.')
    }
    return png
  }

  private async json(
    uri: string,
    init: RequestInit,
    signal: AbortSignal,
    clientErrorCategory: GenerationErrorCategory = 'invalid_response'
  ): Promise<unknown> {
    const response = await this.request(this.url(uri), { ...init, signal, redirect: 'error' })
    if (!response.ok) throw this.responseError(response.status, clientErrorCategory)
    try {
      return await response.json() as unknown
    } catch {
      throw new ComfyUiApiError('ComfyUI returned invalid JSON.', response.status)
    }
  }

  private async noContent(uri: string, init: RequestInit): Promise<void> {
    const response = await this.request(this.url(uri), { ...init, redirect: 'error' })
    if (!response.ok) throw this.responseError(response.status, 'service')
  }

  private url(uri: string): URL {
    return new URL(`${this.connection.baseUrl.replace(/\/+$/, '')}${uri}`)
  }

  private responseError(
    status: number,
    clientErrorCategory: GenerationErrorCategory
  ): ComfyUiApiError {
    return new ComfyUiApiError(
      status >= 500 ? 'ComfyUI service is unavailable.' : 'ComfyUI rejected the request.',
      status,
      status >= 500 ? 'service' : clientErrorCategory
    )
  }

  private async request(target: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.requestFetch(target, init)
    } catch {
      if (init.signal?.aborted) throw init.signal.reason
      throw new ComfyUiApiError('ComfyUI network request failed.', undefined, 'network')
    }
  }

  private async retrySafe<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        const status = error instanceof ComfyUiApiError ? error.status : undefined
        const category = error instanceof ComfyUiApiError ? error.providerCategory : undefined
        if (signal.aborted || attempt >= 2 ||
          !(category === 'network' || status === 429 || (status !== undefined && status >= 500))) {
          throw error
        }
        await this.delay(250 * (2 ** attempt), signal)
      }
    }
  }
}

export async function getComfyUiCapabilities(
  connection: ComfyUiConnection,
  requestFetch: typeof fetch,
  signal: AbortSignal
): Promise<ComfyUiCapabilities> {
  return new ComfyUiProtocol(connection, requestFetch).capabilities(signal)
}

export async function listComfyUiWorkflows(
  connection: ComfyUiConnection,
  requestFetch: typeof fetch,
  signal: AbortSignal
): Promise<ComfyUiCapabilities['workflows']> {
  return new ComfyUiProtocol(connection, requestFetch).workflows(signal)
}

interface WorkflowResult {
  prompt: ComfyUiWorkflow
  outputNodeId: string
}

class ComfyUiExecution {
  private readonly protocol: ComfyUiProtocol
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number
  private readonly cancelTimeoutMs: number
  private readonly randomSeed: () => number

  constructor(connection: ComfyUiConnection, options: Omit<ComfyUiGeneratorOptions, 'generationOptions'>) {
    this.protocol = new ComfyUiProtocol(connection, options.requestFetch, options.delay)
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.timeoutMs = options.timeoutMs ?? COMFYUI_REQUEST_TIMEOUT_MS
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS
    this.randomSeed = options.randomSeed ?? randomSafeSeed
  }

  async run(
    images: { sourcePng?: Buffer; maskPng?: Buffer },
    configuredSeed: number | undefined,
    signal: AbortSignal,
    createWorkflow: (
      input: { source?: string; mask?: string; seed: number },
      signal: AbortSignal
    ) => Promise<WorkflowResult>
  ): Promise<Buffer> {
    return this.withDeadline(signal, async (deadlineSignal) => {
      let promptId: string | undefined
      let submitUncertain = false
      try {
        const source = images.sourcePng
          ? await this.protocol.upload(images.sourcePng, deadlineSignal)
          : undefined
        const mask = images.maskPng
          ? await this.protocol.upload(images.maskPng, deadlineSignal)
          : undefined
        const workflow = await createWorkflow({
          ...(source ? { source } : {}),
          ...(mask ? { mask } : {}),
          seed: configuredSeed ?? this.randomSeed()
        }, deadlineSignal)
        promptId = randomUUID()
        submitUncertain = true
        await this.protocol.submit(promptId, workflow.prompt, deadlineSignal)
        submitUncertain = false
        return await this.protocol.poll(
          promptId,
          workflow.outputNodeId,
          this.pollIntervalMs,
          deadlineSignal
        )
      } catch (error) {
        if (promptId && (deadlineSignal.aborted || submitUncertain)) {
          await this.protocol.cancel(promptId, this.cancelTimeoutMs)
        }
        throw error
      }
    })
  }

  private async withDeadline<T>(
    signal: AbortSignal,
    operation: (deadlineSignal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(signal.reason)
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new ComfyUiApiError(
      'ComfyUI image generation timed out.',
      undefined,
      'timeout'
    )), this.timeoutMs)
    try {
      return await operation(controller.signal)
    } catch (error) {
      if (controller.signal.aborted && !signal.aborted && controller.signal.reason) {
        throw controller.signal.reason
      }
      throw error
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
  }
}

export class ComfyUiImageGenerator implements ImageGenerator {
  readonly maxBatchSize = 1

  private readonly execution: ComfyUiExecution
  private readonly generationOptions: ComfyUiGenerationOptions

  constructor(
    connection: ComfyUiConnection,
    private readonly checkpoint: string,
    options: ComfyUiGeneratorOptions
  ) {
    comfyUiCheckpointSchema.parse(checkpoint)
    this.generationOptions = comfyUiGenerationOptionsSchema.parse(options.generationOptions)
    this.execution = new ComfyUiExecution(connection, options)
  }

  async generate(
    spec: AssetSpec,
    layout: ImageLayout,
    _background: ImageBackground,
    _quality: ImageQuality,
    signal: AbortSignal,
    batch: ImageBatch
  ): Promise<void> {
    const png = await this.run('generate', spec.generatorPrompt, spec.avoid, layout, {}, signal)
    signal.throwIfAborted()
    batch.onImage(png)
  }

  async reference(
    spec: AssetSpec,
    referencePngs: ReferencePngs,
    layout: ImageLayout,
    _background: ImageBackground,
    _quality: ImageQuality,
    signal: AbortSignal,
    batch: ImageBatch
  ): Promise<void> {
    const png = await this.run('reference', spec.generatorPrompt, spec.avoid, layout, {
      sourcePng: prepareSingleImageReference(referencePngs)
    }, signal)
    signal.throwIfAborted()
    batch.onImage(png)
  }

  async inpaint(
    spec: AssetSpec,
    sourcePng: Buffer,
    maskPng: Buffer,
    layout: ImageLayout,
    _background: ImageBackground,
    _quality: ImageQuality,
    signal: AbortSignal,
    batch: ImageBatch
  ): Promise<void> {
    const png = await this.run('inpaint', spec.generatorPrompt, spec.avoid, layout, {
      sourcePng,
      maskPng
    }, signal)
    signal.throwIfAborted()
    batch.onImage(png)
  }

  async edit(
    sourcePng: Buffer,
    prompt: string,
    layout: ImageLayout,
    _background: ImageBackground,
    quality: ImageQuality,
    signal: AbortSignal,
    avoid: readonly string[] = []
  ): Promise<Buffer> {
    const mode: WorkflowMode = quality === 'medium' ? 'upscale' : 'refine'
    return this.run(mode, prompt, avoid, layout, { sourcePng }, signal)
  }

  private async run(
    mode: WorkflowMode,
    prompt: string,
    avoid: readonly string[],
    layout: ImageLayout,
    images: { sourcePng?: Buffer; maskPng?: Buffer },
    signal: AbortSignal
  ): Promise<Buffer> {
    return this.execution.run(images, this.generationOptions.seed, signal, async (input) =>
      createComfyUiWorkflow(
        mode,
        this.checkpoint,
        prompt,
        avoid.join(', '),
        layout,
        this.generationOptions,
        input.seed,
        input
      ))
  }
}

export interface ComfyUiWorkflowGeneratorOptions extends Omit<ComfyUiGeneratorOptions, 'generationOptions'> {
  binding: ComfyUiWorkflowBinding
  converter: ComfyUiWorkflowConverter
  seed?: number
}

export class ComfyUiWorkflowImageGenerator implements ImageGenerator {
  readonly maxBatchSize = 1

  private readonly binding: ComfyUiWorkflowBinding
  private readonly execution: ComfyUiExecution

  constructor(
    private readonly connection: ComfyUiConnection,
    private readonly options: ComfyUiWorkflowGeneratorOptions
  ) {
    this.binding = comfyUiWorkflowBindingSchema.parse(options.binding)
    this.execution = new ComfyUiExecution(connection, options)
  }

  async generate(
    spec: AssetSpec,
    _layout: ImageLayout,
    _background: ImageBackground,
    _quality: ImageQuality,
    signal: AbortSignal,
    batch: ImageBatch
  ): Promise<void> {
    const png = await this.run('generate', spec, {}, signal)
    signal.throwIfAborted()
    batch.onImage(png)
  }

  async reference(
    spec: AssetSpec,
    referencePngs: ReferencePngs,
    _layout: ImageLayout,
    _background: ImageBackground,
    _quality: ImageQuality,
    signal: AbortSignal,
    batch: ImageBatch
  ): Promise<void> {
    const png = await this.run('reference', spec, {
      sourcePng: prepareSingleImageReference(referencePngs)
    }, signal)
    signal.throwIfAborted()
    batch.onImage(png)
  }

  async inpaint(
    spec: AssetSpec,
    sourcePng: Buffer,
    maskPng: Buffer,
    _layout: ImageLayout,
    _background: ImageBackground,
    _quality: ImageQuality,
    signal: AbortSignal,
    batch: ImageBatch
  ): Promise<void> {
    const png = await this.run('inpaint', spec, { sourcePng, maskPng }, signal)
    signal.throwIfAborted()
    batch.onImage(png)
  }

  edit(): Promise<Buffer> {
    return Promise.reject(new ComfyUiApiError(
      'Custom ComfyUI workflows do not define a generic edit operation.',
      undefined,
      'invalid_request'
    ))
  }

  private run(
    mode: Extract<WorkflowMode, 'generate' | 'reference' | 'inpaint'>,
    spec: AssetSpec,
    images: { sourcePng?: Buffer; maskPng?: Buffer },
    signal: AbortSignal
  ): Promise<Buffer> {
    return this.execution.run(images, this.options.seed, signal, async (input, conversionSignal) => {
      const conversion: ComfyUiWorkflowConversion = {
        binding: this.binding,
        mode,
        prompt: spec.generatorPrompt,
        negativePrompt: spec.avoid.join(', '),
        seed: input.seed,
        ...(input.source ? { sourceImage: input.source } : {}),
        ...(input.mask ? { maskImage: input.mask } : {})
      }
      let prompt: ComfyUiWorkflow
      try {
        prompt = await this.options.converter.convert(
          this.connection.baseUrl,
          conversion,
          conversionSignal
        )
      } catch (error) {
        if (conversionSignal.aborted) throw conversionSignal.reason
        throw new ComfyUiApiError(
          error instanceof Error ? error.message : 'ComfyUI workflow conversion failed.',
          undefined,
          'invalid_request'
        )
      }
      return { prompt, outputNodeId: this.binding.outputNodeId }
    })
  }
}
