import {
  desktopCapturer,
  type Display,
  type NativeImage
} from 'electron'

export interface CapturedDisplaySnapshot {
  display: Display
  image: NativeImage
}

export function configureDisplayCaptureColorProfile(
  platform: NodeJS.Platform,
  commandLine: Pick<Electron.CommandLine, 'appendSwitch'>
): void {
  if (platform === 'win32') commandLine.appendSwitch('force-color-profile', 'srgb')
}

function displayPixelSize(display: Display): Electron.Size {
  return {
    width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
    height: Math.max(1, Math.round(display.size.height * display.scaleFactor))
  }
}

export async function captureDisplaySnapshots(
  displays: Display[]
): Promise<Map<string, CapturedDisplaySnapshot>> {
  const pixelSizes = new Map<string, Electron.Size>()
  let thumbnailWidth = 1
  let thumbnailHeight = 1

  for (const display of displays) {
    const pixelSize = displayPixelSize(display)
    pixelSizes.set(String(display.id), pixelSize)
    thumbnailWidth = Math.max(thumbnailWidth, pixelSize.width)
    thumbnailHeight = Math.max(thumbnailHeight, pixelSize.height)
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbnailWidth, height: thumbnailHeight },
    fetchWindowIcons: false
  })
  const sourceByDisplay = new Map(sources.map((source) => [source.display_id, source]))
  const snapshots = new Map<string, CapturedDisplaySnapshot>()

  for (const display of displays) {
    const displayId = String(display.id)
    const source = sourceByDisplay.get(displayId)
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error(`未找到显示器 ${display.id} 的屏幕图像。`)
    }
    const pixelSize = pixelSizes.get(displayId)!
    const sourceSize = source.thumbnail.getSize()
    const image = sourceSize.width === pixelSize.width && sourceSize.height === pixelSize.height
      ? source.thumbnail
      : source.thumbnail.resize({ ...pixelSize, quality: 'best' })
    if (image.isEmpty()) throw new Error(`显示器 ${display.id} 的屏幕图像无效。`)
    snapshots.set(displayId, { display, image })
  }

  return snapshots
}
