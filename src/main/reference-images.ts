import { nativeImage } from 'electron'
import { MAX_REFERENCE_IMAGE_COUNT } from '../shared/contracts'
import { calculateContainedPlacement } from './image-layout'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_CELL_EDGE = 2_048

function decodeReferencePng(source: Buffer): Electron.NativeImage {
  if (source.length < PNG_SIGNATURE.length ||
    !source.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Reference image input is an invalid PNG.')
  }
  const image = nativeImage.createFromBuffer(source)
  const size = image.getSize()
  if (image.isEmpty() || size.width <= 0 || size.height <= 0) {
    throw new Error('Reference image input is an invalid PNG.')
  }
  return image
}

export function validateReferencePngs(referencePngs: readonly Buffer[]): void {
  if (referencePngs.length === 0) throw new Error('Reference images are missing.')
  if (referencePngs.length > MAX_REFERENCE_IMAGE_COUNT) {
    throw new Error(`Reference generation supports at most ${MAX_REFERENCE_IMAGE_COUNT} images.`)
  }
  referencePngs.forEach(decodeReferencePng)
}

function placeImageInCell(
  canvas: Buffer,
  canvasWidth: number,
  cellOffsetX: number,
  cellOffsetY: number,
  cellEdge: number,
  image: Electron.NativeImage
): void {
  const sourceSize = image.getSize()
  const placement = calculateContainedPlacement(
    sourceSize.width,
    sourceSize.height,
    cellEdge,
    cellEdge
  )
  const resized = image.resize({
    width: placement.width,
    height: placement.height,
    quality: 'best'
  })
  const bitmap = resized.toBitmap()
  if (bitmap.length !== placement.width * placement.height * 4) {
    throw new Error('Reference image input produced an invalid PNG bitmap.')
  }

  const rowBytes = placement.width * 4
  for (let row = 0; row < placement.height; row += 1) {
    const sourceStart = row * rowBytes
    const targetStart = (
      (cellOffsetY + placement.y + row) * canvasWidth + cellOffsetX + placement.x
    ) * 4
    bitmap.copy(canvas, targetStart, sourceStart, sourceStart + rowBytes)
  }
}

export function prepareSingleImageReference(referencePngs: readonly Buffer[]): Buffer {
  if (referencePngs.length === 0) throw new Error('Reference images are missing.')
  if (referencePngs.length > MAX_REFERENCE_IMAGE_COUNT) {
    throw new Error(`Single-image providers support at most ${MAX_REFERENCE_IMAGE_COUNT} reference images.`)
  }

  const images = referencePngs.map(decodeReferencePng)
  if (images.length === 1) return referencePngs[0]!

  const firstSize = images[0]!.getSize()
  const cellEdge = Math.min(MAX_CELL_EDGE, Math.max(firstSize.width, firstSize.height))
  const columns = 2
  const rows = Math.ceil(images.length / columns)
  const canvasWidth = cellEdge * columns
  const canvasHeight = cellEdge * rows
  const canvas = Buffer.alloc(canvasWidth * canvasHeight * 4)
  images.forEach((image, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    placeImageInCell(
      canvas,
      canvasWidth,
      column * cellEdge,
      row * cellEdge,
      cellEdge,
      image
    )
  })
  return nativeImage.createFromBitmap(canvas, {
    width: canvasWidth,
    height: canvasHeight,
    scaleFactor: 1
  }).toPNG()
}
