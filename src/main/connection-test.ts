import { t } from '../shared/language'
import OpenAI from 'openai'
import { z } from 'zod'
import type {
  AssetSpec,
  ConnectionTestInput,
  ConnectionTestResult
} from '../shared/contracts'
import type { CaptureResult } from './capture-controller'
import { calculateImageLayout } from './image-layout'
import {
  OpenAIImageGenerator,
  OpenAIPromptPolisher
} from './openai-asset-generator'
import { IMAGE_REQUEST_TIMEOUT_MS } from './image-generator'
import { LiblibImageGenerator } from './liblib-image-generator'
import { getComfyUiCapabilities } from './comfyui-image-generator'
import { sanitizedProviderMessage } from './provider-error'

const TEXT_REQUEST_TIMEOUT_MS = 60_000
const COMFYUI_CONNECTION_TEST_TIMEOUT_MS = 10_000
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export interface ConnectionTestFailureDiagnostic {
  target: ConnectionTestInput['target']
  status?: number
  errorName?: string
  providerMessage?: string
}

export interface SavedConnectionTestCredentials {
  textApiKey?: string
  openaiImageApiKey?: string
  liblibAccessKey?: string
  liblibSecretKey?: string
}

const TEST_CAPTURE: CaptureResult = {
  submissionMode: 'generate',
  selection: {
    displayId: 'connection-test',
    contextRectDip: { x: 0, y: 0, width: 1024, height: 1024 },
    scaleFactor: 1,
    instruction: 'Create a minimal visual asset specification for a connection test.',
    promptProcessing: 'polish',
    promptLanguage: 'en',
    imageModel: { provider: 'openai', model: 'gpt-image-2' },
    imageGeneration: 'generate',
    generationCount: 1,
    transparentBackground: false
  },
  globalOutputRectDip: { x: 0, y: 0, width: 1024, height: 1024 },
  screenshotPng: Buffer.alloc(0),
  placeholderPng: Buffer.alloc(0),
  referencePngs: [Buffer.alloc(0)]
}

const TEST_ASSET_SPEC: AssetSpec = {
  version: 1,
  assetName: 'Connection test',
  subject: 'A simple solid light gray square',
  style: 'Minimal flat color',
  composition: 'A full-frame square with no text',
  palette: ['light gray'],
  mustPreserve: [],
  avoid: ['text', 'symbols', 'complex detail'],
  targetAspectRatio: 1,
  generatorPrompt: 'Create a simple solid light gray square with no text or symbols.'
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined
  return typeof error.status === 'number' ? error.status : undefined
}

function errorName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(error.name) ? error.name : undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase()
  return ''
}

function failureResult(target: ConnectionTestInput['target'], error: unknown): ConnectionTestResult {
  const label = target === 'text'
    ? t('提示词')
    : target === 'liblib'
      ? 'LiblibAI'
      : target === 'comfyui'
        ? 'ComfyUI'
        : t('OpenAI 生图')
  const status = errorStatus(error)
  const message = errorMessage(error)
  const providerCategory = typeof error === 'object' && error !== null &&
    'providerCategory' in error ? error.providerCategory : undefined

  if (status === 401 || status === 403 || providerCategory === 'authentication') {
    return {
      ok: false,
      message: target === 'liblib'
        ? t('LiblibAI 配置认证失败，请检查 AccessKey、SecretKey 和 API 权益。')
        : t('{0}配置认证失败，请检查 API Key。', label)
    }
  }
  if (status === 429 || providerCategory === 'rate_limit') {
    return { ok: false, message: t('{0}测试请求受限，请稍后重试。', label) }
  }
  if ((status !== undefined && status >= 500) || providerCategory === 'service') {
    return { ok: false, message: t('{0}服务暂时不可用，请稍后重试。', label) }
  }
  if (error instanceof z.ZodError || message.includes('no png data') ||
    message.includes('invalid png') || message.includes('valid png')) {
    return { ok: false, message: t('{0}服务已响应，但返回格式不兼容。', label) }
  }
  if (status !== undefined && status >= 400) {
    return { ok: false, message: t('{0}服务拒绝测试请求，请检查模型与 Base URL。', label) }
  }
  if (providerCategory === 'network' || providerCategory === 'timeout' ||
    /timed?\s*out|timeout|terminated|connection error|fetch failed/.test(message)) {
    return { ok: false, message: t('无法连接{0}服务，请检查 Base URL 和网络。', label) }
  }
  return { ok: false, message: t('{0}配置测试失败，请稍后重试。', label) }
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
}

