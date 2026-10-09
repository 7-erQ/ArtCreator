import { useLanguage } from './useLanguage'
import { localizedError, t, message as msg, type LocalizedText } from '../../shared/language'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent
} from 'react'
import { flushSync } from 'react-dom'
import {
  CAPTURE_DOODLE_STROKE_WIDTH_DIP,
  DEFAULT_COMFYUI_GENERATION_OPTIONS,
  DEFAULT_STAR3_GENERATION_OPTIONS,
  MAX_GENERATION_COUNT,
  MAX_REFERENCE_IMAGE_COUNT,
  type CaptureFollowUpAction,
  type CaptureOverlaySession,
  type CaptureSelection,
  type CaptureSubmissionMode,
  type ComfyUiCapabilities,
  comfyUiWorkflowSelection,
  type ImageGeneration,
  type ImageModelSelection,
  type ImageProvider,
  type PromptLanguage,
  type PromptProcessing,
  type RectDip
} from '../../shared/contracts'
import {
  firstSupportedImageGeneration,
  getImageModelDefinition,
  IMAGE_PROVIDERS,
  imageModelKey,
  imageModelsForProvider,
  isComfyUiWorkflowSelection,
  supportsImageGeneration
} from '../../shared/image-models'
import {
  clampDoodleStrokesToRect,
  translateRect,
  translateDoodleStrokes
} from '../../shared/capture-regions'
import {
  anchoredAspectRect,
  clampRect,
  normalizeRect,
  type PointDip
} from '../../shared/geometry'

type SelectionKind = 'context' | 'output' | 'reference'
type MarkMode = 'rectangle' | 'doodle'
type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se'

interface AspectRatioPreset {
  label: string
  value: number
  order: number
}

interface Interaction {
  kind: SelectionKind | 'doodle'
  operation: 'draw' | 'move' | 'resize'
  start: PointDip
  initial?: RectDip
  handle?: ResizeHandle
  referenceIndex?: number
  strokeIndex?: number
  dependentOutput?: RectDip
  dependentDoodleStrokes?: PointDip[][]
}

interface DrawAspectCycle {
  order: AspectRatioPreset[]
  index: number
}

const MIN_CONTEXT_SIZE = 48
const MIN_TARGET_SIZE = 24
const MARK_MODE_TOOLBAR_WIDTH = 178
const MARK_MODE_TOOLBAR_GAP = 10
const MARK_MODE_TOOLBAR_HEIGHT = 42
const IMAGE_GENERATION_LABELS = {
  generate: '从零生成',
  reference: '参考生成',
  inpaint: '局部重绘'
} as const satisfies Record<ImageGeneration, string>
const ASPECT_RATIO_PRESETS: AspectRatioPreset[] = [
  { label: '1:1', value: 1, order: 0 },
  { label: '4:3', value: 4 / 3, order: 1 },
  { label: '3:4', value: 3 / 4, order: 2 },
  { label: '3:2', value: 3 / 2, order: 3 },
  { label: '2:3', value: 2 / 3, order: 4 },
  { label: '16:9', value: 16 / 9, order: 5 },
  { label: '9:16', value: 9 / 16, order: 6 }
]

function rectStyle(rect: RectDip): CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
}

function rectSizeLabel(rect: RectDip, aspectRatio?: AspectRatioPreset): string {
  const size = `${Math.round(rect.width)} × ${Math.round(rect.height)}`
  return aspectRatio ? `${size} · ${aspectRatio.label}` : size
}

function firstSelectableImageGeneration(
  selection: ImageModelSelection,
  hasDoodleMask: boolean
): ImageGeneration {
  return getImageModelDefinition(selection).generationModes.find((mode) =>
    mode !== 'inpaint' || hasDoodleMask) ?? firstSupportedImageGeneration(selection)
}

function compareAspectRatioDistance(
  left: AspectRatioPreset,
  right: AspectRatioPreset,
  ratio: number
): number {
  const difference = Math.abs(Math.log(left.value / ratio)) -
    Math.abs(Math.log(right.value / ratio))
  return difference || left.order - right.order
}

function aspectRatioCycleOrder(rect: RectDip): AspectRatioPreset[] {
  const ratio = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1
  const nearest = [...ASPECT_RATIO_PRESETS]
    .sort((left, right) => compareAspectRatioDistance(left, right, ratio))[0]!
  const isLandscape = ratio >= 1
  const byDistance = (left: AspectRatioPreset, right: AspectRatioPreset): number =>
    compareAspectRatioDistance(left, right, ratio)
  const sameDirection = ASPECT_RATIO_PRESETS
    .filter((preset) => preset !== nearest && preset.value !== 1 &&
      (preset.value > 1) === isLandscape)
    .sort(byDistance)
  const square = nearest.value === 1
    ? []
    : ASPECT_RATIO_PRESETS.filter((preset) => preset.value === 1)
  const oppositeDirection = ASPECT_RATIO_PRESETS
    .filter((preset) => preset !== nearest && preset.value !== 1 &&
      (preset.value > 1) !== isLandscape)
    .sort(byDistance)
  return [nearest, ...sameDirection, ...square, ...oppositeDirection]
}

function selectedAspectRatio(cycle?: DrawAspectCycle): AspectRatioPreset | undefined {
  return cycle?.order[cycle.index]
}

function pointFromEvent(event: PointerEvent): PointDip {
  return { x: event.clientX, y: event.clientY }
}

function imageModelOptionValue(selection: ImageModelSelection): string {
  return isComfyUiWorkflowSelection(selection) ? imageModelKey(selection) : selection.model
}

function clampPoint(point: PointDip, bounds: RectDip): PointDip {
  return {
    x: Math.min(Math.max(point.x, bounds.x), bounds.x + bounds.width),
    y: Math.min(Math.max(point.y, bounds.y), bounds.y + bounds.height)
  }
}


function markModeToolbarStyle(context: RectDip, display: RectDip): CSSProperties {
  const globalLeft = Math.min(
    Math.max(8, context.x),
    Math.max(8, display.width - MARK_MODE_TOOLBAR_WIDTH - 8)
  )
  const hasSpaceBelow = context.y + context.height + MARK_MODE_TOOLBAR_GAP +
    MARK_MODE_TOOLBAR_HEIGHT <= display.height
  const hasSpaceAbove = context.y >= MARK_MODE_TOOLBAR_HEIGHT + MARK_MODE_TOOLBAR_GAP
  return {
    left: globalLeft - context.x,
    top: hasSpaceBelow
      ? context.height + MARK_MODE_TOOLBAR_GAP
      : hasSpaceAbove
        ? -MARK_MODE_TOOLBAR_HEIGHT - MARK_MODE_TOOLBAR_GAP
        : MARK_MODE_TOOLBAR_GAP
  }
}

function doodlePath(stroke: PointDip[], bounds: RectDip): string {
  const points = stroke.map((point) => `${point.x - bounds.x} ${point.y - bounds.y}`)
  return points.length === 1
    ? `M ${points[0]} L ${points[0]}`
    : `M ${points.join(' L ')}`
}

function resizeRect(
  initial: RectDip,
  handle: ResizeHandle,
  point: PointDip,
  bounds: RectDip,
  minimum: number
): RectDip {
  const right = initial.x + initial.width
  const bottom = initial.y + initial.height
  const horizontalStart = handle.endsWith('w')
  const verticalStart = handle.startsWith('n')
  const x = horizontalStart
    ? Math.min(point.x, right - minimum)
    : initial.x
  const y = verticalStart
    ? Math.min(point.y, bottom - minimum)
    : initial.y
  const nextRight = horizontalStart
    ? right
    : Math.max(point.x, initial.x + minimum)
  const nextBottom = verticalStart
    ? bottom
    : Math.max(point.y, initial.y + minimum)

  return clampRect(
    { x, y, width: nextRight - x, height: nextBottom - y },
    bounds
  )
}

function ResizeHandles({
  kind,
  onStart,
  referenceIndex
}: {
  kind: SelectionKind
  onStart: (event: PointerEvent, kind: SelectionKind, handle: ResizeHandle, referenceIndex?: number) => void
  referenceIndex?: number
}): React.JSX.Element {
  return (
    <>
      {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => (
        <span
          key={handle}
          className={`resize-handle ${handle}`}
          onPointerDown={(event) => onStart(event, kind, handle, referenceIndex)}
        />
      ))}
    </>
  )
}

