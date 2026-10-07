export const COLOR_WANDER_INTRO_DURATION_MS = 8_000
export const COLOR_WANDER_SWEEP_DURATION_MS = 1_500
export const COLOR_WANDER_HOLD_DURATION_MS = 2_000
export const COLOR_WANDER_CYCLE_DURATION_MS =
  COLOR_WANDER_SWEEP_DURATION_MS + COLOR_WANDER_HOLD_DURATION_MS
export const COLOR_WANDER_COLOR_FAMILIES = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple'
] as const
export const COLOR_WANDER_UNCLASSIFIED = 255
export const COLOR_WANDER_DIRECTIONS = [
  'left-to-right',
  'right-to-left',
  'top-to-bottom',
  'bottom-to-top'
] as const
export const COLOR_WANDER_TONES = ['dark', 'midtone', 'light'] as const

export type ColorWanderFamily = typeof COLOR_WANDER_COLOR_FAMILIES[number]
export type ColorWanderDirection = typeof COLOR_WANDER_DIRECTIONS[number]
export type ColorWanderTone = typeof COLOR_WANDER_TONES[number]
export type ColorWanderPhase = 'intro-sweeping' | 'sweeping' | 'holding' | 'idle'

export interface ColorWanderSample {
  data: Uint8ClampedArray
  width: number
  height: number
}

export interface ColorWanderFamilyPlan {
  familyByPixel: Uint8Array
  orderedFamilies: ColorWanderFamily[]
  pixelCounts: number[]
  batchByPixel: Uint8Array
  orderedBatches: ColorWanderBatch[]
}

export interface ColorWanderBatch {
  family: ColorWanderFamily
  tone: ColorWanderTone
  pixelCount: number
}

export interface ColorWanderPoint {
  x: number
  y: number
  column: number
  row: number
}

export interface ColorWanderPath {
  points: ColorWanderPoint[]
  cumulativeLengths: number[]
  totalLength: number
  columns: number
  rows: number
  brushDiameter: number
}

export interface ColorWanderFrame {
  cycleIndex: number
  batchIndex: number
  phase: ColorWanderPhase
  sweepProgress: number
  completedBatchCount: number
  direction?: ColorWanderDirection
}

const TARGET_CELLS_ON_SHORT_EDGE = 14
const MIN_CELL_SIZE = 12
const MAX_CELL_SIZE = 32
const MIN_TONE_SHARE = 0.08
const MIN_TONE_PIXELS = 16

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function createRandom(seed: number): () => number {
  let state = seed || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4_294_967_296
  }
}

function pathSeed(
  width: number,
  height: number,
  columns: number,
  rows: number,
  seedOffset: number
): number {
  return (
    Math.imul(Math.round(width), 73_856_093) ^
    Math.imul(Math.round(height), 19_349_663) ^
    Math.imul(columns, 83_492_791) ^
    Math.imul(rows, 2_654_435_761) ^
    Math.imul(seedOffset + 1, 1_597_334_677)
  ) >>> 0
}

function neighbors(index: number, columns: number, rows: number): number[] {
  const column = index % columns
  const row = Math.floor(index / columns)
  const result: number[] = []
  if (column > 0) result.push(index - 1)
  if (column + 1 < columns) result.push(index + 1)
  if (row > 0) result.push(index - columns)
  if (row + 1 < rows) result.push(index + columns)
  return result
}

