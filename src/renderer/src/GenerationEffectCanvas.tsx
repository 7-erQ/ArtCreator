import { useEffect, useRef } from 'react'
import type { GenerationEffectSchemeId } from '../../shared/contracts'
import {
  createColorWanderDirectionSeed,
  createColorWanderFamilyPlan,
  createColorWanderPath,
  resolveColorWanderFrame,
  type ColorWanderDirection,
  type ColorWanderPath
} from './GenerationEffectColorWander'
import {
  CONTOUR_TRACE_DURATION_MS,
  CONTOUR_TRACE_MAX_SAMPLE_LONG_EDGE,
  createContourTrace,
  resolveContourTraceFrame,
  type ContourPath,
  type ContourTrace,
  type ContourTraceFrame
} from './GenerationEffectContourTrace'
import {
  PIXEL_RECOMPOSE_MAX_STEP,
  PIXEL_RECOMPOSE_SWEEP_DURATION_MS,
  resolvePixelBlockSize,
  resolvePixelDotStyle,
  participatesInPixelRipple,
  resolvePixelRipplePosition,
  resolvePixelRippleTransform,
  resolvePixelRecomposeFrame,
  type PixelRecomposeFrame,
  type PixelRipplePosition
} from './GenerationEffectPixelRecompose'

interface GenerationEffectCanvasProps {
  active: boolean
  scheme: GenerationEffectSchemeId
  sourceImageUrl?: string
}

interface SampledImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

interface SourceRect {
  x: number
  y: number
  width: number
  height: number
}

const MAX_DEVICE_SCALE = 1.5
const COLOR_WANDER_SAMPLE_LONG_EDGE = 192
const TWO_PI = Math.PI * 2

function resolveCoverSourceRect(
  image: HTMLImageElement,
  targetWidth: number,
  targetHeight: number
): SourceRect {
  const imageRatio = image.naturalWidth / image.naturalHeight
  const targetRatio = targetWidth / targetHeight
  if (imageRatio > targetRatio) {
    const width = image.naturalHeight * targetRatio
    return {
      x: (image.naturalWidth - width) / 2,
      y: 0,
      width,
      height: image.naturalHeight
    }
  }

  const height = image.naturalWidth / targetRatio
  return {
    x: 0,
    y: (image.naturalHeight - height) / 2,
    width: image.naturalWidth,
    height
  }
}

function sampleImage(
  image: HTMLImageElement,
  width: number,
  height: number,
  longestEdge = 144
): SampledImage {
  const scale = Math.min(longestEdge / width, longestEdge / height, 1)
  const sampleWidth = Math.max(8, Math.round(width * scale))
  const sampleHeight = Math.max(8, Math.round(height * scale))
  const surface = document.createElement('canvas')
  surface.width = sampleWidth
  surface.height = sampleHeight
  const context = surface.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas 2D context is unavailable.')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'

  const source = resolveCoverSourceRect(image, sampleWidth, sampleHeight)
  context.drawImage(
    image,
    source.x,
    source.y,
    source.width,
    source.height,
    0,
    0,
    sampleWidth,
    sampleHeight
  )
  return {
    data: context.getImageData(0, 0, sampleWidth, sampleHeight).data,
    width: sampleWidth,
    height: sampleHeight
  }
}

function createPixelSamples(
  image: HTMLImageElement,
  width: number,
  height: number
): SampledImage[] {
  const source = resolveCoverSourceRect(image, width, height)
  const shortEdge = Math.min(width, height)

  return Array.from({ length: PIXEL_RECOMPOSE_MAX_STEP }, (_, index) => {
    const blockSize = resolvePixelBlockSize(shortEdge, index + 1)
    const surface = document.createElement('canvas')
    surface.width = Math.max(1, Math.round(width / blockSize))
    surface.height = Math.max(1, Math.round(height / blockSize))
    const context = surface.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas 2D context is unavailable.')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(
      image,
      source.x,
      source.y,
      source.width,
      source.height,
      0,
      0,
      surface.width,
      surface.height
    )
    return {
      data: context.getImageData(0, 0, surface.width, surface.height).data,
      width: surface.width,
      height: surface.height
    }
  })
}

