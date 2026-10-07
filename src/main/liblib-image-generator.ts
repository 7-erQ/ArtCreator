import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { nativeImage } from 'electron'
import type {
  AssetSpec,
  GenerationErrorCategory,
  ImageModelSelection,
  Star3GenerationOptions
} from '../shared/contracts'
import { DEFAULT_STAR3_GENERATION_OPTIONS } from '../shared/contracts'
import type { ImageLayout } from './image-layout'
import type {
  ImageBackground,
  ImageBatch,
  ImageGenerator,
  ImageQuality,
  ReferencePngs
} from './image-generator'
import {
  prepareLiblibInpaint,
  prepareLiblibReference,
  type LiblibUploadFile
} from './liblib-image-preparer'
import { prepareSingleImageReference } from './reference-images'

type LiblibModel = Extract<ImageModelSelection, { provider: 'liblib' }>['model']

export interface LiblibConnection {
  baseUrl: string
  accessKey: string
  secretKey: string
}

export interface LiblibGeneratorOptions {
  requestFetch?: typeof fetch
  now?: () => number
  nonce?: () => string
  pollIntervalMs?: number
  timeoutMs?: number
  delay?: (durationMs: number, signal: AbortSignal) => Promise<void>
  coordinator?: LiblibRequestCoordinator
  generationOptions?: Star3GenerationOptions
}

interface LiblibResponse<T> {
  code?: number
  data?: T
  msg?: string
}

interface UploadSignature {
  key: string
  policy: string
  postUrl: string
  xOssDate: string
  xOssExpires: number
  xOssSignature: string
  xOssCredential: string
  xOssSignatureVersion: string
}

interface TaskStatus {
  generateStatus: number
  generateMsg?: string
  images?: Array<{ imageUrl?: string; auditStatus?: number }>
}

interface PreparedInput {
  referenceUrl?: string
  imageUrl?: string
  maskUrl?: string
}

const GENERAL_UPLOAD_LIMIT = 10 * 1024 * 1024
const INPAINT_UPLOAD_LIMIT = 4 * 1024 * 1024
const MAX_RESULT_BYTES = 25 * 1024 * 1024
const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_TIMEOUT_MS = 180_000
const SUCCESS_STATUS = 5
const FAILED_STATUS = 6
const TIMEOUT_STATUS = 7
const PENDING_STATUSES = new Set([1, 2, 3, 4])
const SUCCESS_CODES = new Set([0, 200])

export class LiblibApiError extends Error {
  readonly retryable = false
  readonly code?: string

  constructor(
    message: string,
    readonly status?: number,
    readonly businessCode?: number,
    readonly providerCategory?: GenerationErrorCategory
  ) {
    super(message)
    this.name = 'LiblibApiError'
    this.code = businessCode?.toString()
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

export class LiblibRequestCoordinator {
  private active = 0
  private readonly waiters: Array<() => void> = []
  private submitTail: Promise<void> = Promise.resolve()
  private lastSubmitAt = 0

  constructor(
    private readonly maxActive = 5,
    private readonly submitIntervalMs = 1_000,
    private readonly now: () => number = Date.now,
    private readonly delay: (durationMs: number, signal: AbortSignal) => Promise<void> = waitForDelay
  ) {}

  async withSlot<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.acquire(signal)
    try {
      return await operation()
    } finally {
      this.active -= 1
      this.waiters.shift()?.()
    }
  }

  async beforeSubmit(signal: AbortSignal): Promise<void> {
    let release!: () => void
    const previous = this.submitTail
    this.submitTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const remaining = Math.max(0, this.submitIntervalMs - (this.now() - this.lastSubmitAt))
      if (remaining > 0) await this.delay(remaining, signal)
      if (signal.aborted) throw signal.reason
      this.lastSubmitAt = this.now()
    } finally {
      release()
    }
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason
    if (this.active < this.maxActive) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const resume = (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        const index = this.waiters.indexOf(resume)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(signal.reason)
      }
      this.waiters.push(resume)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    if (signal.aborted) throw signal.reason
    this.active += 1
  }
}

