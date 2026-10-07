export const CONTOUR_TRACE_DURATION_MS = 30_000
export const CONTOUR_TRACE_MAX_SAMPLE_LONG_EDGE = 768

export interface ContourSample {
  data: Uint8ClampedArray
  width: number
  height: number
}

export interface ContourPoint {
  x: number
  y: number
}

export interface ContourPath {
  points: ContourPoint[]
  length: number
  color: string
}

export interface ContourTrace {
  paths: ContourPath[]
  totalLength: number
  lineWidth: number
  opacity: number
}

export interface ContourTraceFrame {
  progress: number
  complete: boolean
}

interface ContourSpec {
  highPercentile: number
  minimumHighThreshold: number
  minimumPathLength: number
  maximumVertices: number
  lineWidth: number
  opacity: number
}

interface RawContourPath {
  indices: number[]
  length: number
  strength: number
}

const BACKGROUND_RED = 17
const BACKGROUND_GREEN = 22
const BACKGROUND_BLUE = 18
const CONTOUR_SPEC: ContourSpec = {
  highPercentile: 0.48,
  minimumHighThreshold: 20,
  minimumPathLength: 2,
  maximumVertices: 64_000,
  lineWidth: 0.8,
  opacity: 0.84
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function contourColor(sample: ContourSample, index: number): string {
  const offset = index * 4
  const alpha = (sample.data[offset + 3] ?? 0) / 255
  const red = (sample.data[offset] ?? 0) * alpha + BACKGROUND_RED * (1 - alpha)
  const green = (sample.data[offset + 1] ?? 0) * alpha + BACKGROUND_GREEN * (1 - alpha)
  const blue = (sample.data[offset + 2] ?? 0) * alpha + BACKGROUND_BLUE * (1 - alpha)
  const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722
  const lift = luminance < 118
    ? Math.min(0.42, (118 - luminance) / Math.max(1, 255 - luminance))
    : 0
  const visible = (channel: number): number => Math.round(channel + (255 - channel) * lift)

  return `${visible(red)} ${visible(green)} ${visible(blue)}`
}

function sobelGradientX(values: Float32Array, index: number, width: number): number {
  return -(values[index - width - 1] ?? 0) + (values[index - width + 1] ?? 0) -
    2 * (values[index - 1] ?? 0) + 2 * (values[index + 1] ?? 0) -
    (values[index + width - 1] ?? 0) + (values[index + width + 1] ?? 0)
}

function sobelGradientY(values: Float32Array, index: number, width: number): number {
  return -(values[index - width - 1] ?? 0) - 2 * (values[index - width] ?? 0) -
    (values[index - width + 1] ?? 0) + (values[index + width - 1] ?? 0) +
    2 * (values[index + width] ?? 0) + (values[index + width + 1] ?? 0)
}

function percentile(values: number[], ratio: number): number {
  values.sort((left, right) => left - right)
  return values[Math.min(values.length - 1, Math.floor(values.length * ratio))] ?? 0
}

function createThinnedEdgeMap(
  sample: ContourSample,
  spec: ContourSpec
): { edges: Uint8Array; magnitudes: Float32Array } {
  const pixelCount = sample.width * sample.height
  const red = new Float32Array(pixelCount)
  const green = new Float32Array(pixelCount)
  const blue = new Float32Array(pixelCount)
  const magnitude = new Float32Array(pixelCount)
  const gradientX = new Float32Array(pixelCount)
  const gradientY = new Float32Array(pixelCount)

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4
    const alpha = (sample.data[offset + 3] ?? 0) / 255
    red[index] = (sample.data[offset] ?? 0) * alpha + BACKGROUND_RED * (1 - alpha)
    green[index] = (sample.data[offset + 1] ?? 0) * alpha + BACKGROUND_GREEN * (1 - alpha)
    blue[index] = (sample.data[offset + 2] ?? 0) * alpha + BACKGROUND_BLUE * (1 - alpha)
  }

  for (let y = 1; y < sample.height - 1; y += 1) {
    for (let x = 1; x < sample.width - 1; x += 1) {
      const index = y * sample.width + x
      const redX = sobelGradientX(red, index, sample.width)
      const redY = sobelGradientY(red, index, sample.width)
      const greenX = sobelGradientX(green, index, sample.width)
      const greenY = sobelGradientY(green, index, sample.width)
      const blueX = sobelGradientX(blue, index, sample.width)
      const blueY = sobelGradientY(blue, index, sample.width)
      const tensorXX = (redX * redX + greenX * greenX + blueX * blueX) / 3
      const tensorYY = (redY * redY + greenY * greenY + blueY * blueY) / 3
      const tensorXY = (redX * redY + greenX * greenY + blueX * blueY) / 3
      const direction = Math.atan2(2 * tensorXY, tensorXX - tensorYY) / 2
      gradientX[index] = Math.cos(direction)
      gradientY[index] = Math.sin(direction)
      magnitude[index] = Math.sqrt(tensorXX + tensorYY)
    }
  }

  // Thin Sobel plateaus before hysteresis so hard edges form single connected paths.
  const thinned = new Float32Array(pixelCount)
  const candidates: number[] = []
  for (let y = 1; y < sample.height - 1; y += 1) {
    for (let x = 1; x < sample.width - 1; x += 1) {
      const index = y * sample.width + x
      const current = magnitude[index] ?? 0
      if (current === 0) continue

      let angle = Math.atan2(gradientY[index] ?? 0, gradientX[index] ?? 0) * 180 / Math.PI
      if (angle < 0) angle += 180

      let before: number
      let after: number
      if (angle < 22.5 || angle >= 157.5) {
        before = magnitude[index - 1] ?? 0
        after = magnitude[index + 1] ?? 0
      } else if (angle < 67.5) {
        before = magnitude[index - sample.width - 1] ?? 0
        after = magnitude[index + sample.width + 1] ?? 0
      } else if (angle < 112.5) {
        before = magnitude[index - sample.width] ?? 0
        after = magnitude[index + sample.width] ?? 0
      } else {
        before = magnitude[index - sample.width + 1] ?? 0
        after = magnitude[index + sample.width - 1] ?? 0
      }

      if (current >= before && current > after) {
        thinned[index] = current
        candidates.push(current)
      }
    }
  }

  const edges = new Uint8Array(pixelCount)
  if (candidates.length === 0) return { edges, magnitudes: thinned }

  const highThreshold = Math.max(
    spec.minimumHighThreshold,
    percentile(candidates, spec.highPercentile)
  )
  const lowThreshold = highThreshold * 0.42
  const queue: number[] = []
  for (let index = 0; index < thinned.length; index += 1) {
    if ((thinned[index] ?? 0) >= highThreshold) {
      edges[index] = 1
      queue.push(index)
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]!
    const x = index % sample.width
    const y = Math.floor(index / sample.width)
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) continue
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX <= 0 || nextX >= sample.width - 1 ||
          nextY <= 0 || nextY >= sample.height - 1) continue
        const nextIndex = nextY * sample.width + nextX
        if (edges[nextIndex] || (thinned[nextIndex] ?? 0) < lowThreshold) continue
        edges[nextIndex] = 1
        queue.push(nextIndex)
      }
    }
  }

  return { edges, magnitudes: thinned }
}