function fillPixelDot(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  diameter: number,
  red: number,
  green: number,
  blue: number,
  shaded: boolean
): void {
  const radius = diameter / 2
  if (radius <= 0) return

  if (shaded) {
    const gradient = context.createRadialGradient(
      centerX - radius * 0.3,
      centerY - radius * 0.34,
      radius * 0.08,
      centerX,
      centerY,
      radius
    )
    gradient.addColorStop(
      0,
      `rgb(${Math.min(255, red + 38)} ${Math.min(255, green + 38)} ${Math.min(255, blue + 38)})`
    )
    gradient.addColorStop(0.42, `rgb(${red} ${green} ${blue})`)
    gradient.addColorStop(
      1,
      `rgb(${Math.round(red * 0.48)} ${Math.round(green * 0.48)} ${Math.round(blue * 0.48)})`
    )
    context.fillStyle = gradient
  } else {
    context.fillStyle = `rgb(${red} ${green} ${blue})`
  }

  context.beginPath()
  context.arc(centerX, centerY, radius, 0, TWO_PI)
  context.fill()
}

function renderPixelSurface(
  surface: HTMLCanvasElement,
  sample: SampledImage,
  width: number,
  height: number
): void {
  surface.width = Math.max(1, Math.round(width))
  surface.height = Math.max(1, Math.round(height))
  const context = surface.getContext('2d')
  if (!context) throw new Error('Canvas 2D context is unavailable.')

  context.fillStyle = 'rgb(17 22 18)'
  context.fillRect(0, 0, surface.width, surface.height)

  const cellWidth = surface.width / sample.width
  const cellHeight = surface.height / sample.height
  const { diameter, shaded } = resolvePixelDotStyle(cellWidth, cellHeight)

  for (let row = 0; row < sample.height; row += 1) {
    for (let column = 0; column < sample.width; column += 1) {
      const offset = (row * sample.width + column) * 4
      const alpha = sample.data[offset + 3] ?? 0
      if (alpha === 0) continue

      context.globalAlpha = alpha / 255
      fillPixelDot(
        context,
        (column + 0.5) * cellWidth,
        (row + 0.5) * cellHeight,
        diameter,
        sample.data[offset] ?? 0,
        sample.data[offset + 1] ?? 0,
        sample.data[offset + 2] ?? 0,
        shaded
      )
    }
  }
  context.globalAlpha = 1
}

function drawContourPath(
  context: CanvasRenderingContext2D,
  path: ContourPath,
  visibleLength: number
): void {
  const first = path.points[0]
  if (!first || visibleLength <= 0) return

  let remaining = visibleLength
  context.beginPath()
  context.moveTo(first.x, first.y)
  for (let index = 1; index < path.points.length; index += 1) {
    const previous = path.points[index - 1]!
    const current = path.points[index]!
    const segmentLength = Math.hypot(current.x - previous.x, current.y - previous.y)
    if (segmentLength <= remaining) {
      context.lineTo(current.x, current.y)
      remaining -= segmentLength
      continue
    }

    const ratio = segmentLength > 0 ? remaining / segmentLength : 0
    context.lineTo(
      previous.x + (current.x - previous.x) * ratio,
      previous.y + (current.y - previous.y) * ratio
    )
    break
  }
  context.stroke()
}

function drawContourTrace(
  context: CanvasRenderingContext2D,
  trace: ContourTrace,
  frame: ContourTraceFrame
): void {
  context.globalCompositeOperation = 'source-over'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.shadowBlur = 0
  context.globalAlpha = trace.opacity
  context.lineWidth = trace.lineWidth

  let remaining = trace.totalLength * frame.progress
  for (const path of trace.paths) {
    if (remaining <= 0) break
    context.strokeStyle = `rgb(${path.color})`
    drawContourPath(context, path, Math.min(path.length, remaining))
    remaining -= path.length
  }
}

