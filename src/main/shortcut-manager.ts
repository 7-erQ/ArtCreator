import { globalShortcut } from 'electron'

export class ShortcutManager {
  private current?: string

  register(accelerator: string, callback: () => void): boolean {
    const previous = this.current
    if (previous) globalShortcut.unregister(previous)

    if (globalShortcut.register(accelerator, callback)) {
      this.current = accelerator
      return true
    }

    if (previous) globalShortcut.register(previous, callback)
    return false
  }

  dispose(): void {
    if (this.current) globalShortcut.unregister(this.current)
    this.current = undefined
  }
}

