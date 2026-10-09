import { useSyncExternalStore } from 'react'
import { getLanguage, subscribeLanguage } from '../../shared/language'

export function useLanguage(): ReturnType<typeof getLanguage> {
  return useSyncExternalStore(subscribeLanguage, getLanguage)
}