export const liblibRequestCoordinator = new LiblibRequestCoordinator()

export function createLiblibSignature(
  uri: string,
  timestamp: number,
  nonce: string,
  secretKey: string
): string {
  return createHmac('sha1', secretKey)
    .update(`${uri}&${timestamp}&${nonce}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = record(value)?.[key]
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  const candidate = record(value)?.[key]
  return typeof candidate === 'string' && candidate ? candidate : undefined
}

function errorForResponse(status: number, body: unknown): LiblibApiError {
  const code = numberField(body, 'code')
  if (code === 100010 || code === 100020) {
    return new LiblibApiError('LiblibAI credentials are invalid.', status, code, 'authentication')
  }
  if (code === 100021) {
    return new LiblibApiError('LiblibAI API points are insufficient.', status, code, 'quota')
  }
  if (code === 100031 || code === 100052 || code === 100055) {
    return new LiblibApiError('LiblibAI rejected the content.', status, code, 'moderation')
  }
  if (code === 100054 || status === 429) {
    return new LiblibApiError('LiblibAI request concurrency is limited.', status, code, 'rate_limit')
  }
  if (code === 200000 || code === 200001 || code === 210000 || status >= 500) {
    return new LiblibApiError('LiblibAI service is unavailable.', status, code, 'service')
  }
  if (status === 401 || status === 403) {
    return new LiblibApiError('LiblibAI credentials are invalid.', status, code, 'authentication')
  }
  return new LiblibApiError('LiblibAI rejected the request.', status, code, 'invalid_request')
}

function closestRatio(ratio: number, choices: readonly [string, number][]): string {
  return choices.reduce((best, candidate) =>
    Math.abs(Math.log(candidate[1] / ratio)) < Math.abs(Math.log(best[1] / ratio))
      ? candidate
      : best
  )[0]
}

function dimensionsWithin(
  layout: ImageLayout,
  minimum: number,
  maximum: number,
  maximumPixels = maximum * maximum,
  minimumPixels = 0
): { width: number; height: number } {
  let width = layout.requestWidth
  let height = layout.requestHeight
  const grow = Math.max(
    1,
    minimum / width,
    minimum / height,
    minimumPixels > 0 ? Math.sqrt(minimumPixels / (width * height)) : 1
  )
  width *= grow
  height *= grow
  const shrink = Math.min(
    1,
    maximum / width,
    maximum / height,
    Math.sqrt(maximumPixels / (width * height))
  )
  width *= shrink
  height *= shrink
  const round = shrink < 1 ? Math.floor : grow > 1 ? Math.ceil : Math.round
  const roundedWidth = round(width / 16) * 16
  const roundedHeight = round(height / 16) * 16
  return {
    width: Math.min(maximum, Math.max(minimum, roundedWidth)),
    height: Math.min(maximum, Math.max(minimum, roundedHeight))
  }
}

export function liblibMaxBatchSize(model: LiblibModel): number {
  // Seedream auto generates a model-selected group, not a fixed number of variants.
  return model === 'seedream-4.0' || model === 'seedream-4.5' ? 1 : 4
}

export function createLiblibTaskRequest(
  model: LiblibModel,
  mode: 'generate' | 'reference' | 'inpaint' | 'edit',
  prompt: string,
  layout: ImageLayout,
  quality: ImageQuality,
  input: PreparedInput,
  options?: Star3GenerationOptions,
  count = 1
): { uri: string; statusUri: string; body: Record<string, unknown> } {
  const isReference = mode === 'reference' || mode === 'edit'
  if (model === 'star-3-alpha') {
    if (mode === 'inpaint') throw new LiblibApiError('Star-3 Alpha does not support inpaint.')
    const reference = input.referenceUrl
    const star3 = options ?? DEFAULT_STAR3_GENERATION_OPTIONS
    return isReference
      ? {
          uri: '/api/generate/webui/img2img/ultra',
          statusUri: '/api/generate/webui/status',
          body: {
            templateUuid: '07e00af4fc464c7ab55ff906f8acf1b7',
            generateParams: {
              prompt,
              promptMagic: star3.promptMagic ? 1 : 0,
              imgCount: count,
              steps: star3.steps,
              denoisingStrength: star3.denoisingStrength,
              sourceImage: reference
            }
          }
        }
      : {
          uri: '/api/generate/webui/text2img/ultra',
          statusUri: '/api/generate/webui/status',
          body: {
            templateUuid: '5d7e67009b344550bc1aa6ccbfa1d7f4',
            generateParams: {
              prompt,
              promptMagic: star3.promptMagic ? 1 : 0,
              imageSize: { width: layout.requestWidth, height: layout.requestHeight },
              imgCount: count,
              steps: star3.steps
            }
          }
        }
  }

  if (model === 'f1-kontext-pro' || model === 'f1-kontext-max') {
    if (mode === 'inpaint') throw new LiblibApiError('F.1 Kontext does not support inpaint.')
    const aspectRatio = closestRatio(layout.requestWidth / layout.requestHeight, [
      ['1:1', 1], ['2:3', 2 / 3], ['3:2', 3 / 2], ['3:4', 3 / 4], ['4:3', 4 / 3],
      ['9:16', 9 / 16], ['16:9', 16 / 9], ['9:21', 9 / 21], ['21:9', 21 / 9]
    ])
    return {
      uri: isReference ? '/api/generate/kontext/img2img' : '/api/generate/kontext/text2img',
      statusUri: '/api/generate/status',
      body: {
        templateUuid: isReference
          ? '1c0a9712b3d84e1b8a9f49514a46d88c'
          : 'fe9928fde1b4491c9b360dd24aa2b115',
        generateParams: {
          model: model === 'f1-kontext-pro' ? 'pro' : 'max',
          prompt,
          aspectRatio,
          guidance_scale: 3.5,
          imgCount: count,
          ...(isReference ? { image_list: [input.referenceUrl] } : {})
        }
      }
    }
  }

  if (model === 'img1') {
    if (mode === 'inpaint') {
      return {
        uri: '/api/generate/smart-img1/inpaint',
        statusUri: '/api/generate/status',
        body: {
          templateUuid: '0fb3ddb15a094e74b1241fbda5db3199',
          generateParams: {
            prompt,
            aspectRatio: 'auto',
            quality: quality === 'low' ? 'turbo' : 'normal',
            imgCount: count,
            image: input.imageUrl,
            mask: input.maskUrl
          }
        }
      }
    }
    const aspectRatio = closestRatio(layout.requestWidth / layout.requestHeight, [
      ['square', 1], ['portrait', 2 / 3], ['landscape', 3 / 2]
    ])
    return {
      uri: '/api/generate/smart-img1/generate',
      statusUri: '/api/generate/status',
      body: {
        templateUuid: '86c58ea26e9a45bd9f562c6306c17c0f',
        generateParams: {
          prompt,
          aspectRatio,
          quality: quality === 'low' ? 'turbo' : quality === 'medium' ? 'normal' : 'masterpiece',
          imgCount: count,
          ...(isReference ? { image_list: [input.referenceUrl] } : {})
        }
      }
    }
  }

  if (model === 'libdream') {
    if (mode !== 'generate') throw new LiblibApiError('LibDream only supports text-to-image.')
    const size = dimensionsWithin(layout, 512, 3072, 2048 * 2048)
    return {
      uri: '/api/generate/libDream',
      statusUri: '/api/generate/status',
      body: {
        templateUuid: 'aa835a39c1a14cfca47c6fc941137c51',
        generateParams: {
          prompt,
          usePreLlm: false,
          width: size.width,
          height: size.height,
          scale: 2.5,
          seed: -1,
          imgCount: count
        }
      }
    }
  }

  if (model === 'libedit' || model === 'libedit-v2') {
    if (!isReference) throw new LiblibApiError('LibEdit requires one reference image.')
    const size = dimensionsWithin(layout, 512, 2016)
    return {
      uri: model === 'libedit' ? '/api/generate/libEdit' : '/api/generate/libEditV2',
      statusUri: '/api/generate/status',
      body: {
        templateUuid: model === 'libedit'
          ? 'cd3a6751086b4483ba5f0523aef53a79'
          : 'c92f91c771db42e2b5dbff66e2e4f7a2',
        generateParams: {
          prompt,
          promptMagic: 0,
          scale: 0.5,
          seed: -1,
          imgCount: count,
          image_urls: [input.referenceUrl],
          ...(model === 'libedit-v2' ? { width: size.width, height: size.height } : {})
        }
      }
    }
  }

  if (model === 'seedream-4.0' || model === 'seedream-4.5') {
    if (mode === 'inpaint') throw new LiblibApiError('Seedream does not support inpaint.')
    const size = model === 'seedream-4.5'
      ? dimensionsWithin(layout, 512, 4096, 4096 * 4096, 3_686_400)
      : dimensionsWithin(layout, 512, 4096, 2048 * 2048)
    return {
      uri: '/api/generate/seedreamV4',
      statusUri: '/api/generate/status',
      body: {
        templateUuid: '0b6bad2fd350433ebb5abc7eb91f2ec9',
        generateParams: {
          model: model === 'seedream-4.5'
            ? 'doubao-seedream-4-5-251128'
            : 'doubao-seedream-4-0-250828',
          prompt,
          width: size.width,
          height: size.height,
          imgCount: count,
          sequentialImageGeneration: 'disabled',
          ...(isReference ? { referenceImages: [input.referenceUrl] } : {})
        }
      }
    }
  }

  if (mode !== 'generate') throw new LiblibApiError('Qwen Image only supports text-to-image.')
  const size = dimensionsWithin(layout, 128, 2048)
  return {
    uri: '/api/generate/webui/text2img',
    statusUri: '/api/generate/status',
    body: {
      templateUuid: 'bf085132c7134622895b783b520b39ff',
      generateParams: {
        checkPointId: '75e0be0c93b34dd8baeec9c968013e0c',
        prompt,
        negativePrompt: '',
        clipSkip: 2,
        sampler: 1,
        steps: 30,
        cfgScale: 4,
        width: size.width,
        height: size.height,
        imgCount: count,
        randnSource: 0,
        seed: -1,
        controlNet: []
      }
    }
  }
}

function pngResult(data: Buffer): Buffer {
  const image = nativeImage.createFromBuffer(data)
  if (image.isEmpty()) throw new LiblibApiError('LiblibAI returned an invalid image.')
  return image.toPNG()
}

export class LiblibImageGenerator implements ImageGenerator {
  get maxBatchSize(): number { return liblibMaxBatchSize(this.model) }

  private readonly requestFetch: typeof fetch
  private readonly now: () => number
  private readonly nonce: () => string
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number
  private readonly delay: (durationMs: number, signal: AbortSignal) => Promise<void>
  private readonly coordinator: LiblibRequestCoordinator
  private readonly generationOptions?: Star3GenerationOptions

  constructor(
    private readonly connection: LiblibConnection,
    private readonly model: LiblibModel,
    options: LiblibGeneratorOptions = {}
  ) {
    this.requestFetch = options.requestFetch ?? fetch
    this.now = options.now ?? Date.now
    this.nonce = options.nonce ?? (() => randomBytes(12).toString('hex'))
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.delay = options.delay ?? waitForDelay
    this.coordinator = options.coordinator ?? liblibRequestCoordinator
    this.generationOptions = options.generationOptions
  }

  generate(
    spec: AssetSpec,
    layout: ImageLayout,
    _background: ImageBackground,
    quality: ImageQuality,
    signal: AbortSignal,
    batch: ImageBatch
  ): Promise<void> {
    return this.run(
      'generate',
      spec.generatorPrompt,
      layout,
      quality,
      {},
      signal,
      batch,
      this.generationOptions
    )
  }

  async reference(
    spec: AssetSpec,
    referencePngs: ReferencePngs,
    layout: ImageLayout,
    _background: ImageBackground,
    quality: ImageQuality,
    signal: AbortSignal,
    batch: ImageBatch
  ): Promise<void> {
    const file = prepareLiblibReference(
      prepareSingleImageReference(referencePngs),
      GENERAL_UPLOAD_LIMIT
    )
    return this.runWithUpload(
      'reference',
      spec.generatorPrompt,
      layout,
      quality,
      file,
      signal,
      batch,
      this.generationOptions
    )
  }

  async inpaint(
    spec: AssetSpec,
    sourcePng: Buffer,
    maskPng: Buffer,
    layout: ImageLayout,
    _background: ImageBackground,
    quality: ImageQuality,
    signal: AbortSignal,
    batch: ImageBatch
  ): Promise<void> {
    const prepared = prepareLiblibInpaint(sourcePng, maskPng, INPAINT_UPLOAD_LIMIT)
    return this.withDeadline(signal, async (deadlineSignal) => this.coordinator.withSlot(
      deadlineSignal,
      async () => {
        const [imageUrl, maskUrl] = await Promise.all([
          this.upload(prepared.image, deadlineSignal),
          this.upload(prepared.mask, deadlineSignal)
        ])
        return this.submitAndPoll(
          'inpaint',
          spec.generatorPrompt,
          layout,
          quality,
          { imageUrl, maskUrl },
          deadlineSignal,
          batch,
          this.generationOptions
        )
      }
    ))
  }

  async edit(
    sourcePng: Buffer,
    prompt: string,
    layout: ImageLayout,
    _background: ImageBackground,
    quality: ImageQuality,
    signal: AbortSignal
  ): Promise<Buffer> {
    const file = prepareLiblibReference(sourcePng, GENERAL_UPLOAD_LIMIT)
    let png!: Buffer
    await this.runWithUpload('edit', prompt, layout, quality, file, signal, {
      count: 1, onImage: (image) => { png = image }
    })
    return png
  }

  async testConnection(signal: AbortSignal): Promise<void> {
    try {
      await this.signedJson(
        '/api/generate/status',
        { generateUuid: randomUUID() },
        signal,
        new Set([100051])
      )
    } catch (error) {
      if (error instanceof LiblibApiError && error.businessCode === 100051) return
      throw error
    }
  }

  private runWithUpload(
    mode: 'reference' | 'edit',
    prompt: string,
    layout: ImageLayout,
    quality: ImageQuality,
    file: LiblibUploadFile,
    signal: AbortSignal,
    batch: ImageBatch,
    options?: Star3GenerationOptions
  ): Promise<void> {
    return this.withDeadline(signal, async (deadlineSignal) => this.coordinator.withSlot(
      deadlineSignal,
      async () => {
        const referenceUrl = await this.upload(file, deadlineSignal)
        return this.submitAndPoll(
          mode,
          prompt,
          layout,
          quality,
          { referenceUrl },
          deadlineSignal,
          batch,
          options
        )
      }
    ))
  }

  private run(
    mode: 'generate',
    prompt: string,
    layout: ImageLayout,
    quality: ImageQuality,
    input: PreparedInput,
    signal: AbortSignal,
    batch: ImageBatch,
    options?: Star3GenerationOptions
  ): Promise<void> {
    return this.withDeadline(signal, async (deadlineSignal) => this.coordinator.withSlot(
      deadlineSignal,
      () => this.submitAndPoll(mode, prompt, layout, quality, input, deadlineSignal, batch, options)
    ))
  }

  private async submitAndPoll(
    mode: 'generate' | 'reference' | 'inpaint' | 'edit',
    prompt: string,
    layout: ImageLayout,
    quality: ImageQuality,
    input: PreparedInput,
    signal: AbortSignal,
    batch: ImageBatch,
    options?: Star3GenerationOptions
  ): Promise<void> {
    const request = createLiblibTaskRequest(this.model, mode, prompt, layout, quality, input, options, batch.count)
    await this.coordinator.beforeSubmit(signal)
    const submitted = await this.signedJson<{ generateUuid?: string }>(
      request.uri,
      request.body,
      signal
    )
    const generateUuid = stringField(submitted, 'generateUuid')
    if (!generateUuid) throw new LiblibApiError('LiblibAI returned no task identifier.')

    for (;;) {
      await this.delay(this.pollIntervalMs, signal)
      const status = await this.retrySafe(
        () => this.signedJson<TaskStatus>(
          request.statusUri,
          { generateUuid },
          signal
        ),
        signal
      )
      const generateStatus = numberField(status, 'generateStatus')
      if (generateStatus === SUCCESS_STATUS) {
        const images = record(status)?.images
        const urls = Array.isArray(images)
          ? images
              .filter((image) => numberField(image, 'auditStatus') === 3)
              .map((image) => stringField(image, 'imageUrl'))
              .filter((url): url is string => Boolean(url))
          : []
        if (urls.length === 0) {
          throw new LiblibApiError(
            'LiblibAI returned no approved image.', undefined, undefined, 'no_approved_image'
          )
        }
        for (const url of urls.slice(0, batch.count)) {
          signal.throwIfAborted()
          const encoded = await this.retrySafe(() => this.download(url, signal), signal)
          signal.throwIfAborted()
          batch.onImage(pngResult(encoded))
        }
        if (urls.length !== batch.count) {
          throw new LiblibApiError(
            `LiblibAI returned ${urls.length} approved images; expected ${batch.count}.`,
            undefined, undefined, 'no_approved_image'
          )
        }
        return
      }
      if (generateStatus === FAILED_STATUS) {
        throw new LiblibApiError(
          'LiblibAI image generation failed.',
          undefined,
          undefined,
          'service'
        )
      }
      if (generateStatus === TIMEOUT_STATUS) {
        throw new LiblibApiError(
          'LiblibAI image generation timed out.',
          undefined,
          undefined,
          'timeout'
        )
      }
      if (generateStatus === undefined || !PENDING_STATUSES.has(generateStatus)) {
        throw new LiblibApiError('LiblibAI returned an unknown task status.')
      }
    }
  }

  private async upload(file: LiblibUploadFile, signal: AbortSignal): Promise<string> {
    const signature = await this.retrySafe(
      () => this.signedJson<UploadSignature>(
        '/api/generate/upload/signature',
        { name: randomUUID(), extension: file.extension },
        signal
      ),
      signal
    )
    const key = stringField(signature, 'key')
    const postUrl = stringField(signature, 'postUrl')
    if (!key || !postUrl) throw new LiblibApiError('LiblibAI returned an invalid upload signature.')
    const target = new URL(postUrl)
    if (target.protocol !== 'https:') throw new LiblibApiError('LiblibAI upload URL must use HTTPS.')

    const fields: Array<[string, string]> = [
      ['key', key],
      ['policy', stringField(signature, 'policy') ?? ''],
      ['x-oss-date', stringField(signature, 'xOssDate') ?? ''],
      ['x-oss-expires', String(numberField(signature, 'xOssExpires') ?? '')],
      ['x-oss-signature', stringField(signature, 'xOssSignature') ?? ''],
      ['x-oss-credential', stringField(signature, 'xOssCredential') ?? ''],
      ['x-oss-signature-version', stringField(signature, 'xOssSignatureVersion') ?? '']
    ]
    if (fields.some(([, value]) => !value)) {
      throw new LiblibApiError('LiblibAI returned an incomplete upload signature.')
    }
    const form = new FormData()
    fields.forEach(([name, value]) => form.append(name, value))
    form.append(
      'file',
      new Blob([new Uint8Array(file.data)], { type: file.mediaType }),
      `${randomUUID()}.${file.extension}`
    )
    const response = await this.request(target, {
      method: 'POST',
      body: form,
      signal,
      redirect: 'error'
    })
    if (!response.ok) throw new LiblibApiError('LiblibAI image upload failed.', response.status)
    return new URL(key, `${target.toString().replace(/\/+$/, '')}/`).toString()
  }

  private async signedJson<T>(
    uri: string,
    body: unknown,
    signal: AbortSignal,
    allowedCodes = new Set<number>()
  ): Promise<T> {
    const timestamp = this.now()
    const nonce = this.nonce()
    const url = new URL(`${this.connection.baseUrl.replace(/\/+$/, '')}${uri}`)
    url.searchParams.set('AccessKey', this.connection.accessKey)
    url.searchParams.set(
      'Signature',
      createLiblibSignature(uri, timestamp, nonce, this.connection.secretKey)
    )
    url.searchParams.set('Timestamp', String(timestamp))
    url.searchParams.set('SignatureNonce', nonce)
    const response = await this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      redirect: 'error'
    })
    let parsed: LiblibResponse<T>
    try {
      parsed = await response.json() as LiblibResponse<T>
    } catch {
      throw new LiblibApiError('LiblibAI returned invalid JSON.', response.status)
    }
    const code = parsed.code
    if (!response.ok || (code !== undefined && !SUCCESS_CODES.has(code) && !allowedCodes.has(code))) {
      throw errorForResponse(response.status, parsed)
    }
    if (code !== undefined && allowedCodes.has(code)) {
      throw new LiblibApiError('LiblibAI task does not exist.', response.status, code)
    }
    const data = parsed.data ?? parsed as T
    return data
  }

  private async download(url: string, signal: AbortSignal): Promise<Buffer> {
    const target = new URL(url)
    if (target.protocol !== 'https:') throw new LiblibApiError('LiblibAI result URL must use HTTPS.')
    const response = await this.request(target, { signal, redirect: 'error' })
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    const allowedContentTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
    const declaredLength = Number(response.headers.get('content-length'))
    if (!response.ok || !contentType || !allowedContentTypes.has(contentType) || !response.body ||
      (Number.isSafeInteger(declaredLength) && declaredLength > MAX_RESULT_BYTES)) {
      throw new LiblibApiError('LiblibAI result download was invalid.', response.status)
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
          throw new LiblibApiError('LiblibAI result exceeds the size limit.')
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks, total)
  }

  private async retrySafe<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        const status = error instanceof LiblibApiError ? error.status : undefined
        const providerCategory = error instanceof LiblibApiError
          ? error.providerCategory
          : undefined
        if (signal.aborted || attempt >= 2 ||
          !(providerCategory === 'network' || status === 429 ||
            (status !== undefined && status >= 500))) {
          throw error
        }
        await this.delay(250 * (2 ** attempt), signal)
      }
    }
  }

  private async request(target: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.requestFetch(target, init)
    } catch {
      if (init.signal?.aborted) throw init.signal.reason
      throw new LiblibApiError(
        'LiblibAI network request failed.',
        undefined,
        undefined,
        'network'
      )
    }
  }

  private async withDeadline<T>(
    signal: AbortSignal,
    operation: (deadlineSignal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(signal.reason)
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(
      () => controller.abort(new LiblibApiError(
        'LiblibAI image generation timed out.',
        undefined,
        undefined,
        'timeout'
      )),
      this.timeoutMs
    )
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
