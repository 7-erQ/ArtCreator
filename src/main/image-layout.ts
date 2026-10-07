import { UPSCALE_DIMENSION_MAX, UPSCALE_DIMENSION_MIN } from '../shared/contracts'

const TARGET_PIXELS = 1024 * 1024
export const PREVIEW_MAX_EDGE = 512
const MIN_API_RATIO = 1 / 3
const MAX_API_RATIO = 3
const MAX_CANVAS_EDGE = UPSCALE_DIMENSION_MAX

export interface ImageLayout {
  requestWidth: number
  requestHeight: number
  requestSize: `${number}x${number}`
  canvasWidth: number
  canvasHeight: number
  requiresPadding: boolean
}

export interface ImagePlacement {
  x: number
  y: number
  width: number
  height: number
}

function roundTo16(value: number): number {
  return Math.max(16, Math.round(value / 16) * 16)
}

function floorTo16(value: number): number {
  return Math.max(16, Math.floor(value / 16) * 16)
}

function dimensionsForRatio(ratio: number, targetPixels: number): { width: number; height: number } {
  const height = Math.sqrt(targetPixels / ratio)
  return {
    width: roundTo16(height * ratio),
    height: roundTo16(height)
  }
}

export function calculateImageLayout(
  targetWidth: number,
  targetHeight: number,
  targetPixels = TARGET_PIXELS
): ImageLayout {
  if (!Number.isFinite(targetWidth) || !Number.isFinite(targetHeight) ||
    targetWidth <= 0 || targetHeight <= 0) {
    throw new Error('Target dimensions must be finite positive numbers.')
  }

  const targetRatio = targetWidth / targetHeight
  const requestRatio = Math.min(MAX_API_RATIO, Math.max(MIN_API_RATIO, targetRatio))
  const request = dimensionsForRatio(requestRatio, targetPixels)
  const requiresPadding = targetRatio < MIN_API_RATIO || targetRatio > MAX_API_RATIO

  if (!requiresPadding) {
    return {
      requestWidth: request.width,
      requestHeight: request.height,
      requestSize: `${request.width}x${request.height}`,
      canvasWidth: request.width,
      canvasHeight: request.height,
      requiresPadding: false
    }
  }

  let canvasScale = Math.sqrt(targetPixels / (targetWidth * targetHeight))
  canvasScale = Math.min(canvasScale, MAX_CANVAS_EDGE / Math.max(targetWidth, targetHeight))
  const canvasWidth = Math.max(1, Math.round(targetWidth * canvasScale))
  const canvasHeight = Math.max(1, Math.round(targetHeight * canvasScale))

  return {
    requestWidth: request.width,
    requestHeight: request.height,
    requestSize: `${request.width}x${request.height}`,
    canvasWidth,
    canvasHeight,
    requiresPadding: true
  }
}

export function calculateTargetSizeImageLayout(
  targetWidth: number,
  targetHeight: number,
  maxEdge?: number
): ImageLayout {
  if (maxEdge !== undefined && (!Number.isFinite(maxEdge) || maxEdge <= 0)) {
    throw new Error('Preview maximum edge must be a finite positive number.')
  }

  const targetMaxEdge = Math.max(targetWidth, targetHeight)
  const scale = maxEdge !== undefined && targetMaxEdge > maxEdge
    ? floorTo16(maxEdge) / targetMaxEdge
    : 1
  const width = targetWidth * scale
  const height = targetHeight * scale
  return calculateImageLayout(width, height, width * height)
}

export function calculateSpecifiedImageLayout(
  targetWidth: number,
  targetHeight: number
): ImageLayout {
  if (!Number.isSafeInteger(targetWidth) || !Number.isSafeInteger(targetHeight) ||
    targetWidth < UPSCALE_DIMENSION_MIN || targetHeight < UPSCALE_DIMENSION_MIN ||
    targetWidth > MAX_CANVAS_EDGE || targetHeight > MAX_CANVAS_EDGE) {
    throw new Error(
      `Specified dimensions must be integers between ${UPSCALE_DIMENSION_MIN} and ${MAX_CANVAS_EDGE}.`
    )
  }

  return {
    ...calculateImageLayout(targetWidth, targetHeight, targetWidth * targetHeight),
    canvasWidth: targetWidth,
    canvasHeight: targetHeight
  }
}

export function calculateContainedPlacement(
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number
): ImagePlacement {
  const scale = Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight)
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  return {
    x: Math.floor((canvasWidth - width) / 2),
    y: Math.floor((canvasHeight - height) / 2),
    width,
    height
  }
}

export function placeBitmap(
  source: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  offsetX: number,
  offsetY: number
): Buffer {
  if (source.length !== sourceWidth * sourceHeight * 4) {
    throw new Error('Source bitmap length does not match its dimensions.')
  }
  if (offsetX < 0 || offsetY < 0 ||
    offsetX + sourceWidth > canvasWidth || offsetY + sourceHeight > canvasHeight) {
    throw new Error('Source bitmap does not fit inside the target canvas.')
  }

  const canvas = Buffer.alloc(canvasWidth * canvasHeight * 4)
  const rowBytes = sourceWidth * 4
  for (let row = 0; row < sourceHeight; row += 1) {
    const sourceStart = row * rowBytes
    const targetStart = ((offsetY + row) * canvasWidth + offsetX) * 4
    source.copy(canvas, targetStart, sourceStart, sourceStart + rowBytes)
  }
  return canvas
}