function createColorWanderBatchMasks(sample: SampledImage): HTMLCanvasElement[] {
  const plan = createColorWanderFamilyPlan(sample)
  return plan.orderedBatches.map((_, batchIndex) => {
    const surface = document.createElement('canvas')
    surface.width = sample.width
    surface.height = sample.height
    const context = surface.getContext('2d')
    if (!context) throw new Error('Canvas 2D context is unavailable.')
    const pixels = context.createImageData(sample.width, sample.height)
    for (let index = 0; index < plan.familyByPixel.length; index += 1) {
      if (plan.batchByPixel[index] !== batchIndex) continue
      const offset = index * 4
      pixels.data[offset] = 255
      pixels.data[offset + 1] = 255
      pixels.data[offset + 2] = 255
      pixels.data[offset + 3] = 255
    }
    context.putImageData(pixels, 0, 0)
    return surface
  })
}

function appendColorWanderPathMask(
  context: CanvasRenderingContext2D,
  path: ColorWanderPath,
  fromLength: number,
  toLength: number
): void {
  const start = Math.max(0, fromLength)
  const end = Math.min(path.totalLength, Math.max(start, toLength))
  if (end <= start || path.points.length < 2) return

  const stroke = new Path2D()
  let hasSegment = false
  for (let index = 1; index < path.points.length; index += 1) {
    const segmentStart = path.cumulativeLengths[index - 1]!
    const segmentEnd = path.cumulativeLengths[index]!
    if (segmentEnd <= start) continue
    if (segmentStart >= end) break

    const previous = path.points[index - 1]!
    const current = path.points[index]!
    const segmentLength = segmentEnd - segmentStart
    if (segmentLength <= 0) continue
    const startRatio = Math.max(0, (start - segmentStart) / segmentLength)
    const endRatio = Math.min(1, (end - segmentStart) / segmentLength)
    stroke.moveTo(
      previous.x + (current.x - previous.x) * startRatio,
      previous.y + (current.y - previous.y) * startRatio
    )
    stroke.lineTo(
      previous.x + (current.x - previous.x) * endRatio,
      previous.y + (current.y - previous.y) * endRatio
    )
    hasSegment = true
  }

  if (!hasSegment) return
  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.strokeStyle = 'rgba(255, 255, 255, 0.24)'
  context.lineWidth = path.brushDiameter * 1.35
  context.stroke(stroke)
  context.strokeStyle = '#fff'
  context.lineWidth = path.brushDiameter
  context.stroke(stroke)
  context.restore()
}

function commitColorWanderBatch(
  context: CanvasRenderingContext2D,
  batchMask: HTMLCanvasElement,
  width: number,
  height: number
): void {
  context.save()
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(batchMask, 0, 0, width, height)
  context.restore()
}

function appendColorWanderIntroductionBatch(
  revealedContext: CanvasRenderingContext2D,
  strokeContext: CanvasRenderingContext2D,
  strokeSurface: HTMLCanvasElement,
  batchMask: HTMLCanvasElement,
  path: ColorWanderPath,
  fromLength: number,
  toLength: number,
  width: number,
  height: number
): void {
  strokeContext.clearRect(0, 0, strokeSurface.width, strokeSurface.height)
  appendColorWanderPathMask(strokeContext, path, fromLength, toLength)
  strokeContext.save()
  strokeContext.globalCompositeOperation = 'destination-in'
  strokeContext.imageSmoothingEnabled = true
  strokeContext.imageSmoothingQuality = 'high'
  strokeContext.drawImage(batchMask, 0, 0, strokeSurface.width, strokeSurface.height)
  strokeContext.restore()
  revealedContext.drawImage(strokeSurface, 0, 0, width, height)
}