export function createColorWanderPath(
  width: number,
  height: number,
  seedOffset = 0
): ColorWanderPath {
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  const shortEdge = Math.min(safeWidth, safeHeight)
  const targetCellSize = clamp(
    shortEdge / TARGET_CELLS_ON_SHORT_EDGE,
    MIN_CELL_SIZE,
    MAX_CELL_SIZE
  )
  const columns = Math.max(1, Math.ceil(safeWidth / targetCellSize))
  const rows = Math.max(1, Math.ceil(safeHeight / targetCellSize))
  const cellWidth = safeWidth / columns
  const cellHeight = safeHeight / rows
  const random = createRandom(pathSeed(safeWidth, safeHeight, columns, rows, seedOffset))
  const cellCount = columns * rows
  const visited = new Uint8Array(cellCount)
  const start = Math.min(cellCount - 1, Math.floor(random() * cellCount))
  const stack = [start]
  const indices = [start]
  visited[start] = 1
  let visitedCount = 1

  while (visitedCount < cellCount) {
    const current = stack[stack.length - 1]!
    const candidates = neighbors(current, columns, rows).filter((index) => !visited[index])
    if (candidates.length > 0) {
      const next = candidates[Math.floor(random() * candidates.length)]!
      visited[next] = 1
      visitedCount += 1
      stack.push(next)
      indices.push(next)
      continue
    }

    stack.pop()
    const parent = stack[stack.length - 1]
    if (parent !== undefined) indices.push(parent)
  }

  const points = indices.map((index): ColorWanderPoint => {
    const column = index % columns
    const row = Math.floor(index / columns)
    return {
      x: (column + 0.5) * cellWidth,
      y: (row + 0.5) * cellHeight,
      column,
      row
    }
  })
  const cumulativeLengths = [0]
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!
    const current = points[index]!
    cumulativeLengths.push(
      cumulativeLengths[index - 1]! + Math.hypot(current.x - previous.x, current.y - previous.y)
    )
  }

  return {
    points,
    cumulativeLengths,
    totalLength: cumulativeLengths[cumulativeLengths.length - 1] ?? 0,
    columns,
    rows,
    brushDiameter: Math.hypot(cellWidth, cellHeight) * 1.08
  }
}

export function createColorWanderDirectionSeed(sample: ColorWanderSample): number {
  let seed = (
    Math.imul(sample.width, 73_856_093) ^
    Math.imul(sample.height, 19_349_663)
  ) >>> 0
  const stride = Math.max(4, Math.floor(sample.data.length / 128 / 4) * 4)

  for (let offset = 0; offset < sample.data.length; offset += stride) {
    seed = Math.imul(seed ^ (sample.data[offset] ?? 0), 16_777_619)
    seed = Math.imul(seed ^ (sample.data[offset + 1] ?? 0), 16_777_619)
    seed = Math.imul(seed ^ (sample.data[offset + 2] ?? 0), 16_777_619)
    seed = Math.imul(seed ^ (sample.data[offset + 3] ?? 0), 16_777_619)
  }

  return seed >>> 0
}

function hueOf(red: number, green: number, blue: number, delta: number, maximum: number): number {
  let sector: number
  if (maximum === red) {
    sector = (green - blue) / delta % 6
  } else if (maximum === green) {
    sector = (blue - red) / delta + 2
  } else {
    sector = (red - green) / delta + 4
  }
  const hue = sector * 60
  return hue < 0 ? hue + 360 : hue
}

function lightnessOf(red: number, green: number, blue: number): number {
  return Math.round((Math.max(red, green, blue) + Math.min(red, green, blue)) / 2)
}

function resolveHistogramQuantile(histogram: Uint32Array, target: number): number {
  let total = 0
  for (let value = 0; value < histogram.length; value += 1) {
    total += histogram[value] ?? 0
    if (total >= target) return value
  }
  return histogram.length - 1
}

function resolveToneByLightness(histogram: Uint32Array, pixelCount: number): Uint8Array {
  const toneByLightness = new Uint8Array(256)
  let minimum = histogram.length - 1
  let maximum = 0
  for (let lightness = 0; lightness < histogram.length; lightness += 1) {
    if ((histogram[lightness] ?? 0) === 0) continue
    minimum = Math.min(minimum, lightness)
    maximum = Math.max(maximum, lightness)
  }
  if (minimum === maximum) {
    toneByLightness.fill(1)
    return toneByLightness
  }

  const firstBoundary = resolveHistogramQuantile(histogram, Math.ceil(pixelCount / 3))
  const secondBoundary = resolveHistogramQuantile(histogram, Math.ceil(pixelCount * 2 / 3))
  const rawCounts = [0, 0, 0]
  for (let lightness = minimum; lightness <= maximum; lightness += 1) {
    const tone = lightness <= firstBoundary ? 0 : lightness <= secondBoundary ? 1 : 2
    toneByLightness[lightness] = tone
    rawCounts[tone] = (rawCounts[tone] ?? 0) + (histogram[lightness] ?? 0)
  }

  const minimumTonePixels = Math.max(MIN_TONE_PIXELS, Math.ceil(pixelCount * MIN_TONE_SHARE))
  const activeTones = rawCounts
    .map((count, tone) => ({ count, tone }))
    .filter(({ count }) => count >= minimumTonePixels)
    .map(({ tone }) => tone)
  if (activeTones.length === 0) {
    activeTones.push(rawCounts.indexOf(Math.max(...rawCounts)))
  }

  for (let lightness = minimum; lightness <= maximum; lightness += 1) {
    const rawTone = toneByLightness[lightness] ?? 0
    toneByLightness[lightness] = activeTones.reduce((closest, tone) =>
      Math.abs(tone - rawTone) < Math.abs(closest - rawTone) ? tone : closest)
  }
  return toneByLightness
}

