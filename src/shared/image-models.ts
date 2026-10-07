import { z } from 'zod'

export const imageGenerationSchema = z.enum(['generate', 'reference', 'inpaint'])
export type ImageGeneration = z.infer<typeof imageGenerationSchema>

export const imageProviderSchema = z.enum(['openai', 'liblib', 'comfyui'])
export type ImageProvider = z.infer<typeof imageProviderSchema>
export const DEFAULT_LIBLIB_BASE_URL = 'https://openapi.liblibai.cloud'

const openAIImageModelSchema = z.enum([
  'gpt-image-2',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare'
])
const liblibImageModelSchema = z.enum([
  'star-3-alpha',
  'f1-kontext-pro',
  'f1-kontext-max',
  'img1',
  'libdream',
  'libedit',
  'libedit-v2',
  'seedream-4.0',
  'seedream-4.5',
  'qwen-image'
])

export const comfyUiCheckpointSchema = z.string().trim().min(1).max(512).refine((value) => {
  if (value.includes('\0') || value.includes('\r') || value.includes('\n')) return false
  if (/^(?:[A-Za-z]:|[\\/])/.test(value)) return false
  return !value.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..')
}, 'ComfyUI checkpoint must be a safe relative model name.')

export const comfyUiWorkflowPathSchema = z.string().trim().min(1).max(1_024).refine((value) => {
  if (value.includes('\0') || value.includes('\r') || value.includes('\n')) return false
  if (value.includes('\\') || !value.toLowerCase().endsWith('.json')) return false
  const parts = value.split('/')
  return parts[0] === 'workflows' &&
    !parts.some((part) => part === '' || part === '.' || part === '..')
}, 'ComfyUI workflow must be a safe JSON path inside the workflows namespace.')

const comfyUiWorkflowSelectionSchema = z.object({
  provider: z.literal('comfyui'),
  workflowPath: comfyUiWorkflowPathSchema,
  generationModes: z.array(imageGenerationSchema).min(1).max(3).refine(
    (modes) => new Set(modes).size === modes.length,
    'ComfyUI workflow generation modes must be unique.'
  ),
  transparentOutput: z.boolean()
})

export const imageModelSelectionSchema = z.union([
  z.object({ provider: z.literal('openai'), model: openAIImageModelSchema }),
  z.object({ provider: z.literal('liblib'), model: liblibImageModelSchema }),
  z.object({ provider: z.literal('comfyui'), model: comfyUiCheckpointSchema }),
  comfyUiWorkflowSelectionSchema
])
export type ImageModelSelection = z.infer<typeof imageModelSelectionSchema>
export type ComfyUiWorkflowSelection = z.infer<typeof comfyUiWorkflowSelectionSchema>

export function isComfyUiWorkflowSelection(
  selection: ImageModelSelection
): selection is ComfyUiWorkflowSelection {
  return selection.provider === 'comfyui' && 'workflowPath' in selection
}

export const DEFAULT_IMAGE_MODEL_SELECTION = {
  provider: 'openai',
  model: 'gpt-image-2'
} as const satisfies ImageModelSelection

export interface ImageModelDefinition {
  selection: ImageModelSelection
  label: string
  generationModes: readonly ImageGeneration[]
  supportsEdit: boolean
  supportsTransparency: boolean
  promptLanguage: 'any' | 'en'
  normalization: 'contain' | 'cover'
}

export const IMAGE_PROVIDERS = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'liblib', label: 'LiblibAI' },
  { id: 'comfyui', label: 'ComfyUI' }
] as const satisfies readonly { id: ImageProvider; label: string }[]