function drawColorWanderSweep(
  context: CanvasRenderingContext2D,
  direction: ColorWanderDirection,
  progress: number,
  width: number,
  height: number
): void {
  const visibleProgress = Math.max(0, Math.min(progress, 1))
  if (visibleProgress === 0) return

  context.fillStyle = '#fff'
  if (direction === 'left-to-right') {
    context.fillRect(0, 0, width * visibleProgress, height)
  } else if (direction === 'right-to-left') {
    context.fillRect(width * (1 - visibleProgress), 0, width * visibleProgress, height)
  } else if (direction === 'top-to-bottom') {
    context.fillRect(0, 0, width, height * visibleProgress)
  } else {
    context.fillRect(0, height * (1 - visibleProgress), width, height * visibleProgress)
  }
}

function renderColorWanderFamily(
  revealedContext: CanvasRenderingContext2D,
  sweepContext: CanvasRenderingContext2D,
  sweepSurface: HTMLCanvasElement,
  familyMask: HTMLCanvasElement,
  direction: ColorWanderDirection,
  progress: number,
  width: number,
  height: number
): void {
  revealedContext.clearRect(0, 0, width, height)
  sweepContext.clearRect(0, 0, sweepSurface.width, sweepSurface.height)
  drawColorWanderSweep(sweepContext, direction, progress, width, height)

  revealedContext.save()
  revealedContext.imageSmoothingEnabled = true
  revealedContext.imageSmoothingQuality = 'high'
  revealedContext.drawImage(familyMask, 0, 0, width, height)
  revealedContext.globalCompositeOperation = 'destination-in'
  revealedContext.drawImage(sweepSurface, 0, 0, width, height)
  revealedContext.restore()
}

function drawCoverImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number
): void {
  const source = resolveCoverSourceRect(image, width, height)
  context.drawImage(
    image,
    source.x,
    source.y,
    source.width,
    source.height,
    0,
    0,
    width,
    height
  )
}

function drawColorWander(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  mask: HTMLCanvasElement,
  width: number,
  height: number
): void {
  context.save()
  context.drawImage(mask, 0, 0, width, height)
  context.globalCompositeOperation = 'source-in'
  drawCoverImage(context, image, width, height)
  context.restore()
}

