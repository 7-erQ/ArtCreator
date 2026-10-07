export const PIXEL_RECOMPOSE_SWEEP_DURATION_MS = 2_000
export const PIXEL_RECOMPOSE_MAX_STEP = 10
export const PIXEL_RECOMPOSE_FLOAT_AMPLITUDE_RATIO = 0.045
export const PIXEL_RECOMPOSE_FLOAT_MAX_AMPLITUDE = 28
const PIXEL_RECOMPOSE_CYCLE_LENGTH = (PIXEL_RECOMPOSE_MAX_STEP - 1) * 2
const PIXEL_RECOMPOSE_INITIAL_BLOCK_RATIO = 0.005
const PIXEL_RECOMPOSE_FINE_STEP_COUNT = 5
const PIXEL_RECOMPOSE_FINE_BLOCK_RATIO_PER_STEP = 0.004
const PIXEL_RECOMPOSE_COARSE_BLOCK_RATIO_PER_STEP = 0.002
const PIXEL_RECOMPOSE_RIPPLE_AMPLITUDE_RATIO = 1.65
const PIXEL_RECOMPOSE_RIPPLE_MIN_CELLS = 3
const PIXEL_RECOMPOSE_RIPPLE_PATTERN_SIZE = 7
const PIXEL_RECOMPOSE_RIPPLE_ACTIVE_SLOTS = 2

export interface PixelRecomposeFrame {
  previousStep: number
  targetStep: number
  progress: number
}

export interface PixelDotStyle {
  gap: number
  diameter: number
  shaded: boolean
}

export interface PixelFloatTransform {
  lift: number
  scale: number
  strength: number
}

export interface PixelRipplePosition {
  innerRadius: number
  crestRadius: number
  outerRadius: number
  targetRadius: number
  bandWidth: number
  maxRadius: number
}

function levelAfterCompletedSweeps(completedSweeps: number): number {
  if (completedSweeps === 0) return 0
  const position = (completedSweeps - 1) % PIXEL_RECOMPOSE_CYCLE_LENGTH
  return position < PIXEL_RECOMPOSE_MAX_STEP
    ? position + 1
    : PIXEL_RECOMPOSE_MAX_STEP * 2 - 1 - position
}

export function resolvePixelRecomposeFrame(elapsedMs: number): PixelRecomposeFrame {
  const normalizedElapsed = Math.max(0, elapsedMs)
  const completedSweeps = Math.floor(normalizedElapsed / PIXEL_RECOMPOSE_SWEEP_DURATION_MS)
  const progress = normalizedElapsed % PIXEL_RECOMPOSE_SWEEP_DURATION_MS /
    PIXEL_RECOMPOSE_SWEEP_DURATION_MS

  return {
    previousStep: levelAfterCompletedSweeps(completedSweeps),
    targetStep: levelAfterCompletedSweeps(completedSweeps + 1),
    progress
  }
}

export function resolvePixelBlockSize(shortEdge: number, step: number): number {
  const additionalSteps = Math.max(0, step - 1)
  const fineSteps = Math.min(additionalSteps, PIXEL_RECOMPOSE_FINE_STEP_COUNT - 1)
  const coarseSteps = Math.max(0, additionalSteps - fineSteps)
  const ratio = PIXEL_RECOMPOSE_INITIAL_BLOCK_RATIO +
    fineSteps * PIXEL_RECOMPOSE_FINE_BLOCK_RATIO_PER_STEP +
    coarseSteps * PIXEL_RECOMPOSE_COARSE_BLOCK_RATIO_PER_STEP
  return Math.max(1, Math.round(shortEdge * ratio))
}

export function resolvePixelDotStyle(cellWidth: number, cellHeight: number): PixelDotStyle {
  const shortEdge = Math.max(0, Math.min(cellWidth, cellHeight))
  if (shortEdge < 4) {
    return { gap: 0, diameter: shortEdge, shaded: false }
  }

  const gap = Math.min(6, Math.max(0.8, shortEdge * 0.1))
  return {
    gap,
    diameter: Math.max(0, shortEdge - gap),
    shaded: true
  }
}

export function resolvePixelFloatAmplitude(width: number, height: number): number {
  const shortEdge = Math.max(0, Math.min(width, height))
  return Math.min(
    PIXEL_RECOMPOSE_FLOAT_MAX_AMPLITUDE,
    shortEdge * PIXEL_RECOMPOSE_FLOAT_AMPLITUDE_RATIO
  )
}

export function resolvePixelRipplePosition(
  width: number,
  height: number,
  progress: number,
  cellSize: number
): PixelRipplePosition {
  const amplitude = resolvePixelFloatAmplitude(width, height)
  const normalizedProgress = Math.max(0, Math.min(1, progress))
  const safeWidth = Math.max(0, width)
  const safeHeight = Math.max(0, height)
  const maxRadius = Math.hypot(safeWidth / 2, safeHeight / 2)
  const bandWidth = Math.min(
    maxRadius,
    Math.max(
      Math.max(0, cellSize) * PIXEL_RECOMPOSE_RIPPLE_MIN_CELLS,
      amplitude * PIXEL_RECOMPOSE_RIPPLE_AMPLITUDE_RATIO
    )
  )
  const innerRadius = -bandWidth + normalizedProgress * (maxRadius + bandWidth)

  return {
    innerRadius,
    crestRadius: innerRadius + bandWidth / 2,
    outerRadius: innerRadius + bandWidth,
    targetRadius: Math.max(0, Math.min(maxRadius, innerRadius)),
    bandWidth,
    maxRadius
  }
}

export function resolvePixelRippleTransform(
  width: number,
  height: number,
  bandRatio: number
): PixelFloatTransform {
  if (bandRatio <= 0 || bandRatio >= 1) {
    return { lift: 0, scale: 1, strength: 0 }
  }

  const strength = Math.sin(Math.PI * bandRatio) ** 1.35

  return {
    lift: resolvePixelFloatAmplitude(width, height) * strength,
    scale: 1 + strength * 0.06,
    strength
  }
}

export function participatesInPixelRipple(row: number, column: number): boolean {
  const slot = (row * 3 + column * 5) % PIXEL_RECOMPOSE_RIPPLE_PATTERN_SIZE
  return slot < PIXEL_RECOMPOSE_RIPPLE_ACTIVE_SLOTS
}
