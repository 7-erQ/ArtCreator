/// <reference types="vite/client" />

import type { AppApi } from '../../shared/contracts'

declare global {
  interface Window {
    artCreator: AppApi
  }
}

export {}