function drawCenterRippleBand(
  context: CanvasRenderingContext2D,
  sample: SampledImage,
  width: number,
  height: number,
  ripple: PixelRipplePosition
): void {
  if (ripple.bandWidth <= 0 || ripple.outerRadius <= 0 ||
    ripple.innerRadius >= ripple.maxRadius) return

  const cellWidth = width / sample.width
  const cellHeight = height / sample.height
  const { diameter, shaded } = resolvePixelDotStyle(cellWidth, cellHeight)
  const centerX = width / 2
  const centerY = height / 2
  const outerRadiusSquared = ripple.outerRadius ** 2

  for (let row = 0; row < sample.height; row += 1) {
    const pixelCenterY = (row + 0.5) * cellHeight
    const offsetY = pixelCenterY - centerY
    const offsetYSquared = offsetY ** 2
    if (offsetYSquared >= outerRadiusSquared) continue

    const outerHalfWidth = Math.sqrt(outerRadiusSquared - offsetYSquared)
    const firstColumn = Math.max(
      0,
      Math.ceil((centerX - outerHalfWidth) / cellWidth - 0.5)
    )
    const lastColumn = Math.min(
      sample.width - 1,
      Math.floor((centerX + outerHalfWidth) / cellWidth - 0.5)
    )
    const innerHalfWidth = ripple.innerRadius > Math.abs(offsetY)
      ? Math.sqrt(ripple.innerRadius ** 2 - offsetYSquared)
      : 0
    const excludedFirstColumn = innerHalfWidth > 0
      ? Math.max(firstColumn, Math.ceil((centerX - innerHalfWidth) / cellWidth - 0.5))
      : lastColumn + 1
    const excludedLastColumn = innerHalfWidth > 0
      ? Math.min(lastColumn, Math.floor((centerX + innerHalfWidth) / cellWidth - 0.5))
      : lastColumn

    for (let column = firstColumn; column <= lastColumn; column += 1) {
      if (column >= excludedFirstColumn && column <= excludedLastColumn) {
        column = excludedLastColumn
        continue
      }
      if (!participatesInPixelRipple(row, column)) continue

      const pixelCenterX = (column + 0.5) * cellWidth
      const distance = Math.hypot(pixelCenterX - centerX, offsetY)
      if (distance <= ripple.innerRadius || distance >= ripple.outerRadius) continue

      const bandRatio = (distance - ripple.innerRadius) / ripple.bandWidth
      const transform = resolvePixelRippleTransform(width, height, bandRatio)
      if (transform.lift < 0.35) continue

      const offset = (row * sample.width + column) * 4
      const alpha = sample.data[offset + 3] ?? 0
      if (alpha === 0) continue

      const scaledDiameter = diameter * transform.scale
      const red = sample.data[offset] ?? 0
      const green = sample.data[offset + 1] ?? 0
      const blue = sample.data[offset + 2] ?? 0

      context.save()
      context.globalAlpha = alpha / 255 * Math.min(0.94, transform.strength * 1.1)
      context.fillStyle = 'rgb(4 9 7)'
      context.beginPath()
      context.arc(pixelCenterX, pixelCenterY, diameter / 2, 0, TWO_PI)
      context.fill()

      context.globalAlpha = alpha / 255 * transform.strength * 0.42
      context.fillStyle = 'rgb(0 0 0)'
      context.beginPath()
      context.ellipse(
        pixelCenterX,
        pixelCenterY + diameter * 0.18,
        diameter * 0.38,
        diameter * 0.16,
        0,
        0,
        TWO_PI
      )
      context.fill()
      context.restore()

      const brighten = Math.round(20 * transform.strength)
      context.save()
      context.globalAlpha = alpha / 255
      context.shadowColor = 'rgba(0, 0, 0, 0.72)'
      context.shadowBlur = 3 + transform.lift * 0.22
      context.shadowOffsetY = 2 + transform.lift * 0.3
      fillPixelDot(
        context,
        pixelCenterX,
        pixelCenterY - transform.lift,
        scaledDiameter,
        Math.min(255, red + brighten),
        Math.min(255, green + brighten),
        Math.min(255, blue + brighten),
        shaded
      )
      context.restore()
    }
  }
}

function drawPixelRecompose(
  context: CanvasRenderingContext2D,
  previousSurface: HTMLCanvasElement | undefined,
  targetSurface: HTMLCanvasElement | undefined,
  targetSample: SampledImage | undefined,
  width: number,
  height: number,
  frame: PixelRecomposeFrame
): void {
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  if (previousSurface) context.drawImage(previousSurface, 0, 0, width, height)
  if (!targetSurface || !targetSample) return

  const ripple = resolvePixelRipplePosition(
    width,
    height,
    frame.progress,
    Math.min(width / targetSample.width, height / targetSample.height)
  )
  if (ripple.targetRadius > 0) {
    context.save()
    context.beginPath()
    context.arc(width / 2, height / 2, ripple.targetRadius, 0, TWO_PI)
    context.clip()
    context.drawImage(targetSurface, 0, 0, width, height)
    context.restore()
  }

  drawCenterRippleBand(context, targetSample, width, height, ripple)
}

