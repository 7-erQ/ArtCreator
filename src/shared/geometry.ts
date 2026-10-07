import type { RectDip } from './contracts'

export interface PointDip {
  x: number
  y: number
}

export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

export function normalizeRect(start: PointDip, end: PointDip): RectDip {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  }
}

export function clampRect(rect: RectDip, bounds: RectDip): RectDip {
  const width = Math.min(rect.width, bounds.width)
  const height = Math.min(rect.height, bounds.height)
  return {
    x: Math.min(Math.max(rect.x, bounds.x), bounds.x + bounds.width - width),
    y: Math.min(Math.max(rect.y, bounds.y), bounds.y + bounds.height - height),
    width,
    height
  }
}

export function anchoredAspectRect(
  anchor: PointDip,
  point: PointDip,
  bounds: RectDip,
  aspectRatio: number
): RectDip {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    throw new Error('Aspect ratio must be a finite positive number.')
  }

  const deltaX = point.x - anchor.x
  const deltaY = point.y - anchor.y
  const availableLeft = Math.max(0, anchor.x - bounds.x)
  const availableRight = Math.max(0, bounds.x + bounds.width - anchor.x)
  const availableTop = Math.max(0, anchor.y - bounds.y)
  const availableBottom = Math.max(0, bounds.y + bounds.height - anchor.y)
  const directionX = deltaX === 0
    ? availableRight >= availableLeft ? 1 : -1
    : Math.sign(deltaX)
  const directionY = deltaY === 0
    ? availableBottom >= availableTop ? 1 : -1
    : Math.sign(deltaY)
  const availableWidth = directionX > 0 ? availableRight : availableLeft
  const availableHeight = directionY > 0 ? availableBottom : availableTop
  const desiredHeight = Math.max(Math.abs(deltaX) / aspectRatio, Math.abs(deltaY))
  const height = Math.min(
    desiredHeight,
    availableHeight,
    availableWidth / aspectRatio
  )
  const width = height * aspectRatio

  return {
    x: directionX > 0 ? anchor.x : anchor.x - width,
    y: directionY > 0 ? anchor.y : anchor.y - height,
    width,
    height
  }
}

export function toPhysicalPixels(rect: RectDip, scaleFactor: number): PixelRect {
  const left = Math.round(rect.x * scaleFactor)
  const top = Math.round(rect.y * scaleFactor)
  const right = Math.round((rect.x + rect.width) * scaleFactor)
  const bottom = Math.round((rect.y + rect.height) * scaleFactor)
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  }
}

export function toGlobalDisplayRect(
  displayBounds: RectDip,
  displayLocalRect: RectDip
): RectDip {
  return {
    x: displayBounds.x + displayLocalRect.x,
    y: displayBounds.y + displayLocalRect.y,
    width: displayLocalRect.width,
    height: displayLocalRect.height
  }
}
