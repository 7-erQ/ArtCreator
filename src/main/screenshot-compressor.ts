import { nativeImage } from 'electron'
import type { ScreenshotCompression } from '../shared/contracts'
import type { PromptImage } from './openai-asset-generator'

export interface ImageSize {
  width: number
  height: number
}

export function compressedImageSize(source: ImageSize, maxEdge: number): ImageSize {
  const longestEdge = Math.max(source.width, source.height)
  if (longestEdge <= maxEdge) return { ...source }

  const scale = maxEdge / longestEdge
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale))
  }
}

export function compressScreenshot(
  sourcePng: Buffer,
  settings: ScreenshotCompression
): PromptImage {
  if (!settings.enabled) return { data: sourcePng, mediaType: 'image/png' }

  const image = nativeImage.createFromBuffer(sourcePng)
  if (image.isEmpty()) throw new Error('Screenshot compression received an invalid PNG.')

  const sourceSize = image.getSize()
  const targetSize = compressedImageSize(sourceSize, settings.maxEdge)
  const encodedImage = targetSize.width === sourceSize.width && targetSize.height === sourceSize.height
    ? image
    : image.resize({ ...targetSize, quality: 'best' })

  return {
    data: encodedImage.toJPEG(settings.quality),
    mediaType: 'image/jpeg'
  }
}
