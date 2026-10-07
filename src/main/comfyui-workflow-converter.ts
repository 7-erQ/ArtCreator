import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import {
  comfyUiWorkflowBindingSchema,
  comfyUiWorkflowDescriptorSchema,
  comfyUiWorkflowInspectInputSchema,
  type ComfyUiWorkflowBinding,
  type ComfyUiWorkflowDescriptor,
  type ImageGeneration
} from '../shared/contracts'
import type { ComfyUiWorkflow } from './comfyui-image-generator'

const WORKFLOW_RUNTIME_TIMEOUT_MS = 30_000
const MAX_WORKFLOW_JSON_CHARACTERS = 5_000_000
const MAX_EXECUTION_JSON_CHARACTERS = 5_000_000

export interface ComfyUiWorkflowConversion {
  binding: ComfyUiWorkflowBinding
  mode: ImageGeneration
  prompt: string
  negativePrompt: string
  seed: number
  sourceImage?: string
  maskImage?: string
}

export interface ComfyUiWorkflowConverter {
  inspect(baseUrl: string, workflowPath: string, signal?: AbortSignal): Promise<ComfyUiWorkflowDescriptor>
  convert(baseUrl: string, conversion: ComfyUiWorkflowConversion, signal: AbortSignal): Promise<ComfyUiWorkflow>
  dispose(): void
}

function encodedPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Canceled', 'AbortError')
}

