const MAX_PROVIDER_MESSAGE_LENGTH = 500
const REQUEST_DATA_PROPERTY_PATTERN =
  /["'](?:input|instructions|prompt|image_url|api[_-]?key|authorization)["']\s*:/i

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error !== 'object' || error === null || !('message' in error)) return ''
  return typeof error.message === 'string' ? error.message : ''
}

export function sanitizedProviderMessage(
  error: unknown,
  sensitiveValues: readonly string[] = []
): string {
  const message = errorMessage(error).trim()
  if (!message) return '(no provider message)'
  if (REQUEST_DATA_PROPERTY_PATTERN.test(message)) {
    return '[REDACTED_PROVIDER_MESSAGE_WITH_REQUEST_DATA]'
  }

  const withExactValuesRedacted = sensitiveValues.reduce(
    (current, value) => value ? current.replaceAll(value, '[REDACTED_SENSITIVE_VALUE]') : current,
    message
  )
  const sanitized = withExactValuesRedacted
    .replace(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/gi, '[REDACTED_IMAGE]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]')
    .replace(/[A-Za-z0-9+/_=-]{80,}/g, '[REDACTED_LONG_TOKEN]')
    .replace(
      /\b((?:user\s+)?prompt(?:\s+text)?|instruction\s+text)\s*[:=][\s\S]*$/i,
      '$1: [REDACTED]'
    )
    .replace(/\s+/g, ' ')
    .trim()

  if (sanitized.length <= MAX_PROVIDER_MESSAGE_LENGTH) return sanitized
  return `${sanitized.slice(0, MAX_PROVIDER_MESSAGE_LENGTH - 3)}...`
}
