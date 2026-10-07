import {
  GENERATION_EFFECT_CHOICES,
  GENERATION_EFFECT_SCHEME_IDS,
  type GenerationEffectChoice,
  type GenerationEffectSchemeId
} from '../../shared/contracts'

export interface GenerationEffectSchemeOption {
  id: GenerationEffectSchemeId
  label: string
  description: string
}

export const GENERATION_EFFECT_SCHEMES = [
  {
    id: 'frosted-orbit',
    label: '游走描线',
    description: '沿当前图片从主要轮廓持续补充细节，达到精细度上限后保留完整线稿。'
  },
  {
    id: 'aperture-fold',
    label: '游走上色',
    description: '当前图片先以黑白显示，柔边画笔按同色系分批游走上色。'
  },
  {
    id: 'pixel-weave',
    label: '像素重组',
    description: '立体像素点随中心涟漪向四周浮起回落，重组强度逐轮往返。'
  }
] as const satisfies readonly GenerationEffectSchemeOption[]

const choiceValues = GENERATION_EFFECT_CHOICES as readonly string[]

export function normalizeGenerationEffectChoice(value: string | null): GenerationEffectChoice {
  return value && choiceValues.includes(value) ? value as GenerationEffectChoice : 'random'
}

function hashSeed(seed: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16_777_619)
  }
  return hash >>> 0
}

export function resolveGenerationEffectScheme(
  choice: GenerationEffectChoice,
  seed: string
): GenerationEffectSchemeId {
  if (choice !== 'random') return choice
  return GENERATION_EFFECT_SCHEME_IDS[hashSeed(seed) % GENERATION_EFFECT_SCHEME_IDS.length]!
}

export function getGenerationEffectScheme(
  id: GenerationEffectSchemeId
): GenerationEffectSchemeOption {
  return GENERATION_EFFECT_SCHEMES.find((scheme) => scheme.id === id)!
}
