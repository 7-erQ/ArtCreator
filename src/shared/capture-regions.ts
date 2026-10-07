import type { CaptureSelection, RectDip } from './contracts'
import type { PointDip } from './geometry'

export interface ResolvedCaptureRegions {
  contextRectDip: RectDip
  outputRectDip: RectDip
  referenceRectsDip: RectDip[]
}

export function resolveCaptureRegions(selection: CaptureSelection): ResolvedCaptureRegions {
  const outputRectDip = selection.outputRectDip ?? selection.contextRectDip
  return {
    contextRectDip: selection.contextRectDip,
    outputRectDip,
    referenceRectsDip: selection.referenceRectsDip?.length
      ? selection.referenceRectsDip
      : [outputRectDip]
  }
}

export function clampDoodleStrokesToRect(strokes: PointDip[][], bounds: RectDip): PointDip[][] {
  return strokes.map((stroke) => stroke.map((point) => ({
    x: Math.min(Math.max(point.x, bounds.x), bounds.x + bounds.width),
    y: Math.min(Math.max(point.y, bounds.y), bounds.y + bounds.height)
  })))
}

export function translateDoodleStrokes(
  strokes: PointDip[][],
  delta: PointDip
): PointDip[][] {
  return strokes.map((stroke) => stroke.map((point) => ({
    x: point.x + delta.x,
    y: point.y + delta.y
  })))
}

export function translateRect(rect: RectDip, delta: PointDip): RectDip {
  return {
    ...rect,
    x: rect.x + delta.x,
    y: rect.y + delta.y
  }
}
