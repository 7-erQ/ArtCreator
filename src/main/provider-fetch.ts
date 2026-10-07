const SSE_CONTENT_TYPE = 'text/event-stream'

function eventData(frame: string): string {
  return frame
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')
}

function isPingEvent(frame: string): boolean {
  const data = eventData(frame)
  if (!data) return false
  try {
    const event: unknown = JSON.parse(data)
    return typeof event === 'object' && event !== null &&
      'type' in event && event.type === 'ping'
  } catch {
    return false
  }
}

function filterPingEvents(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffered = ''

  function emitCompleteFrames(controller: TransformStreamDefaultController<Uint8Array>): void {
    for (;;) {
      const boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffered)
      if (!boundary || boundary.index === undefined) return
      const boundaryEnd = boundary.index + boundary[0].length
      const frame = buffered.slice(0, boundary.index)
      const completeFrame = buffered.slice(0, boundaryEnd)
      buffered = buffered.slice(boundaryEnd)
      if (!isPingEvent(frame)) controller.enqueue(encoder.encode(completeFrame))
    }
  }

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true })
      emitCompleteFrames(controller)
    },
    flush(controller) {
      buffered += decoder.decode()
      emitCompleteFrames(controller)
      if (buffered && !isPingEvent(buffered)) controller.enqueue(encoder.encode(buffered))
    }
  }))
}

function normalizeProviderResponse(response: Response): Response {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== SSE_CONTENT_TYPE || !response.body) return response

  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(filterPingEvents(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

export function createProviderFetch(requestFetch: typeof fetch): typeof fetch {
  return async (input, init) => normalizeProviderResponse(await requestFetch(input, init))
}
