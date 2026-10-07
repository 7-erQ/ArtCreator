import { type FormEvent, useEffect, useState } from 'react'
import {
  UPSCALE_DIMENSION_MAX,
  UPSCALE_DIMENSION_MIN,
  upscaleDimensionsSchema
} from '../../shared/contracts'

function initialDimension(value: string | null): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) &&
    parsed >= UPSCALE_DIMENSION_MIN && parsed <= UPSCALE_DIMENSION_MAX
    ? parsed
    : 1024
}

export function UpscaleDialog(): React.JSX.Element {
  const query = new URLSearchParams(window.location.search)
  const jobId = query.get('jobId') ?? ''
  const initialWidth = initialDimension(query.get('width'))
  const initialHeight = initialDimension(query.get('height'))
  const [width, setWidth] = useState(String(initialWidth))
  const [height, setHeight] = useState(String(initialHeight))
  const [locked, setLocked] = useState(true)
  const [lockedRatio, setLockedRatio] = useState(initialWidth / initialHeight)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState('')

  const dimensions = upscaleDimensionsSchema.safeParse({
    width: Number(width),
    height: Number(height)
  })

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !submitting) window.close()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [submitting])

  function updateWidth(value: string): void {
    setWidth(value)
    const numeric = Number(value)
    if (locked && Number.isFinite(numeric) && numeric > 0) {
      setHeight(String(Math.round(numeric / lockedRatio)))
    }
    setNotice('')
  }

  function updateHeight(value: string): void {
    setHeight(value)
    const numeric = Number(value)
    if (locked && Number.isFinite(numeric) && numeric > 0) {
      setWidth(String(Math.round(numeric * lockedRatio)))
    }
    setNotice('')
  }

  function toggleRatioLock(): void {
    if (!locked) {
      const nextWidth = Number(width)
      const nextHeight = Number(height)
      if (Number.isFinite(nextWidth) && Number.isFinite(nextHeight) &&
        nextWidth > 0 && nextHeight > 0) {
        setLockedRatio(nextWidth / nextHeight)
      }
    }
    setLocked((current) => !current)
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!dimensions.success || !jobId) return
    setSubmitting(true)
    setNotice('')
    try {
      await window.artCreator.preview.process(jobId, {
        action: 'upscale',
        dimensions: dimensions.data
      })
      window.close()
    } catch {
      setSubmitting(false)
      setNotice('无法开始放大，请确认任务空闲后重试。')
    }
  }

  return (
    <main className="upscale-dialog-shell">
      <header className="upscale-dialog-header">
        <div>
          <p>RESIZE OUTPUT</p>
          <h1>放大 / 改尺寸</h1>
        </div>
        <button
          className="upscale-close-button"
          type="button"
          onClick={() => window.close()}
          disabled={submitting}
          aria-label="关闭尺寸弹窗"
        >×</button>
      </header>

      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="upscale-dimension-row">
          <label>
            <span>图宽</span>
            <input
              autoFocus
              type="number"
              inputMode="numeric"
              min={UPSCALE_DIMENSION_MIN}
              max={UPSCALE_DIMENSION_MAX}
              step="1"
              value={width}
              onChange={(event) => updateWidth(event.target.value)}
              disabled={submitting}
              aria-label="图宽"
            />
          </label>

          <button
            className={`aspect-lock-button ${locked ? 'is-locked' : ''}`}
            type="button"
            onClick={toggleRatioLock}
            disabled={submitting}
            aria-label={locked ? '解锁宽高比例' : '锁定宽高比例'}
            aria-pressed={locked}
            title={locked ? '已锁定比例' : '未锁定比例'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={locked
                ? 'M7 10V7a5 5 0 0 1 10 0v3M6 10h12v10H6z'
                : 'M8 10V7a4 4 0 0 1 7.7-1.5M6 10h12v10H6z'} />
            </svg>
          </button>

          <label>
            <span>图高</span>
            <input
              type="number"
              inputMode="numeric"
              min={UPSCALE_DIMENSION_MIN}
              max={UPSCALE_DIMENSION_MAX}
              step="1"
              value={height}
              onChange={(event) => updateHeight(event.target.value)}
              disabled={submitting}
              aria-label="图高"
            />
          </label>
        </div>

        <div className="upscale-dialog-footer">
          <p className={notice ? 'is-error' : ''}>
            {notice || `支持 ${UPSCALE_DIMENSION_MIN}–${UPSCALE_DIMENSION_MAX} px 整数尺寸`}
          </p>
          <div>
            <button type="button" onClick={() => window.close()} disabled={submitting}>取消</button>
            <button className="upscale-confirm-button" type="submit" disabled={!dimensions.success || submitting}>
              {submitting ? '处理中…' : '开始放大'}
            </button>
          </div>
        </div>
      </form>
    </main>
  )
}