function workflowUrl(baseUrl: string, workflowPath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/userdata/${encodeURIComponent(workflowPath)}`
}

export class BrowserComfyUiWorkflowConverter implements ComfyUiWorkflowConverter {
  private window?: BrowserWindow
  private baseUrl?: string
  private queue: Promise<void> = Promise.resolve()

  inspect(
    baseUrl: string,
    workflowPath: string,
    signal = new AbortController().signal
  ): Promise<ComfyUiWorkflowDescriptor> {
    const input = comfyUiWorkflowInspectInputSchema.parse({ baseUrl, workflowPath })
    return this.enqueue(async () => {
      const window = await this.readyWindow(input.baseUrl, signal)
      const result = await this.execute(window, `
        const response = await fetch(payload.workflowUrl)
        if (!response.ok) throw new Error('ComfyUI workflow could not be read.')
        const text = await response.text()
        if (text.length > ${MAX_WORKFLOW_JSON_CHARACTERS}) throw new Error('ComfyUI workflow is too large.')
        await app.loadGraphData(JSON.parse(text), true, false)
        return {
          path: payload.workflowPath,
          nodes: app.graph._nodes.map((node) => ({
            id: String(node.id),
            title: String(node.title || node.type || node.id),
            classType: String(node.comfyClass || node.type || ''),
            mode: Number(node.mode),
            outputNode: node.constructor?.nodeData?.output_node === true,
            inputs: (node.widgets || [])
              .filter((widget) => widget.name && widget.options?.serialize !== false &&
                ['string', 'number', 'boolean'].includes(typeof widget.value))
              .map((widget) => ({ name: String(widget.name), valueType: typeof widget.value }))
          }))
        }
      `, {
        workflowPath: input.workflowPath,
        workflowUrl: workflowUrl(input.baseUrl, input.workflowPath)
      }, signal)
      return comfyUiWorkflowDescriptorSchema.parse(result)
    })
  }

  convert(
    baseUrl: string,
    conversion: ComfyUiWorkflowConversion,
    signal: AbortSignal
  ): Promise<ComfyUiWorkflow> {
    const binding = comfyUiWorkflowBindingSchema.parse(conversion.binding)
    const modeBinding = binding.modes[conversion.mode]
    if (!modeBinding) throw new Error('The ComfyUI workflow does not support this generation mode.')
    if (!Number.isSafeInteger(conversion.seed) || conversion.seed < 0) {
      throw new Error('The ComfyUI workflow seed is invalid.')
    }
    if (conversion.mode !== 'generate' && !conversion.sourceImage) {
      throw new Error('The ComfyUI workflow source image is missing.')
    }
    if (conversion.mode === 'inpaint' && !conversion.maskImage) {
      throw new Error('The ComfyUI workflow mask image is missing.')
    }

    return this.enqueue(async () => {
      const window = await this.readyWindow(baseUrl, signal)
      const result = await this.execute(window, `
        const response = await fetch(payload.workflowUrl)
        if (!response.ok) throw new Error('ComfyUI workflow could not be read.')
        const text = await response.text()
        if (text.length > ${MAX_WORKFLOW_JSON_CHARACTERS}) throw new Error('ComfyUI workflow is too large.')
        await app.loadGraphData(JSON.parse(text), true, false)

        const nodes = new Map(app.graph._nodes.map((node) => [String(node.id), node]))
        const requireNode = (nodeId) => {
          const node = nodes.get(String(nodeId))
          if (!node) throw new Error('A configured ComfyUI workflow node no longer exists.')
          return node
        }
        const setInput = (target, value) => {
          if (!target) return
          const node = requireNode(target.nodeId)
          const widget = (node.widgets || []).find((candidate) =>
            candidate.name === target.inputName && candidate.options?.serialize !== false)
          if (!widget) throw new Error('A configured ComfyUI workflow input no longer exists.')
          if (typeof widget.value !== typeof value) {
            throw new Error('A configured ComfyUI workflow input changed type.')
          }
          widget.value = value
        }

        for (const nodeId of payload.modeBinding.alwaysNodeIds) requireNode(nodeId).mode = 0
        for (const nodeId of payload.modeBinding.bypassNodeIds) requireNode(nodeId).mode = 4
        setInput(payload.binding.prompt, payload.prompt)
        setInput(payload.binding.negativePrompt, payload.negativePrompt)
        setInput(payload.binding.seed, payload.seed)
        if (payload.modeBinding.sourceImage) {
          setInput(payload.modeBinding.sourceImage, payload.sourceImage)
        }
        if (payload.modeBinding.maskImage) {
          setInput(payload.modeBinding.maskImage, payload.maskImage)
        }

        const converted = await app.graphToPrompt()
        if (!converted.output[payload.binding.outputNodeId]) {
          throw new Error('The configured ComfyUI output node is not executable in this mode.')
        }
        const serialized = JSON.stringify(converted.output)
        if (serialized.length > ${MAX_EXECUTION_JSON_CHARACTERS}) {
          throw new Error('Converted ComfyUI workflow is too large.')
        }
        return converted.output
      `, {
        ...conversion,
        binding,
        modeBinding,
        workflowUrl: workflowUrl(baseUrl, binding.workflowPath)
      }, signal)
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('ComfyUI returned an invalid converted workflow.')
      }
      return result as ComfyUiWorkflow
    })
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = undefined
    this.baseUrl = undefined
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async readyWindow(baseUrl: string, signal: AbortSignal): Promise<BrowserWindow> {
    if (signal.aborted) throw abortError(signal)
    const normalized = new URL(baseUrl).origin
    if (this.window && !this.window.isDestroyed() && this.baseUrl === baseUrl) return this.window
    this.dispose()

    const partition = `art-creator-comfyui-converter-${randomUUID()}`
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition
      }
    })
    this.window = window
    this.baseUrl = baseUrl
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, target) => {
      if (new URL(target).origin !== normalized) event.preventDefault()
    })
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      try {
        const target = new URL(details.url)
        const safeScheme = target.protocol === 'data:' || target.protocol === 'blob:'
        const safeRequest = target.origin === normalized &&
          (details.method === 'GET' || details.method === 'HEAD')
        callback({ cancel: !(safeScheme || safeRequest) })
      } catch {
        callback({ cancel: true })
      }
    })

    const onAbort = (): void => {
      if (!window.isDestroyed()) window.destroy()
      if (this.window === window) {
        this.window = undefined
        this.baseUrl = undefined
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await window.loadURL(`${baseUrl.replace(/\/+$/, '')}/`)
      await this.withTimeout(window.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const started = Date.now()
          const check = () => {
            const app = globalThis.comfyAPI?.app?.app
            try {
              const registeredTypes = globalThis.LiteGraph?.registered_node_types
              if (globalThis.app === app && app?.graph?._nodes && app?.canvas &&
                registeredTypes && Object.keys(registeredTypes).length > 0) return resolve(true)
            } catch {}
            if (Date.now() - started >= ${WORKFLOW_RUNTIME_TIMEOUT_MS}) {
              return reject(new Error('ComfyUI frontend runtime did not become ready.'))
            }
            setTimeout(check, 50)
          }
          check()
        })
      `), signal)
      return window
    } catch (error) {
      onAbort()
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private execute(
    window: BrowserWindow,
    body: string,
    payload: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    const encoded = encodedPayload(payload)
    return this.withTimeout(window.webContents.executeJavaScript(`
      (async () => {
        const encodedBytes = atob('${encoded}')
        const payloadBytes = Uint8Array.from(encodedBytes, (character) => character.charCodeAt(0))
        const payload = JSON.parse(new TextDecoder().decode(payloadBytes))
        const app = globalThis.comfyAPI?.app?.app
        if (!app?.graphToPrompt || !app?.loadGraphData) {
          throw new Error('ComfyUI frontend conversion API is unavailable.')
        }
        ${body}
      })()
    `), signal).catch((error: unknown) => {
      if (signal.aborted ||
        error instanceof Error && error.message === 'ComfyUI workflow conversion timed out.') {
        if (!window.isDestroyed()) window.destroy()
        if (this.window === window) {
          this.window = undefined
          this.baseUrl = undefined
        }
      }
      throw error
    })
  }

  private async withTimeout<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw abortError(signal)
    let timeout: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const cancellation = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('ComfyUI workflow conversion timed out.')),
        WORKFLOW_RUNTIME_TIMEOUT_MS)
      onAbort = () => reject(abortError(signal))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([operation, cancellation])
    } finally {
      if (timeout) clearTimeout(timeout)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
}
