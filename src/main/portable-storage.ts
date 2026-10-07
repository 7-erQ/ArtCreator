import { mkdirSync, mkdtempSync, readFileSync, rmdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { App } from 'electron'

type StorageApp = Pick<App, 'isPackaged' | 'getAppPath' | 'getPath' | 'setPath' | 'setAppLogsPath'>

export function configurePortableStorage(
  app: StorageApp,
  platform: NodeJS.Platform = process.platform
): void {
  if (!app.isPackaged || platform !== 'win32') return
  const metadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
  if (metadata.portable !== true) return

  const directory = join(dirname(app.getPath('exe')), 'data')
  const paths = {
    userData: directory,
    sessionData: join(directory, 'session'),
    temp: join(directory, 'temp'),
    crashDumps: join(directory, 'crash-dumps'),
    logs: join(directory, 'logs')
  }
  for (const path of Object.values(paths)) {
    mkdirSync(path, { recursive: true })
    rmdirSync(mkdtempSync(join(path, '.write-check-')))
  }
  for (const [name, path] of Object.entries(paths)) {
    if (name === 'logs') app.setAppLogsPath(path)
    else app.setPath(name, path)
  }
}