export const IMAGE_MODELS = [
  {
    selection: DEFAULT_IMAGE_MODEL_SELECTION,
    label: 'GPT Image 2',
    generationModes: ['generate', 'reference', 'inpaint'],
    supportsEdit: true,
    supportsTransparency: true,
    promptLanguage: 'any',
    normalization: 'contain'
  },
  {
    selection: { provider: 'openai', model: 'gpt-image-2.5-sunburst' },
    label: 'GPT Image 2.5 Sunburst',
    generationModes: ['generate', 'reference', 'inpaint'],
    supportsEdit: true,
    supportsTransparency: true,
    promptLanguage: 'any',
    normalization: 'contain'
  },
  {
    selection: { provider: 'openai', model: 'gpt-image-2.5-flare' },
    label: 'GPT Image 2.5 Flare',
    generationModes: ['generate', 'reference', 'inpaint'],
    supportsEdit: true,
    supportsTransparency: true,
    promptLanguage: 'any',
    normalization: 'contain'
  },
  {
    selection: { provider: 'liblib', model: 'star-3-alpha' },
    label: 'Star-3 Alpha',
    generationModes: ['generate', 'reference'],
    supportsEdit: true,
    supportsTransparency: false,
    promptLanguage: 'en',
    normalization: 'contain'
  },
  {
    selection: { provider: 'liblib', model: 'f1-kontext-pro' },
    label: 'F.1 Kontext Pro',
    generationModes: ['generate', 'reference'],
    supportsEdit: true,
    supportsTransparency: false,
    promptLanguage: 'any',
    normalization: 'cover'
  },
  {
    selection: { provider: 'liblib', model: 'f1-kontext-max' },
    label: 'F.1 Kontext Max',
    generationModes: ['generate', 'reference'],
    supportsEdit: true,
    supportsTransparency: false,
    promptLanguage: 'any',
    normalization: 'cover'
  },
  {
    selection: { provider: 'liblib', model: 'img1' },
    label: 'IMG1',
    generationModes: ['generate', 'reference', 'inpaint'],
    supportsEdit: true,
    supportsTransparency: false,
    promptLanguage: 'any',
    normalization: 'cover'
  },
  {
    selection: { provider: 'liblib', model: 'libdream' },
    label: 'LibDream',
    generationModes: ['generate'],
    supportsEdit: false,
    supportsTransparency: false,
    promptLanguage: 'any',
    normalization: 'contain'
  },
  {
    selection: { provider: 'liblib', model: 'libedit' },
    label: 'LibEdit',
    generationModes: ['reference'],
    supportsEdit: true,
    supportsTransparency: false,
    promptLanguage: 'any',
    normalization: 'contain'
  },
  {
    selection: { provider: 'liblib', model: 'libedit-v2' },
    label: 'LibEdit V2',
    generationModes: ['reference'],
    supportsEdit: true,
    supportsTransparency: false,
    promptLanguage: 'any',
    normalization: 'contain'
  },
  {
    selection: { provider: 'liblib', model: 'seedream-4.0' },
    label: 'Seedream 4.0',
    generationModes: ['generate', 'reference'],
    supportsEdit: true,
    supportsTransparency: false,
    promptLanguage: 'any',
    normalization: 'contain'
  },
  {
    selection: { provider: 'liblib', model: 'seedream-4.5' },
    label: 'Seedream 4.5',
    generationModes: ['generate', 'reference'],
    supportsEdit: true,
    supportsTransparency: false,
    promptLanguage: 'any',
    normalization: 'contain'
  },
  {
    selection: { provider: 'liblib', model: 'qwen-image' },
    label: 'Qwen Image',
    generationModes: ['generate'],
    supportsEdit: false,
    supportsTransparency: false,
    promptLanguage: 'en',
    normalization: 'contain'
  }
] as const satisfies readonly ImageModelDefinition[]

export function imageModelKey(selection: ImageModelSelection): string {
  return isComfyUiWorkflowSelection(selection)
    ? `${selection.provider}:workflow:${selection.workflowPath}`
    : `${selection.provider}:${selection.model}`
}

export function getImageModelDefinition(selection: ImageModelSelection): ImageModelDefinition {
  if (selection.provider === 'comfyui') {
    if (isComfyUiWorkflowSelection(selection)) {
      const fileName = selection.workflowPath.replaceAll('\\', '/').split('/').at(-1) ?? selection.workflowPath
      return {
        selection,
        label: fileName.replace(/\.json$/i, ''),
        generationModes: selection.generationModes,
        supportsEdit: false,
        supportsTransparency: selection.transparentOutput,
        promptLanguage: 'any',
        normalization: 'contain'
      }
    }
    return {
      selection,
      label: selection.model.replaceAll('\\', '/').split('/').at(-1) ?? selection.model,
      generationModes: ['generate', 'reference', 'inpaint'],
      supportsEdit: true,
      supportsTransparency: false,
      promptLanguage: 'any',
      normalization: 'contain'
    }
  }
  const key = imageModelKey(selection)
  const definition = IMAGE_MODELS.find((candidate) => imageModelKey(candidate.selection) === key)
  if (!definition) throw new Error('Unknown image model selection.')
  return definition
}

export function imageModelsForProvider(provider: ImageProvider): readonly ImageModelDefinition[] {
  return IMAGE_MODELS.filter((definition) => definition.selection.provider === provider)
}

export function firstSupportedImageGeneration(selection: ImageModelSelection): ImageGeneration {
  return getImageModelDefinition(selection).generationModes[0]!
}

export function supportsImageGeneration(
  selection: ImageModelSelection,
  generation: ImageGeneration
): boolean {
  return getImageModelDefinition(selection).generationModes.includes(generation)
}