export function classifyColorWanderFamily(
  red: number,
  green: number,
  blue: number,
  alpha = 255
): ColorWanderFamily | undefined {
  if (alpha < 16) return undefined
  const maximum = Math.max(red, green, blue)
  const minimum = Math.min(red, green, blue)
  const delta = maximum - minimum
  if (delta < 12 || maximum > 0 && delta / maximum < 0.08) return undefined

  const hue = hueOf(red, green, blue, delta, maximum)
  if (hue < 20 || hue >= 340) return 'red'
  if (hue < 50) return 'orange'
  if (hue < 85) return 'yellow'
  if (hue < 165) return 'green'
  if (hue < 260) return 'blue'
  return 'purple'
}

export function createColorWanderFamilyPlan(
  sample: ColorWanderSample
): ColorWanderFamilyPlan {
  const pixelCount = sample.width * sample.height
  const familyByPixel = new Uint8Array(pixelCount)
  familyByPixel.fill(COLOR_WANDER_UNCLASSIFIED)
  const pixelCounts = COLOR_WANDER_COLOR_FAMILIES.map(() => 0)
  const lightnessByPixel = new Uint8Array(pixelCount)
  const lightnessHistograms = COLOR_WANDER_COLOR_FAMILIES.map(() => new Uint32Array(256))

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4
    const family = classifyColorWanderFamily(
      sample.data[offset] ?? 0,
      sample.data[offset + 1] ?? 0,
      sample.data[offset + 2] ?? 0,
      sample.data[offset + 3] ?? 0
    )
    if (!family) continue
    const familyIndex = COLOR_WANDER_COLOR_FAMILIES.indexOf(family)
    familyByPixel[index] = familyIndex
    pixelCounts[familyIndex] = (pixelCounts[familyIndex] ?? 0) + 1
    const lightness = lightnessOf(
      sample.data[offset] ?? 0,
      sample.data[offset + 1] ?? 0,
      sample.data[offset + 2] ?? 0
    )
    lightnessByPixel[index] = lightness
    const histogram = lightnessHistograms[familyIndex]!
    histogram[lightness] = (histogram[lightness] ?? 0) + 1
  }

  const orderedFamilies = COLOR_WANDER_COLOR_FAMILIES
    .filter((_, index) => (pixelCounts[index] ?? 0) > 0)
    .sort((left, right) => {
      const leftIndex = COLOR_WANDER_COLOR_FAMILIES.indexOf(left)
      const rightIndex = COLOR_WANDER_COLOR_FAMILIES.indexOf(right)
      return (pixelCounts[rightIndex] ?? 0) - (pixelCounts[leftIndex] ?? 0) ||
        leftIndex - rightIndex
    })

  const toneByFamilyLightness = lightnessHistograms.map((histogram, familyIndex) =>
    resolveToneByLightness(histogram, pixelCounts[familyIndex] ?? 0))
  const batchKeysByPixel = new Uint8Array(pixelCount)
  batchKeysByPixel.fill(COLOR_WANDER_UNCLASSIFIED)
  const batchCounts = new Uint32Array(
    COLOR_WANDER_COLOR_FAMILIES.length * COLOR_WANDER_TONES.length
  )

  for (let index = 0; index < pixelCount; index += 1) {
    const familyIndex = familyByPixel[index] ?? COLOR_WANDER_UNCLASSIFIED
    if (familyIndex === COLOR_WANDER_UNCLASSIFIED) continue
    const lightness = lightnessByPixel[index] ?? 0
    const toneIndex = toneByFamilyLightness[familyIndex]![lightness] ?? 0
    const batchKey = familyIndex * COLOR_WANDER_TONES.length + toneIndex
    batchKeysByPixel[index] = batchKey
    batchCounts[batchKey] = (batchCounts[batchKey] ?? 0) + 1
  }

  const batches = Array.from(batchCounts, (count, batchKey) => {
    if (count === 0) return undefined
    const familyIndex = Math.floor(batchKey / COLOR_WANDER_TONES.length)
    const toneIndex = batchKey % COLOR_WANDER_TONES.length
    return {
      batchKey,
      familyIndex,
      toneIndex,
      family: COLOR_WANDER_COLOR_FAMILIES[familyIndex]!,
      tone: COLOR_WANDER_TONES[toneIndex]!,
      pixelCount: count
    }
  }).filter((batch): batch is {
    batchKey: number
    familyIndex: number
    toneIndex: number
    family: ColorWanderFamily
    tone: ColorWanderTone
    pixelCount: number
  } => batch !== undefined).sort((left, right) =>
    (pixelCounts[right.familyIndex] ?? 0) - (pixelCounts[left.familyIndex] ?? 0) ||
    right.pixelCount - left.pixelCount ||
    left.familyIndex - right.familyIndex ||
    left.toneIndex - right.toneIndex
  )
  const batchIndexByKey = new Uint8Array(batchCounts.length)
  batchIndexByKey.fill(COLOR_WANDER_UNCLASSIFIED)
  const orderedBatches = batches.map((batch, batchIndex) => {
    batchIndexByKey[batch.batchKey] = batchIndex
    return {
      family: batch.family,
      tone: batch.tone,
      pixelCount: batch.pixelCount
    }
  })
  const batchByPixel = new Uint8Array(pixelCount)
  batchByPixel.fill(COLOR_WANDER_UNCLASSIFIED)
  for (let index = 0; index < pixelCount; index += 1) {
    const batchKey = batchKeysByPixel[index] ?? COLOR_WANDER_UNCLASSIFIED
    if (batchKey === COLOR_WANDER_UNCLASSIFIED) continue
    batchByPixel[index] = batchIndexByKey[batchKey] ?? COLOR_WANDER_UNCLASSIFIED
  }

  return { familyByPixel, orderedFamilies, pixelCounts, batchByPixel, orderedBatches }
}

