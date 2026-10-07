import { nativeImage } from 'electron'

export interface LiblibUploadFile {
  data: Buffer
  extension: 'png' | 'jpg'
  mediaType: 'image/png' | 'image/jpeg'
}

const MIN_JPEG_QUALITY = 50

function validImage(source: Buffer): Electron.NativeImage {
  const image = nativeImage.createFromBuffer(source)
  if (image.isEmpty()) throw new Error('LiblibAI image input is invalid.')
  return image
}

function jpegWithinLimit(image: Electron.NativeImage, maxBytes: number): {
  file: LiblibUploadFile
  width: number
  height: number
} {
  let candidate = image
  for (;;) {
    for (let quality = 90; quality >= MIN_JPEG_QUALITY; quality -= 10) {
      const data = candidate.toJPEG(quality)
      if (data.length <= maxBytes) {
        const size = candidate.getSize()
        return {
          file: { data, extension: 'jpg', mediaType: 'image/jpeg' },
          width: size.width,
          height: size.height
        }
      }
    }
    const size = candidate.getSize()
    if (size.width <= 64 || size.height <= 64) {
      throw new Error('LiblibAI image input cannot be reduced below its size limit.')
    }
    candidate = candidate.resize({
      width: Math.max(64, Math.floor(size.width * 0.8)),
      height: Math.max(64, Math.floor(size.height * 0.8)),
      quality: 'best'
    })
  }
}

function jpegAtCurrentSize(
  image: Electron.NativeImage,
  maxBytes: number
): LiblibUploadFile | undefined {
  for (let quality = 90; quality >= MIN_JPEG_QUALITY; quality -= 10) {
    const data = image.toJPEG(quality)
    if (data.length <= maxBytes) return { data, extension: 'jpg', mediaType: 'image/jpeg' }
  }
  return undefined
}

function binaryLiblibMask(
  mask: Electron.NativeImage,
  width: number,
  height: number
): LiblibUploadFile {
  const resized = mask.getSize().width === width && mask.getSize().height === height
    ? mask
    : mask.resize({ width, height, quality: 'best' })
  const bitmap = Buffer.from(resized.toBitmap())
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    const value = bitmap[offset + 3]! < 128 ? 255 : 0
    bitmap[offset] = value
    bitmap[offset + 1] = value
    bitmap[offset + 2] = value
    bitmap[offset + 3] = 255
  }
  const png = nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG()
  return { data: png, extension: 'png', mediaType: 'image/png' }
}

export function prepareLiblibReference(sourcePng: Buffer, maxBytes: number): LiblibUploadFile {
  if (sourcePng.length <= maxBytes) {
    validImage(sourcePng)
    return { data: sourcePng, extension: 'png', mediaType: 'image/png' }
  }
  return jpegWithinLimit(validImage(sourcePng), maxBytes).file
}

export function prepareLiblibInpaint(
  sourcePng: Buffer,
  maskPng: Buffer,
  maxBytes: number
): { image: LiblibUploadFile; mask: LiblibUploadFile } {
  const source = validImage(sourcePng)
  const mask = validImage(maskPng)
  const sourceSize = source.getSize()
  const maskSize = mask.getSize()
  if (sourceSize.width !== maskSize.width || sourceSize.height !== maskSize.height) {
    throw new Error('LiblibAI inpaint image and mask dimensions must match.')
  }

  let width = sourceSize.width
  let height = sourceSize.height
  for (;;) {
    const resizedSource = width === sourceSize.width && height === sourceSize.height
      ? source
      : source.resize({ width, height, quality: 'best' })
    const imageFile = width === sourceSize.width && height === sourceSize.height &&
      sourcePng.length <= maxBytes
      ? { data: sourcePng, extension: 'png', mediaType: 'image/png' } as LiblibUploadFile
      : jpegAtCurrentSize(resizedSource, maxBytes)
    const maskFile = binaryLiblibMask(mask, width, height)
    if (imageFile && maskFile.data.length <= maxBytes) {
      return { image: imageFile, mask: maskFile }
    }
    if (width <= 64 || height <= 64) {
      throw new Error('LiblibAI inpaint inputs cannot be reduced below their size limit.')
    }
    width = Math.max(64, Math.floor(width * 0.8))
    height = Math.max(64, Math.floor(height * 0.8))
  }
}
