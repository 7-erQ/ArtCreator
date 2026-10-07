import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_STAR3_GENERATION_OPTIONS,
  type GenerationJobSnapshot,
  type GenerationRequestDraft,
  type GenerationRequestReview,
  type Star3GenerationOptions
} from '../../shared/contracts'
import { getImageModelDefinition } from '../../shared/image-models'

const PROMPT_PROCESSING_LABEL = {
  direct: 'DIRECT',
  polish: 'POLISH',
  polish_with_selection: 'POLISH + SELECTION'
} as const

const IMAGE_GENERATION_LABEL = {
  generate: 'GENERATE',
  reference: 'REFERENCE',
  inpaint: 'INPAINT'
} as const

function validStar3Options(options: Star3GenerationOptions): boolean {
  return Number.isInteger(options.steps) && options.steps >= 1 && options.steps <= 100 &&
    Number.isFinite(options.denoisingStrength) &&
    options.denoisingStrength >= 0 && options.denoisingStrength <= 1
}

export function Details(): React.JSX.Element {
  const initialId = new URLSearchParams(window.location.search).get('jobId') ?? ''
  const [jobId, setJobId] = useState(initialId)
  const [job, setJob] = useState<GenerationJobSnapshot>()
  const [prompt, setPrompt] = useState('')
  const [liblibOptions, setLiblibOptions] = useState<Star3GenerationOptions>({
    ...DEFAULT_STAR3_GENERATION_OPTIONS
  })
  const [review, setReview] = useState<GenerationRequestReview>()
  const [reviewError, setReviewError] = useState('')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => window.artCreator.preview.onDetailsJobChanged(setJobId), [])

  useEffect(() => {
    let active = true
    void window.artCreator.jobs.get(jobId).then((value) => {
      if (!active) return
      setJob(value)
      setReview(undefined)
      setPrompt(value?.assetSpec?.generatorPrompt ?? '')
      setLiblibOptions(value?.selection.liblibGenerationOptions ?? {
        ...DEFAULT_STAR3_GENERATION_OPTIONS
      })
      setMessage('')
      setReviewError('')
      setSubmitting(false)
    })
    const removeListener = window.artCreator.jobs.onChanged((value) => {
      if (active && value.id === jobId) setJob(value)
    })
    return () => {
      active = false
      removeListener()
    }
  }, [jobId])

  const awaitingConfirmation = job?.status === 'awaiting_confirmation'
  const isStar3 = job?.selection.imageModel.provider === 'liblib' &&
    job.selection.imageModel.model === 'star-3-alpha'
  const optionsValid = !isStar3 || validStar3Options(liblibOptions)
  const draft = useMemo<GenerationRequestDraft | undefined>(() => {
    if (!prompt.trim() || !optionsValid) return undefined
    return {
      generatorPrompt: prompt,
      ...(isStar3 ? { liblibGenerationOptions: liblibOptions } : {})
    }
  }, [isStar3, liblibOptions, optionsValid, prompt])

  useEffect(() => {
    if (!awaitingConfirmation || !draft) return
    let active = true
    const timeout = window.setTimeout(() => {
      void window.artCreator.preview.getGenerationReview(jobId, draft)
        .then((value) => {
          if (!active) return
          setReview(value)
          setReviewError('')
        })
        .catch((error) => {
          if (!active) return
          setReview(undefined)
          setReviewError(error instanceof Error ? error.message : '无法预览本次请求。')
        })
    }, 120)
    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [awaitingConfirmation, draft, jobId])

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!draft) return
    setSubmitting(true)
    setMessage(awaitingConfirmation
      ? '正在提交已确认的生成请求。'
      : '正在重新生成，原图会保留到新结果成功。')
    try {
      const updated = awaitingConfirmation
        ? await window.artCreator.preview.confirmGeneration(jobId, draft)
        : await window.artCreator.preview.regenerate(jobId, prompt)
      setJob(updated)
      if (awaitingConfirmation) window.close()
    } catch (error) {
      setSubmitting(false)
      setMessage(error instanceof Error ? error.message : '无法提交生成请求。')
    }
  }

  async function cancelConfirmation(): Promise<void> {
    setSubmitting(true)
    await window.artCreator.jobs.cancel(jobId)
    window.close()
  }

  const spec = job?.assetSpec
  const model = job ? getImageModelDefinition(job.selection.imageModel) : undefined
  const running = job?.status === 'processing_prompt' || job?.status === 'generating'

  return (
    <main className="details-shell">
      <div className="window-drag-bar" aria-hidden="true" />
      <header className="details-header">
        <div>
          <p className="eyebrow">
            ASSET SPEC / {job
              ? `${job.selection.imageModel.provider.toUpperCase()} / ${model?.label} / ${PROMPT_PROCESSING_LABEL[job.selection.promptProcessing]} / ${IMAGE_GENERATION_LABEL[job.selection.imageGeneration]}`
              : 'PENDING'}
          </p>
          <h1>{awaitingConfirmation ? '确认本次生成' : spec?.assetName ?? '正在整理素材规格'}</h1>
        </div>
        <button className="details-close" onClick={() => window.close()} aria-label="关闭详情窗">×</button>
      </header>

      {spec ? (
        <form className="details-grid" onSubmit={(event) => void submit(event)}>
          <section className="spec-summary">
            <div><span>主体</span><p>{spec.subject}</p></div>
            <div><span>风格</span><p>{spec.style}</p></div>
            <div><span>构图</span><p>{spec.composition}</p></div>
            <div><span>比例</span><p>{spec.targetAspectRatio.toFixed(3)}</p></div>
          </section>
          <label className="prompt-editor">
            <span>生成提示词</span>
            <textarea
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value)
                setReview(undefined)
              }}
              maxLength={12_000}
            />
          </label>

          {awaitingConfirmation && isStar3 && (
            <section className="generation-review-options" aria-label="Star-3 生成参数">
              <label className="review-checkbox">
                <input
                  type="checkbox"
                  checked={liblibOptions.promptMagic}
                  onChange={(event) => {
                    setReview(undefined)
                    setLiblibOptions((current) => ({
                      ...current,
                      promptMagic: event.target.checked
                    }))
                  }}
                />
                <span>提示词智能优化</span>
              </label>
              <label>
                <span>采样步数</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={liblibOptions.steps}
                  onChange={(event) => {
                    setReview(undefined)
                    setLiblibOptions((current) => ({
                      ...current,
                      steps: Number(event.target.value)
                    }))
                  }}
                />
              </label>
              {job.selection.imageGeneration === 'reference' && (
                <label>
                  <span>去噪强度</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={liblibOptions.denoisingStrength}
                    onChange={(event) => {
                      setReview(undefined)
                      setLiblibOptions((current) => ({
                        ...current,
                        denoisingStrength: Number(event.target.value)
                      }))
                    }}
                  />
                </label>
              )}
            </section>
          )}

          {awaitingConfirmation && (
            <section className="generation-request-review">
              <div>
                <span>本次请求（只读）· 共 {job.selection.generationCount} 张{review ? `，${review.length} 次请求` : ''}</span>
                <small>图片地址为上传前占位值；确认时会替换成真实上传地址。</small>
              </div>
              <pre>{review ? JSON.stringify(review, null, 2) : reviewError || '正在构建请求预览…'}</pre>
            </section>
          )}

          <div className="details-actions">
            <p>{message || (!optionsValid ? '请输入有效的 Star-3 参数。' : job?.error?.message)}</p>
            <div>
              {awaitingConfirmation && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={submitting}
                  onClick={() => void cancelConfirmation()}
                >取消生成</button>
              )}
              <button
                type="submit"
                disabled={running || submitting || !draft || (awaitingConfirmation && !review)}
              >
                {submitting || running
                  ? '生成中…'
                  : awaitingConfirmation
                    ? `确认并生成${job.selection.generationCount > 1 ? ` ${job.selection.generationCount} 张` : ''}`
                    : `使用此提示词重新生成${job.selection.generationCount > 1 ? ` ${job.selection.generationCount} 张` : ''}`}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <div className="details-waiting"><span className="preview-spinner" />正在分析截图与说明…</div>
      )}
    </main>
  )
}
