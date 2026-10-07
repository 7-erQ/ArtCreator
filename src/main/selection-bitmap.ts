import type { PixelRect } from '../shared/geometry'

function assertDimensions(width: number, height: number, target: PixelRect): void {
  if (![width, height, target.x, target.y, target.width, target.height]
    .every(Number.isSafeInteger) || width <= 0 || height <= 0 ||
    target.x < 0 || target.y < 0 || target.width <= 0 || target.height <= 0 ||
    target.x + target.width > width || target.y + target.height > height) {
    throw new Error('Target pixels must stay inside the context bitmap.')
  }
}

function pixelOffset(x: number, y: number, width: number): number {
  return (y * width + x) * 4
}

export interface BitmapPoint {
  x: number
  y: number
}

function paintDoodle(
  bitmap: Buffer,
  width: number,
  height: number,
  strokes: BitmapPoint[][],
  thickness: number,
  paintPixel: (offset: number) => void
): void {
  const points = strokes.flat()
  if (
    bitmap.length !== width * height * 4 ||
    strokes.length === 0 ||
    points.length === 0 ||
    !Number.isSafeInteger(thickness) ||
    thickness <= 0 ||
    points.some((point) =>
      !Number.isSafeInteger(point.x) ||
      !Number.isSafeInteger(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= width ||
      point.y >= height
    )
  ) {
    throw new Error('Invalid context bitmap or doodle strokes.')
  }

  const radius = Math.max(0.5, thickness / 2)
  const extent = Math.ceil(radius)
  const paintDisc = (centerX: number, centerY: number): void => {
    for (let y = Math.max(0, centerY - extent); y <= Math.min(height - 1, centerY + extent); y += 1) {
      for (let x = Math.max(0, centerX - extent); x <= Math.min(width - 1, centerX + extent); x += 1) {
        if ((x - centerX) ** 2 + (y - centerY) ** 2 > radius ** 2) continue
        paintPixel(pixelOffset(x, y, width))
      }
    }
  }

  for (const stroke of strokes) {
    paintDisc(stroke[0]!.x, stroke[0]!.y)
    for (let index = 1; index < stroke.length; index += 1) {
      const start = stroke[index - 1]!
      const end = stroke[index]!
      const steps = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y))
      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps
        paintDisc(
          Math.round(start.x + (end.x - start.x) * progress),
          Math.round(start.y + (end.y - start.y) * progress)
        )
      }
    }
  }
}

export function markTargetFrame(
  bitmap: Buffer,
  width: number,
  height: number,
  target: PixelRect,
  thickness: number
): Buffer {
  assertDimensions(width, height, target)
  if (bitmap.length !== width * height * 4 || !Number.isSafeInteger(thickness) || thickness <= 0) {
    throw new Error('Invalid context bitmap or frame thickness.')
  }

  const marked = Buffer.from(bitmap)
  const frameThickness = Math.min(
    thickness,
    Math.ceil(target.width / 2),
    Math.ceil(target.height / 2)
  )
  const right = target.x + target.width
  const bottom = target.y + target.height
  for (let y = target.y; y < bottom; y += 1) {
    for (let x = target.x; x < right; x += 1) {
      if (x >= target.x + frameThickness && x < right - frameThickness &&
        y >= target.y + frameThickness && y < bottom - frameThickness) continue
      const offset = pixelOffset(x, y, width)
      marked[offset] = 255
      marked[offset + 1] = 32
      marked[offset + 2] = 255
      marked[offset + 3] = 255
    }
  }
  return marked
}

export function createInpaintDoodleMaskBitmap(
  width: number,
  height: number,
  strokes: BitmapPoint[][],
  thickness: number
): Buffer {
  const mask = Buffer.alloc(width * height * 4, 255)
  paintDoodle(mask, width, height, strokes, thickness, (offset) => {
    mask[offset + 3] = 0
  })
  return mask
}