export async function testApiConnection(
  input: ConnectionTestInput,
  saved: SavedConnectionTestCredentials,
  requestFetch: typeof fetch,
  onFailed?: (diagnostic: ConnectionTestFailureDiagnostic) => void,
  includeDevelopmentDiagnostics = false
): Promise<ConnectionTestResult> {
  const apiKey = input.target === 'text'
    ? input.apiKey ?? saved.textApiKey
    : input.target === 'openai_image'
      ? input.apiKey ?? saved.openaiImageApiKey
      : undefined
  const accessKey = input.target === 'liblib'
    ? input.accessKey ?? saved.liblibAccessKey
    : undefined
  const secretKey = input.target === 'liblib'
    ? input.secretKey ?? saved.liblibSecretKey
    : undefined
  if (input.target === 'liblib' && (!accessKey || !secretKey)) {
    return { ok: false, message: t('请先输入或保存 LiblibAI AccessKey 和 SecretKey。') }
  }
  if (input.target !== 'liblib' && input.target !== 'comfyui' && !apiKey) {
    return {
      ok: false,
      message: t('请先输入或保存{0} API Key。', t(input.target === 'text' ? '文本' : ' OpenAI 图片'))
    }
  }

  try {
    if (input.target === 'comfyui') {
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(new Error('ComfyUI connection test timed out.')),
        COMFYUI_CONNECTION_TEST_TIMEOUT_MS
      )
      try {
        await getComfyUiCapabilities({ baseUrl: input.baseUrl }, requestFetch, controller.signal)
      } finally {
        clearTimeout(timeout)
      }
      return { ok: true, message: t('ComfyUI 连接测试通过（未上传图片或提交工作流）。') }
    }

    if (input.target === 'liblib') {
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(new Error('LiblibAI connection test timed out.')),
        IMAGE_REQUEST_TIMEOUT_MS
      )
      try {
        await new LiblibImageGenerator(
          { baseUrl: input.baseUrl, accessKey: accessKey!, secretKey: secretKey! },
          'img1',
          { requestFetch }
        ).testConnection(controller.signal)
      } finally {
        clearTimeout(timeout)
      }
      return { ok: true, message: t('LiblibAI 配置测试通过（未提交生图任务）。') }
    }

    const signal = new AbortController().signal
    const client = new OpenAI({
      apiKey: apiKey!,
      baseURL: input.baseUrl,
      timeout: input.target === 'text' ? TEXT_REQUEST_TIMEOUT_MS : IMAGE_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      fetch: requestFetch
    })
    if (input.target === 'text') {
      await new OpenAIPromptPolisher(
        client,
        input.model,
        (sourcePng) => ({ data: sourcePng, mediaType: 'image/png' })
      ).polishPrompt(TEST_CAPTURE, signal)
      return { ok: true, message: t('提示词配置测试通过。') }
    }

    await new OpenAIImageGenerator(client, 'gpt-image-2', requestFetch).generate(
      TEST_ASSET_SPEC,
      calculateImageLayout(1024, 1024),
      'opaque',
      'low',
      signal,
      { count: 1, onImage: (png) => {
        if (!isPng(png)) throw new Error('The image API returned an invalid PNG.')
      } }
    )
    return { ok: true, message: t('OpenAI 生图配置测试通过。') }
  } catch (error) {
    const status = errorStatus(error)
    const name = errorName(error)
    onFailed?.({
      target: input.target,
      ...(status === undefined ? {} : { status }),
      ...(name ? { errorName: name } : {}),
      ...(includeDevelopmentDiagnostics
        ? {
            providerMessage: sanitizedProviderMessage(
              error,
              [apiKey, accessKey, secretKey, input.baseUrl]
                .filter((value): value is string => Boolean(value))
            )
          }
        : {})
    })
    return failureResult(input.target, error)
  }
}