function resolveDirectionIndex(cycleIndex: number, directionSeed: number): number {
  let value = (directionSeed + Math.imul(cycleIndex + 1, 2_654_435_761)) >>> 0
  value = Math.imul(value ^ value >>> 16, 2_246_822_519)
  value = Math.imul(value ^ value >>> 13, 3_266_489_917)
  return (value ^ value >>> 16) >>> 0
}

export function resolveColorWanderFrame(
  elapsedMs: number,
  batchCount: number,
  directionSeed = 0
): ColorWanderFrame {
  const safeBatchCount = Math.max(0, Math.floor(batchCount))
  if (safeBatchCount === 0) {
    return {
      cycleIndex: 0,
      batchIndex: -1,
      phase: 'idle',
      sweepProgress: 0,
      completedBatchCount: 0
    }
  }

  const safeElapsedMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  if (safeElapsedMs < COLOR_WANDER_INTRO_DURATION_MS) {
    const batchPosition = safeElapsedMs / COLOR_WANDER_INTRO_DURATION_MS * safeBatchCount
    const batchIndex = Math.min(safeBatchCount - 1, Math.floor(batchPosition))
    return {
      cycleIndex: 0,
      batchIndex,
      phase: 'intro-sweeping',
      sweepProgress: batchPosition - batchIndex,
      completedBatchCount: batchIndex
    }
  }

  const loopElapsedMs = safeElapsedMs - COLOR_WANDER_INTRO_DURATION_MS
  const cycleIndex = Math.floor(loopElapsedMs / COLOR_WANDER_CYCLE_DURATION_MS)
  const cycleElapsedMs = loopElapsedMs - cycleIndex * COLOR_WANDER_CYCLE_DURATION_MS
  const phase: ColorWanderPhase = cycleElapsedMs < COLOR_WANDER_SWEEP_DURATION_MS
    ? 'sweeping'
    : 'holding'

  return {
    cycleIndex,
    batchIndex: cycleIndex % safeBatchCount,
    phase,
    sweepProgress: phase === 'sweeping'
      ? cycleElapsedMs / COLOR_WANDER_SWEEP_DURATION_MS
      : 1,
    completedBatchCount: 0,
    direction: COLOR_WANDER_DIRECTIONS[
      resolveDirectionIndex(cycleIndex, directionSeed) % COLOR_WANDER_DIRECTIONS.length
    ]!
  }
}
