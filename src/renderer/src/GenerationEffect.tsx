import type { GenerationEffectSchemeId, GenerationJobStatus } from '../../shared/contracts'
import { GenerationEffectCanvas } from './GenerationEffectCanvas'
import {
  resolveGenerationEffectStage,
  type GenerationEffectPresentation
} from './GenerationEffectStage'

interface GenerationEffectProps {
  status?: GenerationJobStatus
  presentation: GenerationEffectPresentation
  scheme: GenerationEffectSchemeId
  sourceImageUrl?: string
  hidden?: boolean
}

export function GenerationEffect({
  status,
  presentation,
  scheme,
  sourceImageUrl,
  hidden = false
}: GenerationEffectProps): React.JSX.Element {
  const stage = resolveGenerationEffectStage(status, presentation)
  const active = stage !== 'settled'

  return (
    <div
      className={[
        'generation-effect',
        `generation-effect-${presentation}`,
        `generation-effect-scheme-${scheme}`,
        `generation-effect-stage-${stage}`,
        hidden ? 'generation-effect-hidden' : ''
      ].filter(Boolean).join(' ')}
      data-effect-stage={stage}
      data-effect-active={active}
      data-effect-scheme={scheme}
      aria-hidden="true"
    >
      {sourceImageUrl && scheme === 'aperture-fold' && (
        <img
          className="generation-effect-source"
          src={sourceImageUrl}
          alt=""
          draggable={false}
        />
      )}
      <span className="generation-effect-ambient" />
      <GenerationEffectCanvas active={active} scheme={scheme} sourceImageUrl={sourceImageUrl} />
      <span className="generation-effect-frame" />
    </div>
  )
}
