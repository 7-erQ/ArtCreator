import type { AssetSpec } from '../shared/contracts'
import type { ImageLayout } from './image-layout'

export type ImageQuality = 'low' | 'medium' | 'high'
export type ImageBackground = 'opaque' | 'transparent'
export type ReferencePngs = readonly [Buffer, ...Buffer[]]

export interface ImageBatch {
  count: number
  // Deliver in provider order. Reject the operation if fewer images are available;
  // already delivered images remain valid and must not be replayed by a retry.
  onImage(png: Buffer): void
}

export interface ImageGenerator {
  readonly maxBatchSize: number
  generate(
    spec: AssetSpec,
    layout: ImageLayout,
    background: ImageBackground,
    quality: ImageQuality,
    signal: AbortSignal,
    batch: ImageBatch
  ): Promise<void>
  reference(
    spec: AssetSpec,
    referencePngs: ReferencePngs,
    layout: ImageLayout,
    background: ImageBackground,
    quality: ImageQuality,
    signal: AbortSignal,
    batch: ImageBatch
  ): Promise<void>
  inpaint(
    spec: AssetSpec,
    sourcePng: Buffer,
    maskPng: Buffer,
    layout: ImageLayout,
    background: ImageBackground,
    quality: ImageQuality,
    signal: AbortSignal,
    batch: ImageBatch
  ): Promise<void>
  edit(
    sourcePng: Buffer,
    prompt: string,
    layout: ImageLayout,
    background: ImageBackground,
    quality: ImageQuality,
    signal: AbortSignal,
    avoid?: readonly string[]
  ): Promise<Buffer>
}

// Cloud providers use this end-to-end deadline; ComfyUI owns its longer local deadline.
export const IMAGE_REQUEST_TIMEOUT_MS = 180_000
