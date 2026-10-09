import { z } from 'zod'
import { english } from './translations/en'

export const languageSchema = z.enum(['zh-CN', 'en'])
export type Language = z.infer<typeof languageSchema>
export const DEFAULT_LANGUAGE: Language = 'zh-CN'

export type LocalizedText = string | { key: string; values: TextValue[] }
type TextValue = LocalizedText | number | undefined

// Each process mirrors the persisted preference; SettingsStore owns the saved value.
let language: Language = DEFAULT_LANGUAGE
const listeners = new Set<() => void>()

export function getLanguage(): Language {
  return language
}

export function setLanguage(value: Language): void {
  if (language === value) return
  language = value
  listeners.forEach((listener) => listener())
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function message(key: string, ...values: TextValue[]): LocalizedText {
  return { key, values }
}

export function localizedError(error: unknown, fallback: string): LocalizedText {
  if (!(error instanceof Error)) return fallback
  // ContextBridge exposes Zod validation issues as a JSON Error.message.
  if (error.message.startsWith('[')) {
    try {
      const issues = z.array(z.object({
        code: z.string(),
        path: z.array(z.union([z.string(), z.number()])),
        message: z.string()
      })).min(1).safeParse(JSON.parse(error.message))
      if (issues.success) {
        return issues.data.map((issue) => message(issue.message))
          .reduce((combined, next) => message('{0}\n{1}', combined, next))
      }
    } catch {
      return error.message
    }
  }
  return error.message
}

export function translate(value: LocalizedText | undefined, locale: Language): string {
  if (value === undefined) return ''
  const key = typeof value === 'string' ? value : value.key
  const template = locale === 'en' ? english[key] ?? key : key
  if (typeof value === 'string') return template
  return template.replace(/\{(\d+)\}/g, (_placeholder, index: string) => {
    const argument = value.values[Number(index)]
    if (argument === undefined) return ''
    return typeof argument === 'object' ? translate(argument, locale) : String(argument)
  })
}

export function t(value: LocalizedText | undefined, ...values: TextValue[]): string {
  return translate(values.length && typeof value === 'string' ? message(value, ...values) : value, language)
}