type OverlayViewState = Omit<CaptureOverlaySession, 'screenshotPng' | 'followUp'> & {
  initialSelection?: CaptureSelection
  followUpAction?: CaptureFollowUpAction
}

function CaptureSessionOverlay({
  state,
  screenshotUrl,
  currentImageUrl
}: {
  state: OverlayViewState
  screenshotUrl: string
  currentImageUrl?: string
}): React.JSX.Element {
  useLanguage()
  const initialSelection = state.initialSelection
  const initialOptions = initialSelection ?? state.defaultGenerationOptions
  const isContinueEdit = state.followUpAction === 'continue_edit'
  const initialImageModel = initialOptions.imageModel
  const initialWorkflowSelection = isComfyUiWorkflowSelection(initialImageModel)
    ? initialImageModel
    : undefined
  const initialPromptProcessing = initialOptions.promptProcessing
  const initialDoodleStrokes = initialSelection?.doodleStrokesDip?.map((stroke) =>
    stroke.map((point) => ({ ...point }))) ?? []
  const [contextRect, setContextRect] = useState<RectDip | undefined>(
    initialSelection ? { ...initialSelection.contextRectDip } : undefined
  )
  const [outputRect, setOutputRect] = useState<RectDip | undefined>(
    initialSelection?.outputRectDip ? { ...initialSelection.outputRectDip } : undefined
  )
  const [referenceRects, setReferenceRects] = useState<RectDip[]>(
    initialSelection?.referenceRectsDip?.map((rect) => ({ ...rect })) ?? []
  )
  const [markMode, setMarkMode] = useState<MarkMode>('rectangle')
  const [doodleStrokes, setDoodleStrokes] = useState<PointDip[][]>(initialDoodleStrokes)
  const doodleStrokesRef = useRef<PointDip[][]>(initialDoodleStrokes)
  const [interaction, setInteraction] = useState<Interaction>()
  const currentPointerRef = useRef<PointDip | undefined>(undefined)
  const drawAspectCycleRef = useRef<DrawAspectCycle | undefined>(undefined)
  const [contextAspectRatio, setContextAspectRatio] = useState<AspectRatioPreset>()
  const [outputAspectRatio, setOutputAspectRatio] = useState<AspectRatioPreset>()
  const [lockedDisplayId, setLockedDisplayId] = useState<string | undefined>(state.lockedDisplayId)
  const [promptProcessing, setPromptProcessing] = useState<PromptProcessing>(
    initialPromptProcessing
  )
  const [promptLanguage, setPromptLanguage] = useState<PromptLanguage>(
    getImageModelDefinition(initialImageModel).promptLanguage === 'en' &&
      initialPromptProcessing !== 'direct'
      ? 'en'
      : initialOptions.promptLanguage
  )
  const [imageModel, setImageModel] = useState<ImageModelSelection>(
    initialImageModel
  )
  const [imageGeneration, setImageGeneration] = useState<ImageGeneration>(
    isContinueEdit
      ? 'reference'
      : supportsImageGeneration(initialImageModel, initialOptions.imageGeneration)
        ? initialOptions.imageGeneration : firstSupportedImageGeneration(initialImageModel)
  )
  const [generationCount, setGenerationCount] = useState(initialOptions.generationCount)
  const [liblibGenerationOptions, setLiblibGenerationOptions] = useState(
    initialOptions.liblibGenerationOptions ?? { ...DEFAULT_STAR3_GENERATION_OPTIONS }
  )
  const [comfyUiGenerationOptions, setComfyUiGenerationOptions] = useState(
    initialOptions.comfyUiGenerationOptions ?? { ...DEFAULT_COMFYUI_GENERATION_OPTIONS }
  )
  const [comfyUiWorkflowSeed, setComfyUiWorkflowSeed] = useState<number | undefined>(
    initialOptions.comfyUiWorkflowSeed
  )
  const [comfyUiCapabilities, setComfyUiCapabilities] = useState<ComfyUiCapabilities>()
  const [confirmBeforeGeneration, setConfirmBeforeGeneration] = useState(
    initialOptions.confirmBeforeGeneration ?? false
  )
  const [transparentBackground, setTransparentBackground] = useState(
    initialOptions.transparentBackground ??
      (initialWorkflowSelection ? initialWorkflowSelection.transparentOutput : false)
  )
  const [instruction, setInstruction] = useState(initialSelection?.instruction ?? '')
  const [showCurrentImage, setShowCurrentImage] = useState(Boolean(currentImageUrl))
  const [message, setMessage] = useState<LocalizedText>(initialSelection
    ? isContinueEdit
      ? (initialSelection.referenceRectsDip?.length ?? 0) > MAX_REFERENCE_IMAGE_COUNT - 1
        ? '继续编辑最多4张（含当前图）；按 Esc 撤销最后一个超额蓝框后提交。'
        : '继续编辑：当前图片为参考图1；可按顺序框选蓝框，最多再选3张'
      : '重新配置：可调整选框与提示词，按 Esc 逐步撤销'
    : '拖动选择绿色上下文区域')
  const [submittingMode, setSubmittingMode] = useState<CaptureSubmissionMode>()
  const imageModelRef = useRef(imageModel)
  const comfyUiOptionsRef = useRef(comfyUiGenerationOptions)
  imageModelRef.current = imageModel
  comfyUiOptionsRef.current = comfyUiGenerationOptions
  const modelDefinition = getImageModelDefinition(imageModel)
  const maxBlueReferences = isContinueEdit
    ? MAX_REFERENCE_IMAGE_COUNT - 1
    : MAX_REFERENCE_IMAGE_COUNT
  const canAddReference = imageGeneration === 'reference' &&
    referenceRects.length < maxBlueReferences
  const workflowSelection = isComfyUiWorkflowSelection(imageModel) ? imageModel : undefined
  const comfyUiCheckpoint = imageModel.provider === 'comfyui' &&
    !isComfyUiWorkflowSelection(imageModel)
    ? imageModel.model
    : undefined
  const selectedWorkflowBinding = workflowSelection
    ? state.comfyUiWorkflowBindings.find((binding) =>
        binding.workflowPath === workflowSelection.workflowPath)
    : undefined
  const configuredWorkflowModels = comfyUiCapabilities?.available
    ? state.comfyUiWorkflowBindings
      .filter((binding) => comfyUiCapabilities.workflows.some((workflow) =>
        workflow.path === binding.workflowPath))
      .map((binding) => getImageModelDefinition(comfyUiWorkflowSelection(binding)))
    : []
  const comfyUiProviderModels = comfyUiCapabilities?.available
    ? [
        ...comfyUiCapabilities.checkpoints.map((checkpoint) =>
          getImageModelDefinition({ provider: 'comfyui', model: checkpoint })),
        ...configuredWorkflowModels
      ]
    : []
  const providerModels = imageModel.provider === 'comfyui'
    ? (comfyUiCapabilities?.available
        ? comfyUiProviderModels
        : [getImageModelDefinition(imageModel)])
    : imageModelsForProvider(imageModel.provider)
  const requiresEnglish = modelDefinition.promptLanguage === 'en'
  const liblibOptionsValid = imageModel.provider !== 'liblib' || imageModel.model !== 'star-3-alpha' || (
    Number.isInteger(liblibGenerationOptions.steps) &&
    liblibGenerationOptions.steps >= 1 &&
    liblibGenerationOptions.steps <= 100 &&
    Number.isFinite(liblibGenerationOptions.denoisingStrength) &&
    liblibGenerationOptions.denoisingStrength >= 0 &&
    liblibGenerationOptions.denoisingStrength <= 1
  )
  const comfyUiOptionsValid = imageModel.provider !== 'comfyui' || Boolean(
    comfyUiCapabilities?.available && (
      workflowSelection
        ? selectedWorkflowBinding &&
          comfyUiCapabilities.workflows.some((workflow) =>
            workflow.path === workflowSelection.workflowPath) &&
          (comfyUiWorkflowSeed === undefined || Boolean(selectedWorkflowBinding.seed) &&
            Number.isSafeInteger(comfyUiWorkflowSeed) && comfyUiWorkflowSeed >= 0)
        : comfyUiCheckpoint !== undefined &&
          comfyUiCapabilities.checkpoints.includes(comfyUiCheckpoint) &&
          Number.isInteger(comfyUiGenerationOptions.steps) &&
          comfyUiGenerationOptions.steps >= 1 && comfyUiGenerationOptions.steps <= 100 &&
          Number.isFinite(comfyUiGenerationOptions.cfg) &&
          comfyUiGenerationOptions.cfg >= 0 && comfyUiGenerationOptions.cfg <= 100 &&
          Number.isFinite(comfyUiGenerationOptions.denoisingStrength) &&
          comfyUiGenerationOptions.denoisingStrength >= 0 &&
          comfyUiGenerationOptions.denoisingStrength <= 1 &&
          (comfyUiGenerationOptions.seed === undefined ||
            (Number.isSafeInteger(comfyUiGenerationOptions.seed) && comfyUiGenerationOptions.seed >= 0)) &&
          comfyUiCapabilities.samplers.includes(comfyUiGenerationOptions.samplerName) &&
          comfyUiCapabilities.schedulers.includes(comfyUiGenerationOptions.scheduler)
    )
  )

  const displayBounds = useMemo<RectDip>(() => ({
    x: 0,
    y: 0,
    width: state.displayBoundsDip.width,
    height: state.displayBoundsDip.height
  }), [state])
  const resolvedOutputRect = outputRect ?? contextRect
  const resolvedOutputAspectRatio = outputRect ? outputAspectRatio : contextAspectRatio
  const hasDoodleMask = doodleStrokes.length > 0
  const inpaintReady = imageGeneration !== 'inpaint' || hasDoodleMask
  const referenceModelReady = referenceRects.length === 0 || supportsImageGeneration(imageModel, 'reference')

  const isLocked = Boolean(
    lockedDisplayId && lockedDisplayId !== state.displayId
  )

  useEffect(() => {
    return window.artCreator.capture.onLocked(setLockedDisplayId)
  }, [])

  useEffect(() => {
    let active = true
    void window.artCreator.capture.getComfyUiCapabilities(state.sessionId)
      .then((capabilities) => {
        if (!active) return
        setComfyUiCapabilities(capabilities)
        const currentModel = imageModelRef.current
        if (!capabilities.available) {
          if (currentModel.provider === 'comfyui') {
            if (isContinueEdit) {
              setMessage('ComfyUI 当前不可用；请选择其它支持参考生成的供应商。')
            } else {
              setImageModel({ provider: 'openai', model: 'gpt-image-2' })
              setMessage('ComfyUI 当前不可用，已切换到 OpenAI；仍可选择其它在线供应商。')
            }
          }
          return
        }

        const messages: LocalizedText[] = []
        if (currentModel.provider === 'comfyui') {
          const workflowAvailable = isComfyUiWorkflowSelection(currentModel) &&
            state.comfyUiWorkflowBindings.some((binding) =>
              binding.workflowPath === currentModel.workflowPath) &&
            capabilities.workflows.some((workflow) => workflow.path === currentModel.workflowPath)
          const checkpointAvailable = !isComfyUiWorkflowSelection(currentModel) &&
            capabilities.checkpoints.includes(currentModel.model)
          if (!workflowAvailable && !checkpointAvailable) {
            if (isContinueEdit) {
              setMessage('原 ComfyUI 生图方案当前不可用；请选择可用的参考生成模型。')
              return
            }
            const firstBinding = state.comfyUiWorkflowBindings.find((binding) =>
              capabilities.workflows.some((workflow) => workflow.path === binding.workflowPath))
            const fallback = capabilities.checkpoints[0]
              ? { provider: 'comfyui', model: capabilities.checkpoints[0] } as const
              : firstBinding ? comfyUiWorkflowSelection(firstBinding) : undefined
            if (fallback) {
              setImageModel(fallback)
              setImageGeneration((current) =>
                supportsImageGeneration(fallback, current) &&
                  (current !== 'inpaint' || doodleStrokesRef.current.length > 0)
                  ? current
                  : firstSelectableImageGeneration(
                      fallback,
                      doodleStrokesRef.current.length > 0
                    ))
              if (isComfyUiWorkflowSelection(fallback)) {
                setTransparentBackground(fallback.transparentOutput)
                if (!firstBinding?.seed) setComfyUiWorkflowSeed(undefined)
              } else {
                setTransparentBackground(false)
              }
              messages.push(msg('上次使用的 ComfyUI 方案已不存在，已选择列表第一项'))
            } else {
              setImageModel({ provider: 'openai', model: 'gpt-image-2' })
              messages.push(msg('没有可用的 ComfyUI 方案，已切换到 OpenAI'))
            }
          }
        }
        if (capabilities.samplers.length > 0 && capabilities.schedulers.length > 0) {
          const currentOptions = comfyUiOptionsRef.current
          const samplerName = capabilities.samplers.includes(currentOptions.samplerName)
            ? currentOptions.samplerName
            : capabilities.samplers.includes(DEFAULT_COMFYUI_GENERATION_OPTIONS.samplerName)
              ? DEFAULT_COMFYUI_GENERATION_OPTIONS.samplerName
              : capabilities.samplers[0]!
          const scheduler = capabilities.schedulers.includes(currentOptions.scheduler)
            ? currentOptions.scheduler
            : capabilities.schedulers.includes(DEFAULT_COMFYUI_GENERATION_OPTIONS.scheduler)
              ? DEFAULT_COMFYUI_GENERATION_OPTIONS.scheduler
              : capabilities.schedulers[0]!
          if (samplerName !== currentOptions.samplerName || scheduler !== currentOptions.scheduler) {
            messages.push(msg('不可用的采样参数已按服务列表确定性回退'))
          }
          setComfyUiGenerationOptions((current) => ({ ...current, samplerName, scheduler }))
        }
        if (messages.length > 0) setMessage(messages.reduce((combined, next) => msg('{0}；{1}', combined, next)))
      })
      .catch(() => {
        if (!active) return
        setComfyUiCapabilities({
          available: false,
          checkpoints: [],
          samplers: [],
          schedulers: [],
          workflows: []
        })
      })
    return () => { active = false }
  }, [isContinueEdit, state.comfyUiWorkflowBindings, state.sessionId])

  function selectImageModel(next: ImageModelSelection): void {
    const definition = getImageModelDefinition(next)
    if (isContinueEdit && !supportsImageGeneration(next, 'reference')) return
    setImageModel(next)
    if (isContinueEdit) {
      setImageGeneration('reference')
    } else if (!supportsImageGeneration(next, imageGeneration) ||
      (imageGeneration === 'inpaint' && doodleStrokesRef.current.length === 0)) {
      const fallback = firstSelectableImageGeneration(
        next,
        doodleStrokesRef.current.length > 0
      )
      setImageGeneration(fallback)
      setMessage(fallback === 'inpaint'
        ? msg('{0} 仅支持局部重绘；请先涂画 mask。', definition.label)
        : msg('{0} 不支持当前模式，已切换为{1}。', definition.label, msg(IMAGE_GENERATION_LABELS[fallback])))
    }
    if (isComfyUiWorkflowSelection(next)) {
      setTransparentBackground(next.transparentOutput)
      const binding = state.comfyUiWorkflowBindings.find((candidate) =>
        candidate.workflowPath === next.workflowPath)
      if (!binding?.seed) setComfyUiWorkflowSeed(undefined)
    } else if (!definition.supportsTransparency) {
      setTransparentBackground(false)
    }
    if (definition.promptLanguage === 'en' && promptProcessing !== 'direct') {
      setPromptLanguage('en')
    }
  }

  function selectPromptProcessing(next: PromptProcessing): void {
    setPromptProcessing(next)
    if (requiresEnglish && next !== 'direct') setPromptLanguage('en')
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code === 'Space') {
        if (isLocked || !interaction || interaction.operation !== 'draw' ||
          (interaction.kind !== 'context' && interaction.kind !== 'output')) return
        event.preventDefault()
        if (event.repeat) return

        const bounds = interaction.kind === 'context' ? displayBounds : contextRect
        if (!bounds) return
        const currentPoint = currentPointerRef.current ?? interaction.start
        const currentCycle = drawAspectCycleRef.current
        let nextCycle: DrawAspectCycle | undefined
        if (!currentCycle) {
          const freeRect = normalizeRect(interaction.start, currentPoint)
          nextCycle = { order: aspectRatioCycleOrder(freeRect), index: 0 }
        } else if (currentCycle.index + 1 < currentCycle.order.length) {
          nextCycle = { ...currentCycle, index: currentCycle.index + 1 }
        } else {
          nextCycle = undefined
        }

        drawAspectCycleRef.current = nextCycle
        const aspectRatio = selectedAspectRatio(nextCycle)
        const nextRect = aspectRatio
          ? anchoredAspectRect(
              interaction.start,
              currentPoint,
              bounds,
              aspectRatio.value
            )
          : clampRect(normalizeRect(interaction.start, currentPoint), bounds)
        if (interaction.kind === 'context') {
          setContextRect(nextRect)
          setContextAspectRatio(aspectRatio)
        } else {
          setOutputRect(nextRect)
          setOutputAspectRatio(aspectRatio)
          if (interaction.dependentDoodleStrokes) {
            const clamped = clampDoodleStrokesToRect(
              interaction.dependentDoodleStrokes,
              nextRect
            )
            doodleStrokesRef.current = clamped
            setDoodleStrokes(clamped)
          }
        }
        return
      }

      if (event.key !== 'Escape') return
      event.preventDefault()
      currentPointerRef.current = undefined
      drawAspectCycleRef.current = undefined
      setInteraction(undefined)

      if (doodleStrokesRef.current.length > 0) {
        doodleStrokesRef.current = []
        setDoodleStrokes([])
        if (imageGeneration === 'inpaint') {
          const fallback = getImageModelDefinition(imageModel).generationModes.find((mode) =>
            mode !== 'inpaint')
          if (fallback) {
            setImageGeneration(fallback)
            setMessage(msg('涂鸦 mask 已清空，已切换为{0}。', msg(IMAGE_GENERATION_LABELS[fallback])))
          } else {
            setMessage('涂鸦 mask 已清空；重新涂鸦后才能提交局部重绘。')
          }
        } else {
          setMessage(msg('在{0}内涂画局部重绘 mask', msg(outputRect ? '红框' : '绿框')))
        }
        return
      }
      if (referenceRects.length > 0) {
        setReferenceRects(referenceRects.slice(0, -1))
        setMessage(referenceRects.length > 1
          ? '已撤销最后一个参考图区域。'
          : '可直接提交，或拖动框选蓝色参考图区域')
        return
      }
      if (outputRect) {
        setShowCurrentImage(false)
        setOutputRect(undefined)
        setOutputAspectRatio(undefined)
        setMessage('可直接提交，或拖动框选红色生成区域')
        return
      }
      if (contextRect) {
        setShowCurrentImage(false)
        setContextRect(undefined)
        setOutputRect(undefined)
        setReferenceRects([])
        setContextAspectRatio(undefined)
        setOutputAspectRatio(undefined)
        setMessage('拖动选择绿色上下文区域')
        return
      }

      void window.artCreator.capture.cancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    contextRect,
    displayBounds,
    imageGeneration,
    imageModel,
    interaction,
    isLocked,
    outputRect,
    referenceRects
  ])

  function setActiveInteraction(next: Interaction | undefined): void {
    currentPointerRef.current = next?.start
    drawAspectCycleRef.current = undefined
    setInteraction(next)
  }

  function beginDraw(event: PointerEvent<HTMLDivElement>): void {
    if (isLocked || markMode !== 'rectangle' || event.currentTarget !== event.target) return
    const point = pointFromEvent(event)
    void window.artCreator.capture.activate()

    if (!contextRect) {
      event.currentTarget.setPointerCapture(event.pointerId)
      setContextAspectRatio(undefined)
      setActiveInteraction({ kind: 'context', operation: 'draw', start: point })
      setContextRect({ x: point.x, y: point.y, width: 1, height: 1 })
      return
    }

    if (outputRect && (referenceRects.length === 0 || canAddReference)) {
      beginSelectionDraw(event, 'reference')
    }
  }

  function beginSelectionDraw(
    event: PointerEvent,
    kind: Extract<SelectionKind, 'output' | 'reference'>,
    referenceIndex = referenceRects.length
  ): void {
    if (!contextRect || isLocked) return
    event.stopPropagation()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    const point = pointFromEvent(event)
    if (kind === 'output') setOutputAspectRatio(undefined)
    setActiveInteraction({
      kind,
      operation: 'draw',
      start: point,
      ...(kind === 'reference' ? { referenceIndex } : {}),
      ...(kind === 'output' && doodleStrokesRef.current.length > 0
        ? {
            dependentDoodleStrokes: doodleStrokesRef.current.map((stroke) =>
              stroke.map((strokePoint) => ({ ...strokePoint })))
          }
        : {})
    })
    const initial = { x: point.x, y: point.y, width: 1, height: 1 }
    if (kind === 'output') setOutputRect(initial)
    else setReferenceRects((current) => {
      const next = [...current]
      next[referenceIndex] = initial
      return next
    })
  }

  function commitDoodleStrokes(next: PointDip[][], bounds = resolvedOutputRect): void {
    const clamped = bounds ? clampDoodleStrokesToRect(next, bounds) : next
    doodleStrokesRef.current = clamped
    setDoodleStrokes(clamped)
  }

  function beginDoodleDraw(event: PointerEvent<SVGSVGElement>): void {
    if (!resolvedOutputRect || markMode !== 'doodle' || isLocked) return
    if (doodleStrokesRef.current.length >= 64) {
      setMessage('涂鸦笔画已达到上限，请切换标记模式后重新标记')
      return
    }
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = clampPoint(pointFromEvent(event), resolvedOutputRect)
    const next = [...doodleStrokesRef.current, [point]]
    commitDoodleStrokes(next)
    setActiveInteraction({
      kind: 'doodle',
      operation: 'draw',
      start: point,
      strokeIndex: next.length - 1
    })
  }

  function selectMarkMode(nextMode: MarkMode): void {
    if (nextMode === markMode) return
    setActiveInteraction(undefined)
    setMarkMode(nextMode)
    setMessage(nextMode === 'rectangle'
      ? !outputRect
        ? '可直接提交，或拖动框选红色生成区域'
        : referenceRects.length === 0
          ? '可直接提交，或拖动框选蓝色参考图区域'
          : canAddReference
            ? imageGeneration === 'reference'
              ? '可在空白处拖动，按顺序框选下一张蓝色参考图。'
              : '切换到参考生成后，可继续按顺序框选蓝色参考图。'
            : '参考图区域已达上限，可继续调整或确认生成。'
      : msg('在{0}内涂画局部重绘 mask', msg(outputRect ? '红框' : '绿框')))
  }

  function beginMove(event: PointerEvent, kind: SelectionKind, rect: RectDip): void {
    if (isLocked) return
    event.stopPropagation()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    const point = pointFromEvent(event)
    setActiveInteraction({
      kind,
      operation: 'move',
      start: point,
      initial: rect,
      ...(kind === 'reference'
        ? { referenceIndex: referenceRects.indexOf(rect) }
        : {}),
      ...(kind === 'context' && outputRect ? { dependentOutput: { ...outputRect } } : {}),
      ...(doodleStrokesRef.current.length > 0
        ? {
            dependentDoodleStrokes: doodleStrokesRef.current.map((stroke) =>
              stroke.map((point) => ({ ...point })))
          }
        : {})
    })
  }

  function beginResize(
    event: PointerEvent,
    kind: SelectionKind,
    handle: ResizeHandle,
    referenceIndex?: number
  ): void {
    const rect = kind === 'context'
      ? contextRect
      : kind === 'output'
        ? outputRect
        : kind === 'reference'
          ? referenceRects[referenceIndex ?? 0]
          : undefined
    if (!rect || isLocked) return
    event.stopPropagation()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    const point = pointFromEvent(event)
    setActiveInteraction({
      kind,
      operation: 'resize',
      start: point,
      initial: rect,
      handle,
      ...(kind === 'reference' ? { referenceIndex } : {}),
      ...(kind === 'context' && outputRect ? { dependentOutput: { ...outputRect } } : {}),
      ...(doodleStrokesRef.current.length > 0
        ? {
            dependentDoodleStrokes: doodleStrokesRef.current.map((stroke) =>
              stroke.map((point) => ({ ...point })))
          }
        : {})
    })
  }

  function updateInteraction(event: PointerEvent<HTMLDivElement>): void {
    if (!interaction) return
    const point = pointFromEvent(event)
    currentPointerRef.current = point

    if (interaction.kind === 'doodle') {
      if (!resolvedOutputRect || interaction.strokeIndex === undefined) return
      const strokes = doodleStrokesRef.current
      const stroke = strokes[interaction.strokeIndex]
      if (!stroke || stroke.length >= 2_048) return
      const pointCount = strokes.reduce((total, current) => total + current.length, 0)
      if (pointCount >= 4_096) return
      const nextPoint = clampPoint(point, resolvedOutputRect)
      const previous = stroke[stroke.length - 1]!
      if (Math.hypot(nextPoint.x - previous.x, nextPoint.y - previous.y) < 1.5) return
      const next = [...strokes]
      next[interaction.strokeIndex] = [...stroke, nextPoint]
      commitDoodleStrokes(next)
      return
    }

    if (interaction.operation === 'draw') {
      const bounds = interaction.kind === 'output' ? contextRect : displayBounds
      if (!bounds) return
      const aspectRatio = selectedAspectRatio(drawAspectCycleRef.current)
      const nextRect = aspectRatio
        ? anchoredAspectRect(
            interaction.start,
            point,
            bounds,
            aspectRatio.value
          )
        : clampRect(normalizeRect(interaction.start, point), bounds)
      if (interaction.kind === 'context') {
        setContextRect(nextRect)
      } else if (interaction.kind === 'output') {
        const nextOutput = nextRect
        setOutputRect(nextOutput)
        if (interaction.dependentDoodleStrokes) {
          commitDoodleStrokes(interaction.dependentDoodleStrokes, nextOutput)
        }
      } else {
        setReferenceRects((current) => current.map((rect, index) =>
          index === interaction.referenceIndex ? nextRect : rect))
      }
      return
    }

    if (!interaction.initial) return
    if (interaction.operation === 'move') {
      const moved = {
        ...interaction.initial,
        x: interaction.initial.x + point.x - interaction.start.x,
        y: interaction.initial.y + point.y - interaction.start.y
      }
      const bounds = interaction.kind === 'context'
        ? displayBounds
        : interaction.kind === 'output'
          ? contextRect
          : displayBounds
      if (!bounds) return
      const clamped = clampRect(moved, bounds)
      if (interaction.kind === 'context') {
        const delta = {
          x: clamped.x - interaction.initial.x,
          y: clamped.y - interaction.initial.y
        }
        setContextRect(clamped)
        const nextOutput = interaction.dependentOutput
          ? translateRect(interaction.dependentOutput, delta)
          : undefined
        if (interaction.dependentDoodleStrokes) {
          commitDoodleStrokes(
            translateDoodleStrokes(interaction.dependentDoodleStrokes, delta),
            nextOutput ?? clamped
          )
        }
        if (nextOutput) setOutputRect(nextOutput)
      } else if (interaction.kind === 'output') {
        const delta = {
          x: clamped.x - interaction.initial.x,
          y: clamped.y - interaction.initial.y
        }
        setOutputRect(clamped)
        if (interaction.dependentDoodleStrokes) {
          commitDoodleStrokes(
            translateDoodleStrokes(interaction.dependentDoodleStrokes, delta),
            clamped
          )
        }
      } else {
        setReferenceRects((current) => current.map((rect, index) =>
          index === interaction.referenceIndex ? clamped : rect))
      }
      return
    }

    if (!interaction.handle) return
    const bounds = interaction.kind === 'context'
      ? displayBounds
      : interaction.kind === 'output'
        ? contextRect
        : displayBounds
    if (!bounds) return
    const resized = resizeRect(
      interaction.initial,
      interaction.handle,
      point,
      bounds,
      interaction.kind === 'context' ? MIN_CONTEXT_SIZE : MIN_TARGET_SIZE
    )
    const sizeChanged = resized.width !== interaction.initial.width ||
      resized.height !== interaction.initial.height
    if (interaction.kind === 'context') {
      setContextRect(resized)
      if (sizeChanged) setContextAspectRatio(undefined)
      const nextOutput = interaction.dependentOutput
        ? clampRect(interaction.dependentOutput, resized)
        : undefined
      if (nextOutput) {
        setOutputRect(nextOutput)
        if (interaction.dependentOutput &&
          (nextOutput.width !== interaction.dependentOutput.width ||
            nextOutput.height !== interaction.dependentOutput.height)) {
          setOutputAspectRatio(undefined)
        }
      }
      if (interaction.dependentDoodleStrokes) {
        commitDoodleStrokes(
          clampDoodleStrokesToRect(
            interaction.dependentDoodleStrokes,
            nextOutput ?? resized
          ),
          nextOutput ?? resized
        )
      }
    } else if (interaction.kind === 'output') {
      setOutputRect(resized)
      if (sizeChanged) setOutputAspectRatio(undefined)
      if (interaction.dependentDoodleStrokes) {
        commitDoodleStrokes(
          clampDoodleStrokesToRect(interaction.dependentDoodleStrokes, resized),
          resized
        )
      }
    } else {
      setReferenceRects((current) => current.map((rect, index) =>
        index === interaction.referenceIndex ? resized : rect))
    }
  }

  function endInteraction(): void {
    if (!interaction) return
    if (interaction.kind === 'doodle') {
      setMessage(doodleStrokesRef.current.length > 0
        ? '可继续涂画局部重绘 mask，或输入素材说明后确认生成'
        : msg('在{0}内涂画局部重绘 mask', msg(outputRect ? '红框' : '绿框')))
      setActiveInteraction(undefined)
      return
    }
    if (interaction.kind === 'context' && contextRect) {
      if (contextRect.width < MIN_CONTEXT_SIZE || contextRect.height < MIN_CONTEXT_SIZE) {
        setContextRect(undefined)
        setContextAspectRatio(undefined)
        setMessage('外层区域至少需要 48 × 48 DIP，请重新选择')
      } else if (!outputRect) {
        setMessage('可直接提交，或拖动框选红色生成区域')
      }
    }
    if (interaction.kind === 'output' && outputRect) {
      if (outputRect.width < MIN_TARGET_SIZE || outputRect.height < MIN_TARGET_SIZE) {
        setOutputRect(undefined)
        setOutputAspectRatio(undefined)
        setMessage('生成区域至少需要 24 × 24 DIP，请重新选择')
      } else {
        setMessage('可直接提交，或拖动空白处框选蓝色参考图')
      }
    }
    const currentReferenceRect = interaction.kind === 'reference'
      ? referenceRects[interaction.referenceIndex ?? 0]
      : undefined
    if (interaction.kind === 'reference' && currentReferenceRect) {
      if (currentReferenceRect.width < MIN_TARGET_SIZE ||
        currentReferenceRect.height < MIN_TARGET_SIZE) {
        setReferenceRects((current) => current.filter((_, index) =>
          index !== interaction.referenceIndex))
        setMessage('参考图区域至少需要 24 × 24 DIP，请重新选择')
      } else if (interaction.operation === 'draw' && !referenceModelReady) {
        setMessage('当前模型不支持参考生成，请更换模型或撤销蓝色参考框后提交。')
      } else if (interaction.operation === 'draw' && imageGeneration !== 'reference') {
        setImageGeneration('reference')
        setMessage('已切换为参考生成；可继续框选参考图或手动调整生图模式。')
      } else {
        setMessage(canAddReference
          ? '可在空白处拖动，按顺序框选下一张蓝色参考图。'
          : '参考图区域已就绪，输入素材说明后确认生成')
      }
    }
    setActiveInteraction(undefined)
  }

  async function submit(mode: CaptureSubmissionMode): Promise<void> {
    if (!contextRect || !instruction.trim() || !inpaintReady || !referenceModelReady ||
      !liblibOptionsValid || !comfyUiOptionsValid) return
    if (workflowSelection && !selectedWorkflowBinding) return
    setSubmittingMode(mode)
    setMessage('正在提交选区…')
    try {
      await window.artCreator.capture.submit({
        displayId: state.displayId,
        contextRectDip: contextRect,
        ...(outputRect ? { outputRectDip: outputRect } : {}),
        ...(referenceRects.length > 0 ? { referenceRectsDip: referenceRects } : {}),
        ...(doodleStrokes.length > 0
          ? {
              doodleStrokesDip: doodleStrokes
            }
          : {}),
        scaleFactor: state.scaleFactor,
        instruction: instruction.trim(),
        promptProcessing,
        promptLanguage,
        imageModel,
        imageGeneration: isContinueEdit ? 'reference' : imageGeneration,
        generationCount,
        ...(imageModel.provider === 'liblib' && imageModel.model === 'star-3-alpha'
          ? { liblibGenerationOptions }
          : {}),
        ...(imageModel.provider === 'comfyui' && !workflowSelection
          ? { comfyUiGenerationOptions }
          : {}),
        ...(workflowSelection && selectedWorkflowBinding
          ? {
              comfyUiWorkflowBinding: selectedWorkflowBinding,
              ...(comfyUiWorkflowSeed !== undefined ? { comfyUiWorkflowSeed } : {})
            }
          : {}),
        ...(imageModel.provider === 'liblib' ? { confirmBeforeGeneration } : {}),
        transparentBackground
      }, mode)
    } catch (error) {
      setSubmittingMode(undefined)
      setMessage(localizedError(error, '提交失败。'))
    }
  }

  return (
    <main
      className="capture-shell"
      onPointerDown={beginDraw}
      onPointerMove={updateInteraction}
      onPointerUp={endInteraction}
      onPointerCancel={endInteraction}
    >
      <img className="capture-image" src={screenshotUrl} alt={t('冻结的屏幕画面')} draggable={false} />
      <div className="capture-shade" />

      {contextRect && (
        <div
          className="selection-fill context-selection-fill"
          style={{
            ...rectStyle(contextRect),
            backgroundImage: `url(${screenshotUrl})`,
            backgroundPosition: `${-contextRect.x}px ${-contextRect.y}px`,
            backgroundSize: `${displayBounds.width}px ${displayBounds.height}px`
          }}
        />
      )}
      {showCurrentImage && currentImageUrl && resolvedOutputRect && (
        <img
          className="reconfigure-current-image"
          src={currentImageUrl}
          alt={t('悬浮窗当前图片')}
          style={rectStyle(resolvedOutputRect)}
          draggable={false}
        />
      )}
      {outputRect && <div className="selection-fill output-selection-fill" style={rectStyle(outputRect)} />}
      {referenceRects.map((rect, index) => (
        <div
          key={`reference-fill-${index}`}
          className="selection-fill reference-selection-fill"
          style={{
            ...rectStyle(rect),
            backgroundImage: `url(${screenshotUrl})`,
            backgroundPosition: `${-rect.x}px ${-rect.y}px`,
            backgroundSize: `${displayBounds.width}px ${displayBounds.height}px`
          }}
        />
      ))}

      {contextRect && (
        <div
          className="context-selection"
          style={rectStyle(contextRect)}
          onPointerDown={(event) => {
            if (markMode !== 'rectangle') return
            if (!outputRect) beginSelectionDraw(event, 'output')
            else if (referenceRects.length === 0) beginSelectionDraw(event, 'reference')
            else beginMove(event, 'context', contextRect)
          }}
        >
          <span className="selection-label context-label">
            {outputRect ? t('上下文') : t('生成区域 / 上下文 / 默认参考')}
          </span>
          <ResizeHandles kind="context" onStart={beginResize} />
          <nav
            className="mark-mode-toolbar"
            style={markModeToolbarStyle(contextRect, displayBounds)}
            aria-label={t('标记模式')}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <span className="mark-mode-title">{t('可选')}</span>
            <button
              type="button"
              className={markMode === 'rectangle' ? 'active' : ''}
              aria-pressed={markMode === 'rectangle'}
              onClick={() => selectMarkMode('rectangle')}
            >{t('框选')}</button>
            <button
              type="button"
              className={markMode === 'doodle' ? 'active' : ''}
              aria-pressed={markMode === 'doodle'}
              onClick={() => selectMarkMode('doodle')}
            >{t('涂鸦')}</button>
          </nav>
        </div>
      )}

      {outputRect && (
        <div
          className="output-selection"
          style={rectStyle(outputRect)}
          onPointerDown={(event) => {
            if (markMode !== 'rectangle') return
            if (referenceRects.length === 0) beginSelectionDraw(event, 'reference')
            else beginMove(event, 'output', outputRect)
          }}
        >
          <span className="selection-label output-label">{t('生成区域')}</span>
          <ResizeHandles kind="output" onStart={beginResize} />
        </div>
      )}

      {resolvedOutputRect && (
        <span
          className={`selection-size ${outputRect ? 'output-size' : 'context-size'}`}
          style={{
            left: resolvedOutputRect.x + resolvedOutputRect.width,
            top: resolvedOutputRect.y + resolvedOutputRect.height
          }}
          aria-label={t('生图尺寸 {0} DIP{1}', rectSizeLabel(resolvedOutputRect), resolvedOutputAspectRatio ? t('，比例 {0}', resolvedOutputAspectRatio.label) : '')}
        >
          {rectSizeLabel(resolvedOutputRect, resolvedOutputAspectRatio)}
        </span>
      )}

      {referenceRects.map((rect, index) => (
        <div
          key={`reference-${index}`}
          className="reference-selection"
          style={rectStyle(rect)}
          onPointerDown={(event) => {
            if (markMode === 'rectangle') beginMove(event, 'reference', rect)
          }}
        >
          <span className="selection-label reference-label">
            {t('参考图')}{isContinueEdit ? index + 2 : index + 1}
          </span>
          <ResizeHandles kind="reference" referenceIndex={index} onStart={beginResize} />
        </div>
      ))}

      {resolvedOutputRect && (markMode === 'doodle' || doodleStrokes.length > 0) && (
        <svg
          className={`doodle-surface ${markMode === 'doodle' ? 'active' : ''}`}
          style={rectStyle(resolvedOutputRect)}
          width={resolvedOutputRect.width}
          height={resolvedOutputRect.height}
          aria-label={t('涂鸦标记画布')}
          onPointerDown={markMode === 'doodle' ? beginDoodleDraw : undefined}
        >
          {doodleStrokes.map((stroke, index) => (
            <path
              key={index}
              d={doodlePath(stroke, resolvedOutputRect)}
              strokeWidth={CAPTURE_DOODLE_STROKE_WIDTH_DIP}
            />
          ))}
        </svg>
      )}

      <div className="capture-hint">{t(message)}</div>

      {contextRect && !(interaction?.kind === 'context' && interaction.operation === 'draw') && (
        <section className="capture-toolbar" onPointerDown={(event) => event.stopPropagation()}>
          <input
            className="instruction-input"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            maxLength={500}
            placeholder={t('描述目标素材，例如：排行榜')}
            autoFocus
          />
          <div className="phase-controls">
            <fieldset className="phase-control">
              <legend>{t('提示词处理')}</legend>
              <div className="prompt-processing-options">
                <div className="mode-switch">
                  <button
                    className={promptProcessing === 'direct' ? 'active' : ''}
                    onClick={() => selectPromptProcessing('direct')}
                  >{t('直接使用')}</button>
                  <button
                    className={promptProcessing === 'polish' ? 'active' : ''}
                    onClick={() => selectPromptProcessing('polish')}
                  >{t('AI 润色（仅提示词）')}</button>
                  <button
                    className={promptProcessing === 'polish_with_selection' ? 'active' : ''}
                    onClick={() => selectPromptProcessing('polish_with_selection')}
                  >{t('AI 润色（提示词 + 带生成区域标记的上下文截图）')}</button>
                </div>
                {promptProcessing !== 'direct' && (
                  <label className="prompt-language-control">
                    <span>{t('润色后提示词语言')}</span>
                    <select
                      aria-label={t('AI 润色后提示词语言')}
                      value={promptLanguage}
                      onChange={(event) => setPromptLanguage(event.target.value as PromptLanguage)}
                      disabled={requiresEnglish}
                    >
                      <option value="en">{t('英文')}</option>
                      <option value="zh">{t('中文')}</option>
                    </select>
                  </label>
                )}
              </div>
            </fieldset>
            <fieldset className="phase-control">
              <legend>{t('图片生成')}</legend>
              <div className="image-model-controls">
                <label>
                  <span>{t('生图方案')}</span>
                  <select
                    aria-label={t('生图方案')}
                    value={imageModel.provider}
                    onChange={(event) => {
                      const provider = event.target.value as ImageProvider
                      const candidates = provider === 'comfyui'
                        ? comfyUiProviderModels
                        : imageModelsForProvider(provider)
                      const first = candidates.find((definition) =>
                        !isContinueEdit || supportsImageGeneration(
                          definition.selection,
                          'reference'
                        ))?.selection
                      if (first) selectImageModel(first)
                    }}
                  >
                    {IMAGE_PROVIDERS.map((provider) => (
                      <option
                        key={provider.id}
                        value={provider.id}
                        disabled={provider.id === 'comfyui'
                          ? !comfyUiCapabilities?.available ||
                            !comfyUiProviderModels.some((definition) => !isContinueEdit ||
                              supportsImageGeneration(definition.selection, 'reference'))
                          : !imageModelsForProvider(provider.id).some((definition) =>
                              !isContinueEdit ||
                              supportsImageGeneration(definition.selection, 'reference'))}
                      >
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t('模型')}</span>
                  <select
                    aria-label={t('生图模型')}
                    value={imageModelOptionValue(imageModel)}
                    onChange={(event) => {
                      const selected = providerModels.find(
                        (candidate) => imageModelOptionValue(candidate.selection) === event.target.value
                      )
                      if (selected) selectImageModel(selected.selection)
                    }}
                  >
                    {providerModels.map((definition) => (
                      <option
                        key={imageModelKey(definition.selection)}
                        value={imageModelOptionValue(definition.selection)}
                        disabled={isContinueEdit &&
                          !supportsImageGeneration(definition.selection, 'reference')}
                      >
                        {isComfyUiWorkflowSelection(definition.selection)
                          ? t('工作流 · {0}', definition.label)
                          : definition.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="generation-count-control">
                <span>{t('生图数量')}</span>
                <select
                  aria-label={t('生图数量')}
                  value={generationCount}
                  onChange={(event) => setGenerationCount(Number(event.target.value))}
                >
                  {Array.from({ length: MAX_GENERATION_COUNT }, (_, index) => (
                    <option key={index + 1} value={index + 1}>{index + 1} {t(' 张')}</option>
                  ))}
                </select>
              </label>
              <div className="mode-switch">
                <button
                  className={imageGeneration === 'generate' ? 'active' : ''}
                  disabled={isContinueEdit || !supportsImageGeneration(imageModel, 'generate')}
                  onClick={() => setImageGeneration('generate')}
                >{t('从零生成')}</button>
                <button
                  className={imageGeneration === 'reference' ? 'active' : ''}
                  disabled={isContinueEdit || !supportsImageGeneration(imageModel, 'reference')}
                  onClick={() => setImageGeneration('reference')}
                >{t('参考生成')}</button>
                <button
                  className={imageGeneration === 'inpaint' ? 'active' : ''}
                  disabled={isContinueEdit || !hasDoodleMask ||
                    !supportsImageGeneration(imageModel, 'inpaint')}
                  onClick={() => setImageGeneration('inpaint')}
                >{t('局部重绘')}</button>
              </div>
              {isContinueEdit && (
                <small className="model-language-note">{t('继续编辑固定使用参考生成。')}</small>
              )}
              {!referenceModelReady && (
                <small className="liblib-options-error" role="alert">
                  {t('当前模型不支持参考生成，请更换模型或撤销蓝色参考框后提交。')}</small>
              )}
              {requiresEnglish && promptProcessing === 'direct' && (
                <small className="model-language-note">{t('该模型要求直接提示词使用英文。')}</small>
              )}
              <small className="model-language-note">
                {comfyUiCapabilities === undefined
                  ? t('正在读取本地 ComfyUI 能力；这不会阻塞冻结画面。')
                  : comfyUiCapabilities.available
                    ? t('ComfyUI 在线：{0} 个 checkpoint，', comfyUiCapabilities.checkpoints.length) +
                      t('{0} 个已绑定工作流。', configuredWorkflowModels.length)
                    : t('ComfyUI 离线或没有可执行方案；其它供应商仍可使用。')}
              </small>
              {imageModel.provider === 'liblib' && (
                <div className="liblib-generation-options">
                  {imageModel.model === 'star-3-alpha' && (
                    <>
                      <label className="capture-checkbox">
                        <input
                          type="checkbox"
                          checked={liblibGenerationOptions.promptMagic}
                          onChange={(event) => setLiblibGenerationOptions((current) => ({
                            ...current,
                            promptMagic: event.target.checked
                          }))}
                        />
                        <span>{t('提示词智能优化')}</span>
                      </label>
                      <label className="liblib-number-option">
                        <span>{t('采样步数')}</span>
                        <input
                          aria-label={t('Star-3 采样步数')}
                          type="number"
                          min={1}
                          max={100}
                          value={liblibGenerationOptions.steps}
                          onChange={(event) => setLiblibGenerationOptions((current) => ({
                            ...current,
                            steps: Number(event.target.value)
                          }))}
                        />
                      </label>
                      {imageGeneration === 'reference' && (
                        <label className="liblib-number-option">
                          <span>{t('去噪强度')}</span>
                          <input
                            aria-label={t('Star-3 去噪强度')}
                            type="number"
                            min={0}
                            max={1}
                            step={0.05}
                            value={liblibGenerationOptions.denoisingStrength}
                            onChange={(event) => setLiblibGenerationOptions((current) => ({
                              ...current,
                              denoisingStrength: Number(event.target.value)
                            }))}
                          />
                        </label>
                      )}
                    </>
                  )}
                  <label className="capture-checkbox confirmation-option">
                    <input
                      type="checkbox"
                      checked={confirmBeforeGeneration}
                      onChange={(event) => setConfirmBeforeGeneration(event.target.checked)}
                    />
                    <span>{t('生成前确认')}</span>
                  </label>
                  {!liblibOptionsValid && (
                    <small className="liblib-options-error">{t('请输入有效的 Star-3 参数。')}</small>
                  )}
                </div>
              )}
              {imageModel.provider === 'comfyui' && !workflowSelection && comfyUiCapabilities?.available && (
                <div className="liblib-generation-options" aria-label={t('ComfyUI 生成参数')}>
                  <label className="liblib-number-option">
                    <span>{t('采样器')}</span>
                    <select
                      aria-label={t('ComfyUI 采样器')}
                      value={comfyUiGenerationOptions.samplerName}
                      onChange={(event) => setComfyUiGenerationOptions((current) => ({
                        ...current,
                        samplerName: event.target.value
                      }))}
                    >
                      {comfyUiCapabilities.samplers.map((sampler) => (
                        <option key={sampler} value={sampler}>{sampler}</option>
                      ))}
                    </select>
                  </label>
                  <label className="liblib-number-option">
                    <span>{t('调度器')}</span>
                    <select
                      aria-label={t('ComfyUI 调度器')}
                      value={comfyUiGenerationOptions.scheduler}
                      onChange={(event) => setComfyUiGenerationOptions((current) => ({
                        ...current,
                        scheduler: event.target.value
                      }))}
                    >
                      {comfyUiCapabilities.schedulers.map((scheduler) => (
                        <option key={scheduler} value={scheduler}>{scheduler}</option>
                      ))}
                    </select>
                  </label>
                  <label className="liblib-number-option">
                    <span>{t('采样步数')}</span>
                    <input
                      aria-label={t('ComfyUI 采样步数')}
                      type="number"
                      min={1}
                      max={100}
                      value={comfyUiGenerationOptions.steps}
                      onChange={(event) => setComfyUiGenerationOptions((current) => ({
                        ...current,
                        steps: Number(event.target.value)
                      }))}
                    />
                  </label>
                  <label className="liblib-number-option">
                    <span>CFG</span>
                    <input
                      aria-label="ComfyUI CFG"
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      value={comfyUiGenerationOptions.cfg}
                      onChange={(event) => setComfyUiGenerationOptions((current) => ({
                        ...current,
                        cfg: Number(event.target.value)
                      }))}
                    />
                  </label>
                  <label className="liblib-number-option">
                    <span>{t('去噪强度')}</span>
                    <input
                      aria-label={t('ComfyUI 去噪强度')}
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={comfyUiGenerationOptions.denoisingStrength}
                      onChange={(event) => setComfyUiGenerationOptions((current) => ({
                        ...current,
                        denoisingStrength: Number(event.target.value)
                      }))}
                    />
                  </label>
                  <label className="liblib-number-option">
                    <span>{t('Seed（留空随机）')}</span>
                    <input
                      aria-label="ComfyUI Seed"
                      type="number"
                      min={0}
                      max={Number.MAX_SAFE_INTEGER}
                      step={1}
                      value={comfyUiGenerationOptions.seed ?? ''}
                      onChange={(event) => setComfyUiGenerationOptions((current) => {
                        if (!event.target.value) {
                          const withoutSeed = { ...current }
                          delete withoutSeed.seed
                          return withoutSeed
                        }
                        return { ...current, seed: Number(event.target.value) }
                      })}
                    />
                  </label>
                  {!comfyUiOptionsValid && (
                    <small className="liblib-options-error">{t('请输入服务支持的有效 ComfyUI 参数。')}</small>
                  )}
                </div>
              )}
              {workflowSelection && selectedWorkflowBinding && (
                <div className="liblib-generation-options" aria-label={t('ComfyUI 工作流参数')}>
                  <small className="workflow-owned-note">
                    {t('直接执行已保存工作流；模型、采样器、步数和 CFG 使用工作流中的值。')}</small>
                  {selectedWorkflowBinding.seed && (
                    <label className="liblib-number-option">
                      <span>{t('Seed（留空随机）')}</span>
                      <input
                        aria-label={t('ComfyUI 工作流 Seed')}
                        type="number"
                        min={0}
                        max={Number.MAX_SAFE_INTEGER}
                        step={1}
                        value={comfyUiWorkflowSeed ?? ''}
                        onChange={(event) => setComfyUiWorkflowSeed(
                          event.target.value ? Number(event.target.value) : undefined
                        )}
                      />
                    </label>
                  )}
                </div>
              )}
            </fieldset>
          </div>
          <div className="capture-options">
            <label
              className="capture-checkbox"
              title={workflowSelection
                ? t('透明背景由当前工作流绑定决定')
                : t('需要图片服务支持透明背景输出')}
            >
              <input
                type="checkbox"
                checked={transparentBackground}
                onChange={(event) => setTransparentBackground(event.target.checked)}
                disabled={Boolean(workflowSelection) || !modelDefinition.supportsTransparency}
              />
              <span>{workflowSelection ? t('透明背景（工作流决定）') : t('透明背景（实验）')}</span>
            </label>
          </div>
          <div className="toolbar-actions">
            <button className="cancel-button" onClick={() => void window.artCreator.capture.cancel()}>{t('取消')}</button>
            {state.canFakeGenerate && (
              <button
                className="fake-generation-button"
                disabled={Boolean(submittingMode) || !instruction.trim() ||
                  !inpaintReady || !referenceModelReady || !liblibOptionsValid || !comfyUiOptionsValid}
                onClick={() => void submit('fake')}
                title={t('仅开发环境：模拟生成阶段并将生成区域截图作为结果')}
              >
                {submittingMode === 'fake' ? t('假生成中…') : t('假生成')}
              </button>
            )}
            <button
              disabled={Boolean(submittingMode) || !instruction.trim() ||
                !inpaintReady || !referenceModelReady || !liblibOptionsValid || !comfyUiOptionsValid}
              onClick={() => void submit('generate')}
            >
              {submittingMode === 'generate' ? t('提交中…') : t('确认生成')}
            </button>
          </div>
        </section>
      )}

      {isLocked && (
        <div className="capture-locked">
          <strong>{t('已在另一块显示器开始选择')}</strong>
          <span>{t('本次会话只支持单屏单目标，按 Esc 可逐步撤销，全部撤销后关闭。')}</span>
        </div>
      )}
    </main>
  )
}

interface PreparedOverlaySession {
  state: OverlayViewState
  screenshotUrl: string
  currentImageUrl?: string
}

export function CaptureOverlay(): React.JSX.Element {
  useLanguage()
  const [prepared, setPrepared] = useState<PreparedOverlaySession>()
  const [message, setMessage] = useState<LocalizedText>('截屏浮层已就绪')
  const objectUrl = useRef<string | undefined>(undefined)
  const currentImageObjectUrl = useRef<string | undefined>(undefined)
  const sessionId = useRef<string | undefined>(undefined)
  const preparationToken = useRef(0)

  useEffect(() => {
    let disposed = false

    const releaseObjectUrl = (): void => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
      if (currentImageObjectUrl.current) URL.revokeObjectURL(currentImageObjectUrl.current)
      objectUrl.current = undefined
      currentImageObjectUrl.current = undefined
    }

    const prepareSession = async (next: CaptureOverlaySession): Promise<void> => {
      const token = ++preparationToken.current
      setMessage('正在加载冻结画面…')

      const imageUrl = async (source: Uint8Array): Promise<string> => {
        const bytes = new Uint8Array(source.byteLength)
        bytes.set(source)
        const url = URL.createObjectURL(new Blob([bytes.buffer], { type: 'image/png' }))
        const image = new Image()
        image.src = url
        try {
          await image.decode()
          return url
        } catch (error) {
          URL.revokeObjectURL(url)
          throw error
        }
      }

      let nextObjectUrl: string | undefined
      let nextCurrentImageUrl: string | undefined
      try {
        nextObjectUrl = await imageUrl(next.screenshotPng)
        if (next.followUp) {
          nextCurrentImageUrl = await imageUrl(next.followUp.currentImagePng)
        }
      } catch {
        if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl)
        if (nextCurrentImageUrl) URL.revokeObjectURL(nextCurrentImageUrl)
        if (!disposed && token === preparationToken.current) {
          setMessage('无法解码冻结画面。')
        }
        return
      }

      if (disposed || token !== preparationToken.current) {
        URL.revokeObjectURL(nextObjectUrl)
        if (nextCurrentImageUrl) URL.revokeObjectURL(nextCurrentImageUrl)
        return
      }

      const previousObjectUrl = objectUrl.current
      const previousCurrentImageUrl = currentImageObjectUrl.current
      objectUrl.current = nextObjectUrl
      currentImageObjectUrl.current = nextCurrentImageUrl
      sessionId.current = next.sessionId
      const state: OverlayViewState = {
        sessionId: next.sessionId,
        displayId: next.displayId,
        displayBoundsDip: next.displayBoundsDip,
        scaleFactor: next.scaleFactor,
        canFakeGenerate: next.canFakeGenerate,
        defaultGenerationOptions: next.defaultGenerationOptions,
        comfyUiWorkflowBindings: next.comfyUiWorkflowBindings,
        ...(next.lockedDisplayId ? { lockedDisplayId: next.lockedDisplayId } : {}),
        ...(next.followUp
          ? {
              initialSelection: next.followUp.selection,
              followUpAction: next.followUp.action
            }
          : {})
      }
      flushSync(() => setPrepared({
        state,
        screenshotUrl: nextObjectUrl,
        ...(nextCurrentImageUrl ? { currentImageUrl: nextCurrentImageUrl } : {})
      }))
      if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl)
      if (previousCurrentImageUrl) URL.revokeObjectURL(previousCurrentImageUrl)

      try {
        await window.artCreator.capture.notifySessionReady(next.sessionId)
      } catch (error) {
        if (!disposed && sessionId.current === next.sessionId) {
          setMessage(localizedError(error, '截屏浮层握手失败。'))
        }
      }
    }

    const stopStarted = window.artCreator.capture.onSessionStarted((next) => {
      void prepareSession(next)
    })
    const stopEnded = window.artCreator.capture.onSessionEnded((endedSessionId) => {
      if (sessionId.current !== endedSessionId) return
      preparationToken.current += 1
      sessionId.current = undefined
      flushSync(() => setPrepared(undefined))
      releaseObjectUrl()
      setMessage('截屏浮层已就绪')
    })

    void window.artCreator.capture.notifyOverlayReady().catch((error: unknown) => {
      if (!disposed) {
        setMessage(localizedError(error, '截屏浮层初始化失败。'))
      }
    })

    return () => {
      disposed = true
      preparationToken.current += 1
      stopStarted()
      stopEnded()
      releaseObjectUrl()
    }
  }, [])

  if (!prepared) return <main className="capture-loading">{t(message)}</main>
  return (
    <CaptureSessionOverlay
      key={prepared.state.sessionId}
      state={prepared.state}
      screenshotUrl={prepared.screenshotUrl}
      currentImageUrl={prepared.currentImageUrl}
    />
  )
}
