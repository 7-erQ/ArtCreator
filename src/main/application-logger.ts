import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, stat, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { generationOptionsSchema, generatorPromptSchema, generationJobStatusSchema } from '../shared/contracts'

const generationLogSchema = z.object({
  jobId: z.string(),
  status: generationJobStatusSchema,
  options: generationOptionsSchema,
  completed: z.number().int().nonnegative().optional(),
  instruction: z.string().max(500).optional(),
  generatorPrompt: generatorPromptSchema.optional()
})
export type GenerationLogDetails = z.infer<typeof generationLogSchema>

export type TimingFlow = 'application' | 'capture' | 'generation'

export type LogDetailValue = string | number | boolean
export type LogDetailKey =
  | 'action'
  | 'arch'
  | 'attempt'
  | 'category'
  | 'code'
  | 'count'
  | 'requestSize'
  | 'canvasWidth'
  | 'canvasHeight'
  | 'background'
  | 'quality'
  | 'displays'
  | 'errorName'
  | 'exitCode'
  | 'operation'
  | 'param'
  | 'platform'
  | 'processType'
  | 'reason'
  | 'requestId'
  | 'simulated'
  | 'stage'
  | 'status'
  | 'target'
  | 'type'
  | 'version'
  | 'view'
  | 'webContentsId'
export type LogDetails = Partial<Record<LogDetailKey, LogDetailValue>>

export interface TimingEvent {
  flow: TimingFlow
  event: string
  workflowId?: string
  totalMs?: number
  stageMs?: number
  details?: LogDetails
  generation?: GenerationLogDetails
}

export type TimingLogger = (event: TimingEvent) => void

interface ApplicationLogEntry {
  timestamp: string
  level: 'info' | 'error'
  sessionId: string
  event: string
  flow?: TimingFlow
  workflowId?: string
  totalMs?: number
  stageMs?: number
  details?: LogDetails
}

export interface ApplicationLoggerOptions {
  isRelease: boolean
  directory: string
  maxFileBytes?: number
  fileCount?: number
  now?: () => Date
  sessionId?: string
  output?: Pick<Console, 'info' | 'error'>
}

export interface ApplicationLogger {
  readonly directory: string
  info(event: string, details?: LogDetails): void
  error(event: string, details?: LogDetails): void
  diagnostic(event: string, releaseDetails: LogDetails, developmentDetails?: unknown): void
  unexpected(event: string, error: unknown, details?: LogDetails): void
  timing: TimingLogger
  flush(): Promise<void>
  close(): Promise<void>
}

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024
const DEFAULT_FILE_COUNT = 3
const LOG_FILE_NAME = 'main.log'
const ALLOWED_DETAIL_KEYS = new Set<LogDetailKey>([
  'action',
  'arch',
  'attempt',
  'category',
  'code',
  'count',
  'requestSize',
  'canvasWidth',
  'canvasHeight',
  'background',
  'quality',
  'displays',
  'errorName',
  'exitCode',
  'operation',
  'param',
  'platform',
  'processType',
  'reason',
  'requestId',
  'simulated',
  'stage',
  'status',
  'target',
  'type',
  'version',
  'view',
  'webContentsId'
])

function safeErrorName(error: unknown): string {
  const name = error instanceof Error
    ? error.name
    : typeof error === 'object' && error !== null && 'name' in error
      ? error.name
      : undefined
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(name)
    ? name
    : 'UnknownError'
}

function safeDetails(details: LogDetails | undefined): LogDetails | undefined {
  if (!details) return undefined
  const result: LogDetails = {}
  for (const [rawKey, value] of Object.entries(details)) {
    const key = rawKey as LogDetailKey
    if (!ALLOWED_DETAIL_KEYS.has(key) || value === undefined) continue
    if (typeof value === 'string') {
      const hasControlCharacter = [...value].some((character) => {
        const code = character.charCodeAt(0)
        return code <= 31 || code === 127
      })
      if (value.length === 0 || value.length > 80 || hasControlCharacter) continue
      result[key] = value
      continue
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value)) result[key] = value
      continue
    }
    result[key] = value
  }
  return Object.keys(result).length > 0 ? result : undefined
}

class MainProcessLogger implements ApplicationLogger {
  readonly directory: string
  readonly timing: TimingLogger

  private readonly currentPath: string
  private readonly maxFileBytes: number
  private readonly fileCount: number
  private readonly now: () => Date
  private readonly sessionId: string
  private readonly output: Pick<Console, 'info' | 'error'>
  private queue: Promise<void> = Promise.resolve()
  private currentBytes: number | undefined
  private reportedWriteFailure = false
  private closed = false

