import type { GenerationJobStatus } from '../../shared/contracts'

export const GENERATION_EFFECT_STAGES = [
  'preparing',
  'interpreting',
  'drawing',
  'redrawing',
  'settled'
] as const

export type GenerationEffectStage = typeof GENERATION_EFFECT_STAGES[number]
export type GenerationEffectPresentation = 'placeholder' | 'overlay'

export function resolveGenerationEffectStage(
  status: GenerationJobStatus | undefined,
  presentation: GenerationEffectPresentation
): GenerationEffectStage {
  if (!status) return 'preparing'
  if (status === 'processing_prompt') return 'interpreting'
  if (status === 'generating') return presentation === 'overlay' ? 'redrawing' : 'drawing'
  return 'settled'
}
