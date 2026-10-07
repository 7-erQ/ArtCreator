import { nativeImage } from 'electron'
import {
  calculateContainedPlacement,
  placeBitmap,
  type ImageLayout
} from './image-layout'

export function normalizeGeneratedImage(
  png: Buffer,
  layout: ImageLayout,
  mode: 'contain' | 'cover' = 'contain'
): Buffer {
  const image = nativeImage.createFromBuffer(png)
  if (image.isEmpty()) throw new Error('The image API returned an invalid PNG.')

  const sourceSize = image.getSize()
  const normalized = mode === 'cover'
    ? normalizeCover(image, sourceSize, layout)
    : normalizeContain(image, sourceSize, layout)
  return normalized.toPNG()
}

function normalizeContain(
  image: Electron.NativeImage,
  sourceSize: Electron.Size,
  layout: ImageLayout
): Electron.NativeImage {
  const placement = calculateContainedPlacement(
    sourceSize.width,
    sourceSize.height,
    layout.canvasWidth,
    layout.canvasHeight
  )
  const resized = image.resize({
    width: placement.width,
    height: placement.height,
    quality: 'best'
  })
  const canvas = placeBitmap(
    resized.toBitmap(),
    placement.width,
    placement.height,
    layout.canvasWidth,
    layout.canvasHeight,
    placement.x,
    placement.y
  )
  return nativeImage.createFromBuffer(canvas, {
    width: layout.canvasWidth,
    height: layout.canvasHeight,
    scaleFactor: 1
  })
}

function normalizeCover(
  image: Electron.NativeImage,
  sourceSize: Electron.Size,
  layout: ImageLayout
): Electron.NativeImage {
  const sourceRatio = sourceSize.width / sourceSize.height
  const targetRatio = layout.canvasWidth / layout.canvasHeight
  const crop = sourceRatio > targetRatio
    ? {
        x: Math.floor((sourceSize.width - sourceSize.height * targetRatio) / 2),
        y: 0,
        width: Math.max(1, Math.round(sourceSize.height * targetRatio)),
        height: sourceSize.height
      }
    : {
        x: 0,
        y: Math.floor((sourceSize.height - sourceSize.width / targetRatio) / 2),
        width: sourceSize.width,
        height: Math.max(1, Math.round(sourceSize.width / targetRatio))
      }
  return image.crop(crop).resize({
    width: layout.canvasWidth,
    height: layout.canvasHeight,
    quality: 'best'
  })
}