  constructor(private readonly options: ApplicationLoggerOptions) {
    this.directory = options.directory
    this.currentPath = join(options.directory, LOG_FILE_NAME)
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.fileCount = options.fileCount ?? DEFAULT_FILE_COUNT
    this.now = options.now ?? (() => new Date())
    this.sessionId = options.sessionId ?? randomUUID().slice(0, 8)
    this.output = options.output ?? console
    this.timing = (event) => this.writeTiming(event)
  }

  info(event: string, details?: LogDetails): void {
    if (this.closed) return
    if (!this.options.isRelease) {
      this.output.info('[application]', event, details ?? {})
    }
    this.writeApplicationEntry('info', event, details)
  }

  error(event: string, details?: LogDetails): void {
    if (this.closed) return
    if (!this.options.isRelease) {
      this.output.error('[application]', event, details ?? {})
    }
    this.writeApplicationEntry('error', event, details)
  }

  diagnostic(event: string, releaseDetails: LogDetails, developmentDetails?: unknown): void {
    if (this.closed) return
    if (!this.options.isRelease) {
      this.output.error('[application]', event, developmentDetails ?? releaseDetails)
    }
    this.writeApplicationEntry('error', event, releaseDetails)
  }

  unexpected(event: string, error: unknown, details?: LogDetails): void {
    if (this.closed) return
    if (!this.options.isRelease) {
      this.output.error('[application]', event, error, details ?? {})
    }
    this.writeApplicationEntry('error', event, { ...details, errorName: safeErrorName(error) })
  }

  private writeApplicationEntry(level: 'info' | 'error', event: string, details?: LogDetails): void {
    const sanitized = safeDetails(details)
    this.enqueue({
      timestamp: this.now().toISOString(),
      level,
      sessionId: this.sessionId,
      event,
      ...(sanitized ? { details: sanitized } : {})
    })
  }

  flush(): Promise<void> {
    return this.queue
  }

  close(): Promise<void> {
    this.closed = true
    return this.queue
  }

  private writeTiming(event: TimingEvent): void {
    if (this.closed) return
    if (!this.options.isRelease) {
      this.output.info('[development-timing]', JSON.stringify(event))
    }
    const details = safeDetails(event.details)
    this.enqueue({
      timestamp: this.now().toISOString(),
      level: 'info',
      sessionId: this.sessionId,
      event: event.event,
      flow: event.flow,
      ...(event.workflowId ? { workflowId: event.workflowId } : {}),
      ...(event.totalMs === undefined ? {} : { totalMs: event.totalMs }),
      ...(event.stageMs === undefined ? {} : { stageMs: event.stageMs }),
      ...(details ? { details } : {}),
      ...(event.generation ? { generation: generationLogSchema.parse(event.generation) } : {})
    })
  }

  private enqueue(entry: ApplicationLogEntry): void {
    const line = `${JSON.stringify(entry)}\n`
    this.queue = this.queue
      .then(() => this.append(line))
      .catch((error: unknown) => this.reportWriteFailure(error))
  }

  private async append(line: string): Promise<void> {
    await this.ensureInitialized()
    const lineBytes = Buffer.byteLength(line)
    if (this.currentBytes! > 0 && this.currentBytes! + lineBytes > this.maxFileBytes) {
      await this.rotate()
    }
    await appendFile(this.currentPath, line, 'utf8')
    this.currentBytes = (this.currentBytes ?? 0) + lineBytes
  }

  private async ensureInitialized(): Promise<void> {
    if (this.currentBytes !== undefined) return
    await mkdir(this.options.directory, { recursive: true })
    try {
      this.currentBytes = (await stat(this.currentPath)).size
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        this.currentBytes = 0
        return
      }
      throw error
    }
  }

  private async rotate(): Promise<void> {
    for (let index = this.fileCount - 1; index >= 1; index -= 1) {
      const source = index === 1
        ? this.currentPath
        : join(this.options.directory, `main.${index - 1}.log`)
      const destination = join(this.options.directory, `main.${index}.log`)
      await rm(destination, { force: true })
      try {
        await rename(source, destination)
      } catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') {
          throw error
        }
      }
    }
    this.currentBytes = 0
  }

  private reportWriteFailure(error: unknown): void {
    if (this.reportedWriteFailure) return
    this.reportedWriteFailure = true
    this.output.error('[application-log] File logging failed.', safeErrorName(error))
  }
}

export function createApplicationLogger(options: ApplicationLoggerOptions): ApplicationLogger {
  return new MainProcessLogger(options)
}

export function timingNow(): number {
  return performance.now()
}

export function elapsedTimingMs(startedAtMs: number): number {
  return Math.max(0, Math.round(timingNow() - startedAtMs))
}