function connectedNeighbors(edges: Uint8Array, width: number, height: number, index: number): number[] {
  const x = index % width
  const y = Math.floor(index / width)
  const neighbors: number[] = []
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) continue
      const nextX = x + offsetX
      const nextY = y + offsetY
      if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue
      const nextIndex = nextY * width + nextX
      if (!edges[nextIndex]) continue

      if (offsetX !== 0 && offsetY !== 0) {
        const horizontal = y * width + nextX
        const vertical = nextY * width + x
        if (edges[horizontal] || edges[vertical]) continue
      }
      neighbors.push(nextIndex)
    }
  }
  return neighbors
}

function edgeKey(left: number, right: number, pixelCount: number): number {
  return Math.min(left, right) * pixelCount + Math.max(left, right)
}

function rawPathLength(indices: number[], width: number): number {
  let length = 0
  for (let index = 1; index < indices.length; index += 1) {
    const previous = indices[index - 1]!
    const current = indices[index]!
    length += Math.hypot(current % width - previous % width,
      Math.floor(current / width) - Math.floor(previous / width))
  }
  return length
}

function traceRawContours(
  edges: Uint8Array,
  magnitudes: Float32Array,
  width: number,
  height: number
): RawContourPath[] {
  const pixelCount = width * height
  const neighborCache = new Map<number, number[]>()
  const neighborsOf = (index: number): number[] => {
    const cached = neighborCache.get(index)
    if (cached) return cached
    const neighbors = connectedNeighbors(edges, width, height, index)
    neighborCache.set(index, neighbors)
    return neighbors
  }
  const usedEdges = new Set<number>()
  const paths: RawContourPath[] = []

  const walk = (start: number, first: number): void => {
    const indices = [start]
    let previous = start
    let current = first
    usedEdges.add(edgeKey(start, first, pixelCount))

    while (true) {
      indices.push(current)
      const neighbors = neighborsOf(current)
      if (neighbors.length !== 2) break
      const next = neighbors.find((candidate) =>
        candidate !== previous && !usedEdges.has(edgeKey(current, candidate, pixelCount)))
      if (next === undefined) break
      usedEdges.add(edgeKey(current, next, pixelCount))
      previous = current
      current = next
    }

    if (indices.length < 2) return
    const strength = indices.reduce((sum, index) => sum + (magnitudes[index] ?? 0), 0) /
      indices.length
    paths.push({
      indices,
      length: rawPathLength(indices, width),
      strength
    })
  }

  // Consume branch-to-branch segments first, then trace any remaining closed loops.
  for (let index = 0; index < edges.length; index += 1) {
    if (!edges[index]) continue
    const neighbors = neighborsOf(index)
    if (neighbors.length === 2) continue
    for (const neighbor of neighbors) {
      if (!usedEdges.has(edgeKey(index, neighbor, pixelCount))) walk(index, neighbor)
    }
  }

  for (let index = 0; index < edges.length; index += 1) {
    if (!edges[index]) continue
    for (const neighbor of neighborsOf(index)) {
      if (!usedEdges.has(edgeKey(index, neighbor, pixelCount))) walk(index, neighbor)
    }
  }

  return paths
}