export function GenerationEffectCanvas({
  active,
  scheme,
  sourceImageUrl
}: GenerationEffectCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !sourceImageUrl || !active) return
    const context = canvas.getContext('2d')
    if (!context) return

    const image = new Image()
    let animationFrame = 0
    let contourTrace: ContourTrace | undefined
    let colorWanderBatchMasks: HTMLCanvasElement[] = []
    let colorWanderPaths: ColorWanderPath[] = []
    let colorWanderCompletedBatches = 0
    let colorWanderActiveBatch = -1
    let colorWanderVisibleLength = 0
    let colorWanderDirectionSeed = 0
    let pixelSamples: SampledImage[] = []
    const colorWanderRevealedMask = document.createElement('canvas')
    const colorWanderSweepMask = document.createElement('canvas')
    const pixelSurfaces = [document.createElement('canvas'), document.createElement('canvas')]
    const pixelSurfaceSteps = [-1, -1]
    let width = 0
    let height = 0
    let startedAt = 0
    let disposed = false
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const prepare = (): void => {
      if (disposed || !image.naturalWidth || !image.naturalHeight) return
      const bounds = canvas.getBoundingClientRect()
      width = Math.max(1, bounds.width)
      height = Math.max(1, bounds.height)
      const scale = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_SCALE)
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      context.setTransform(scale, 0, 0, scale, 0, 0)

      contourTrace = undefined
      colorWanderBatchMasks = []
      colorWanderPaths = []
      colorWanderCompletedBatches = 0
      colorWanderActiveBatch = -1
      colorWanderVisibleLength = 0
      pixelSamples = []
      pixelSurfaceSteps[0] = -1
      pixelSurfaceSteps[1] = -1
      try {
        if (scheme === 'pixel-weave') {
          pixelSamples = createPixelSamples(image, width, height)
        } else if (scheme === 'frosted-orbit') {
          contourTrace = createContourTrace(
            sampleImage(image, width, height, CONTOUR_TRACE_MAX_SAMPLE_LONG_EDGE),
            width,
            height
          )
        } else {
          colorWanderRevealedMask.width = Math.max(1, Math.round(width))
          colorWanderRevealedMask.height = Math.max(1, Math.round(height))
          colorWanderSweepMask.width = colorWanderRevealedMask.width
          colorWanderSweepMask.height = colorWanderRevealedMask.height
          const sample = sampleImage(image, width, height, COLOR_WANDER_SAMPLE_LONG_EDGE)
          colorWanderBatchMasks = createColorWanderBatchMasks(sample)
          colorWanderPaths = colorWanderBatchMasks.map((_, index) =>
            createColorWanderPath(
              colorWanderRevealedMask.width,
              colorWanderRevealedMask.height,
              index
            ))
        }
      } catch {
        contourTrace = undefined
        colorWanderBatchMasks = []
        colorWanderPaths = []
        pixelSamples = []
      }
    }

    const resolvePixelSurface = (
      slot: number,
      step: number
    ): HTMLCanvasElement | undefined => {
      if (step === 0) return undefined
      const sample = pixelSamples[step - 1]
      const surface = pixelSurfaces[slot]
      if (!sample || !surface) return undefined
      if (pixelSurfaceSteps[slot] !== step) {
        renderPixelSurface(surface, sample, width, height)
        pixelSurfaceSteps[slot] = step
      }
      return surface
    }

    const draw = (timestamp: number): void => {
      context.clearRect(0, 0, width, height)
      if (scheme === 'frosted-orbit') {
        const frame = reducedMotion
          ? resolveContourTraceFrame(CONTOUR_TRACE_DURATION_MS)
          : resolveContourTraceFrame(timestamp - startedAt)
        if (contourTrace) drawContourTrace(context, contourTrace, frame)
        if (!reducedMotion && !frame.complete && contourTrace?.totalLength) {
          animationFrame = window.requestAnimationFrame(draw)
        }
      } else if (scheme === 'aperture-fold') {
        const revealedContext = colorWanderRevealedMask.getContext('2d')
        const sweepContext = colorWanderSweepMask.getContext('2d')
        if (!revealedContext || !sweepContext) return
        if (reducedMotion) {
          drawCoverImage(context, image, width, height)
          return
        }

        const frame = resolveColorWanderFrame(
          timestamp - startedAt,
          colorWanderBatchMasks.length,
          colorWanderDirectionSeed
        )
        if (frame.phase === 'intro-sweeping') {
          while (colorWanderCompletedBatches < frame.completedBatchCount) {
            const batchMask = colorWanderBatchMasks[colorWanderCompletedBatches]
            if (batchMask) {
              commitColorWanderBatch(
                revealedContext,
                batchMask,
                colorWanderRevealedMask.width,
                colorWanderRevealedMask.height
              )
            }
            colorWanderCompletedBatches += 1
          }
          if (colorWanderActiveBatch !== frame.batchIndex) {
            colorWanderActiveBatch = frame.batchIndex
            colorWanderVisibleLength = 0
          }
          const batchMask = colorWanderBatchMasks[frame.batchIndex]
          const path = colorWanderPaths[frame.batchIndex]
          if (batchMask && path) {
            const visibleLength = path.totalLength * frame.sweepProgress
            appendColorWanderIntroductionBatch(
              revealedContext,
              sweepContext,
              colorWanderSweepMask,
              batchMask,
              path,
              colorWanderVisibleLength,
              visibleLength,
              colorWanderRevealedMask.width,
              colorWanderRevealedMask.height
            )
            colorWanderVisibleLength = visibleLength
          }
        } else {
          const batchMask = colorWanderBatchMasks[frame.batchIndex]
          if (batchMask && frame.direction) {
            renderColorWanderFamily(
              revealedContext,
              sweepContext,
              colorWanderSweepMask,
              batchMask,
              frame.direction,
              frame.sweepProgress,
              colorWanderRevealedMask.width,
              colorWanderRevealedMask.height
            )
          } else {
            revealedContext.clearRect(
              0,
              0,
              colorWanderRevealedMask.width,
              colorWanderRevealedMask.height
            )
          }
        }
        drawColorWander(context, image, colorWanderRevealedMask, width, height)
        if (frame.phase !== 'idle') {
          animationFrame = window.requestAnimationFrame(draw)
        }
      } else {
        const elapsedMs = reducedMotion
          ? PIXEL_RECOMPOSE_SWEEP_DURATION_MS
          : timestamp - startedAt
        const frame = reducedMotion
          ? { previousStep: 0, targetStep: 1, progress: 1 }
          : resolvePixelRecomposeFrame(elapsedMs)
        drawPixelRecompose(
          context,
          resolvePixelSurface(0, frame.previousStep),
          resolvePixelSurface(1, frame.targetStep),
          pixelSamples[frame.targetStep - 1],
          width,
          height,
          frame
        )
        if (!reducedMotion) animationFrame = window.requestAnimationFrame(draw)
      }
      context.globalAlpha = 1
      context.globalCompositeOperation = 'source-over'
      context.shadowBlur = 0
    }

    image.onload = () => {
      if (scheme === 'aperture-fold') {
        try {
          colorWanderDirectionSeed = createColorWanderDirectionSeed(
            sampleImage(
              image,
              image.naturalWidth,
              image.naturalHeight,
              COLOR_WANDER_SAMPLE_LONG_EDGE
            )
          )
        } catch {
          colorWanderDirectionSeed = 0
        }
      }
      prepare()
      startedAt = performance.now()
      draw(startedAt)
    }
    image.src = sourceImageUrl

    const resizeObserver = new ResizeObserver(() => {
      if (!image.complete || !image.naturalWidth) return
      window.cancelAnimationFrame(animationFrame)
      prepare()
      draw(performance.now())
    })
    resizeObserver.observe(canvas)

    return () => {
      disposed = true
      image.onload = null
      resizeObserver.disconnect()
      window.cancelAnimationFrame(animationFrame)
    }
  }, [active, scheme, sourceImageUrl])

  return <canvas ref={canvasRef} className="generation-effect-canvas" aria-hidden="true" />
}