function pathLength(points: ContourPoint[]): number {
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!
    const current = points[index]!
    length += Math.hypot(current.x - previous.x, current.y - previous.y)
  }
  return length
}

function createContourCandidates(
  sample: ContourSample
): RawContourPath[] {
  const { edges, magnitudes } = createThinnedEdgeMap(sample, CONTOUR_SPEC)
  return traceRawContours(edges, magnitudes, sample.width, sample.height)
    .filter((path) => path.length >= CONTOUR_SPEC.minimumPathLength)
    .sort((left, right) =>
      right.length * (1 + right.strength / 1_442) -
      left.length * (1 + left.strength / 1_442))
}

export function createContourTrace(
  sample: ContourSample,
  targetWidth: number,
  targetHeight: number
): ContourTrace {
  const paths: ContourPath[] = []
  let vertexCount = 0

  for (const candidate of createContourCandidates(sample)) {
    const availableVertices = CONTOUR_SPEC.maximumVertices - vertexCount
    if (availableVertices < 2) break
    const indices = candidate.indices.length > availableVertices
      ? candidate.indices.slice(0, availableVertices)
      : candidate.indices
    const points = indices.map((index) => ({
      x: ((index % sample.width) + 0.5) / sample.width * targetWidth,
      y: (Math.floor(index / sample.width) + 0.5) / sample.height * targetHeight
    }))
    paths.push({
      points,
      length: pathLength(points),
      color: contourColor(sample, indices[Math.floor(indices.length / 2)]!)
    })
    vertexCount += points.length
  }

  return {
    paths,
    totalLength: paths.reduce((sum, path) => sum + path.length, 0),
    lineWidth: CONTOUR_SPEC.lineWidth,
    opacity: CONTOUR_SPEC.opacity
  }
}

export function resolveContourTraceFrame(elapsedMs: number): ContourTraceFrame {
  const progress = clamp(elapsedMs / CONTOUR_TRACE_DURATION_MS, 0, 1)
  return {
    progress,
    complete: progress >= 1
  }
}
