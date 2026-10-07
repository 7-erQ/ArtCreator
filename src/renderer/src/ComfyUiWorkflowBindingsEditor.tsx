import { useMemo, useState } from 'react'
import {
  comfyUiWorkflowBindingSchema,
  type ComfyUiWorkflowBinding,
  type ComfyUiWorkflowDescriptor,
  type ComfyUiWorkflowInputBinding,
  type ComfyUiWorkflowSummary,
  type ImageGeneration
} from '../../shared/contracts'

interface ModeDraft {
  enabled: boolean
  sourceImage: string
  maskImage: string
  alwaysNodeIds: string[]
  bypassNodeIds: string[]
}

interface BindingDraft {
  prompt: string
  negativePrompt: string
  seed: string
  outputNodeId: string
  transparentOutput: boolean
  modes: Record<ImageGeneration, ModeDraft>
}

const MODE_LABELS: Record<ImageGeneration, string> = {
  generate: '从零生成',
  reference: '参考生成',
  inpaint: '局部重绘'
}

function emptyMode(): ModeDraft {
  return {
    enabled: false,
    sourceImage: '',
    maskImage: '',
    alwaysNodeIds: [],
    bypassNodeIds: []
  }
}

function inputKey(binding: ComfyUiWorkflowInputBinding | undefined): string {
  return binding ? JSON.stringify(binding) : ''
}

function parseInputKey(value: string): ComfyUiWorkflowInputBinding | undefined {
  if (!value) return undefined
  return JSON.parse(value) as ComfyUiWorkflowInputBinding
}

function draftFromBinding(binding?: ComfyUiWorkflowBinding): BindingDraft {
  const generate = binding?.modes.generate
  const reference = binding?.modes.reference
  const inpaint = binding?.modes.inpaint
  return {
    prompt: inputKey(binding?.prompt),
    negativePrompt: inputKey(binding?.negativePrompt),
    seed: inputKey(binding?.seed),
    outputNodeId: binding?.outputNodeId ?? '',
    transparentOutput: binding?.transparentOutput ?? false,
    modes: {
      generate: {
        ...emptyMode(),
        enabled: Boolean(generate),
        alwaysNodeIds: generate?.alwaysNodeIds ?? [],
        bypassNodeIds: generate?.bypassNodeIds ?? []
      },
      reference: {
        ...emptyMode(),
        enabled: Boolean(reference),
        sourceImage: inputKey(reference?.sourceImage),
        alwaysNodeIds: reference?.alwaysNodeIds ?? [],
        bypassNodeIds: reference?.bypassNodeIds ?? []
      },
      inpaint: {
        ...emptyMode(),
        enabled: Boolean(inpaint),
        sourceImage: inputKey(inpaint?.sourceImage),
        maskImage: inputKey(inpaint?.maskImage),
        alwaysNodeIds: inpaint?.alwaysNodeIds ?? [],
        bypassNodeIds: inpaint?.bypassNodeIds ?? []
      }
    }
  }
}

function workflowLabel(path: string): string {
  return path.replace(/^workflows\//, '').replace(/\.json$/i, '')
}

function selectedValues(target: HTMLSelectElement): string[] {
  return Array.from(target.selectedOptions, (option) => option.value)
}

export function ComfyUiWorkflowBindingsEditor({
  baseUrl,
  bindings,
  disabled,
  onChange
}: {
  baseUrl: string
  bindings: ComfyUiWorkflowBinding[]
  disabled: boolean
  onChange: (bindings: ComfyUiWorkflowBinding[]) => void
}): React.JSX.Element {
  const [workflows, setWorkflows] = useState<ComfyUiWorkflowSummary[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [descriptor, setDescriptor] = useState<ComfyUiWorkflowDescriptor>()
  const [draft, setDraft] = useState<BindingDraft>(() => draftFromBinding())
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [messageIsError, setMessageIsError] = useState(false)
  const selectedBinding = bindings.find((binding) => binding.workflowPath === selectedPath)

  function selectWorkflowPath(workflowPath: string): void {
    const binding = bindings.find((candidate) => candidate.workflowPath === workflowPath)
    setSelectedPath(workflowPath)
    setDescriptor(undefined)
    setDraft(draftFromBinding(binding))
    setMessage('')
    setMessageIsError(false)
  }

  const stringInputs = useMemo(() => descriptor?.nodes.flatMap((node) =>
    node.inputs.filter((input) => input.valueType === 'string').map((input) => ({
      value: inputKey({ nodeId: node.id, inputName: input.name }),
      label: `#${node.id} ${node.title} · ${input.name}`
    }))) ?? [], [descriptor])
  const numberInputs = useMemo(() => descriptor?.nodes.flatMap((node) =>
    node.inputs.filter((input) => input.valueType === 'number').map((input) => ({
      value: inputKey({ nodeId: node.id, inputName: input.name }),
      label: `#${node.id} ${node.title} · ${input.name}`
    }))) ?? [], [descriptor])
  const outputNodes = descriptor?.nodes.filter((node) => node.outputNode) ?? []

  async function loadWorkflows(): Promise<void> {
    setLoading(true)
    setMessage('')
    setMessageIsError(false)
    try {
      const listed = await window.artCreator.settings.listComfyUiWorkflows(baseUrl)
      setWorkflows(listed)
      const nextPath = listed.some((workflow) => workflow.path === selectedPath)
        ? selectedPath
        : listed[0]?.path ?? ''
      if (nextPath !== selectedPath) selectWorkflowPath(nextPath)
      setMessage(listed.length > 0
        ? `发现 ${listed.length} 个 ComfyUI 工作流。`
        : 'ComfyUI 中没有可配置的 JSON 工作流。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '读取 ComfyUI 工作流失败。')
      setMessageIsError(true)
    } finally {
      setLoading(false)
    }
  }

  async function inspectWorkflow(): Promise<void> {
    if (!selectedPath) return
    setLoading(true)
    setMessage('正在由 ComfyUI 解析工作流节点…')
    setMessageIsError(false)
    try {
      const value = await window.artCreator.settings.inspectComfyUiWorkflow(baseUrl, selectedPath)
      setDescriptor(value)
      setMessage(`已读取 ${value.nodes.length} 个节点；请选择语义绑定。`)
    } catch (error) {
      setDescriptor(undefined)
      setMessage(error instanceof Error ? error.message : '解析 ComfyUI 工作流失败。')
      setMessageIsError(true)
    } finally {
      setLoading(false)
    }
  }

  function updateMode(mode: ImageGeneration, update: Partial<ModeDraft>): void {
    setDraft((current) => ({
      ...current,
      modes: {
        ...current.modes,
        [mode]: { ...current.modes[mode], ...update }
      }
    }))
  }

  function saveBinding(): void {
    if (!descriptor || !selectedPath) return
    const modes: Record<string, unknown> = {}
    for (const mode of ['generate', 'reference', 'inpaint'] as const) {
      const modeDraft = draft.modes[mode]
      if (!modeDraft.enabled) continue
      modes[mode] = {
        alwaysNodeIds: modeDraft.alwaysNodeIds,
        bypassNodeIds: modeDraft.bypassNodeIds,
        ...(mode !== 'generate' ? { sourceImage: parseInputKey(modeDraft.sourceImage) } : {}),
        ...(mode === 'inpaint' ? { maskImage: parseInputKey(modeDraft.maskImage) } : {})
      }
    }
    const parsed = comfyUiWorkflowBindingSchema.safeParse({
      workflowPath: selectedPath,
      prompt: parseInputKey(draft.prompt),
      negativePrompt: parseInputKey(draft.negativePrompt),
      seed: parseInputKey(draft.seed),
      outputNodeId: draft.outputNodeId,
      transparentOutput: draft.transparentOutput,
      modes
    })
    if (!parsed.success) {
      setMessage('请完成正向提示词、输出节点和所选生成模式的必填映射。')
      setMessageIsError(true)
      return
    }

    const next = bindings.filter((binding) => binding.workflowPath !== selectedPath)
    onChange([...next, parsed.data])
    setMessage('绑定已加入设置草稿；点击页面底部“保存设置”后生效。')
    setMessageIsError(false)
  }

  function removeBinding(): void {
    onChange(bindings.filter((binding) => binding.workflowPath !== selectedPath))
    setDraft(draftFromBinding())
    setMessage('绑定已从设置草稿移除；点击页面底部“保存设置”后生效。')
    setMessageIsError(false)
  }

  return (
    <details className="workflow-bindings" open={Boolean(descriptor)}>
      <summary>
        <span>已有工作流绑定</span>
        <em>{bindings.length} 个已配置</em>
      </summary>
      <div className="workflow-bindings-body">
        <div className="workflow-binding-toolbar">
          <select
            aria-label="ComfyUI 已保存工作流"
            value={selectedPath}
            onChange={(event) => selectWorkflowPath(event.target.value)}
            disabled={disabled || loading}
          >
            <option value="">选择 ComfyUI 工作流</option>
            {workflows.map((workflow) => (
              <option key={workflow.path} value={workflow.path}>{workflowLabel(workflow.path)}</option>
            ))}
          </select>
          <button type="button" onClick={() => void loadWorkflows()} disabled={disabled || loading}>
            {loading ? '读取中…' : '刷新列表'}
          </button>
          <button
            type="button"
            onClick={() => void inspectWorkflow()}
            disabled={disabled || loading || !selectedPath}
          >读取节点</button>
        </div>

        {descriptor && (
          <div className="workflow-binding-editor">
            <div className="workflow-binding-grid">
              <label>
                <span>正向提示词输入</span>
                <select value={draft.prompt} onChange={(event) => setDraft((current) => ({
                  ...current, prompt: event.target.value
                }))}>
                  <option value="">请选择</option>
                  {stringInputs.map((input) => <option key={input.value} value={input.value}>{input.label}</option>)}
                </select>
              </label>
              <label>
                <span>负向提示词输入（可选）</span>
                <select value={draft.negativePrompt} onChange={(event) => setDraft((current) => ({
                  ...current, negativePrompt: event.target.value
                }))}>
                  <option value="">不覆盖</option>
                  {stringInputs.map((input) => <option key={input.value} value={input.value}>{input.label}</option>)}
                </select>
              </label>
              <label>
                <span>Seed 输入（可选）</span>
                <select value={draft.seed} onChange={(event) => setDraft((current) => ({
                  ...current, seed: event.target.value
                }))}>
                  <option value="">使用工作流原值</option>
                  {numberInputs.map((input) => <option key={input.value} value={input.value}>{input.label}</option>)}
                </select>
              </label>
              <label>
                <span>最终输出节点</span>
                <select value={draft.outputNodeId} onChange={(event) => setDraft((current) => ({
                  ...current, outputNodeId: event.target.value
                }))}>
                  <option value="">请选择</option>
                  {outputNodes.map((node) => (
                    <option key={node.id} value={node.id}>#{node.id} {node.title}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="workflow-transparent-toggle">
              <input
                type="checkbox"
                checked={draft.transparentOutput}
                onChange={(event) => setDraft((current) => ({
                  ...current, transparentOutput: event.target.checked
                }))}
              />
              <span>此工作流最终输出包含透明背景</span>
            </label>

            <div className="workflow-mode-list">
              {(['generate', 'reference', 'inpaint'] as const).map((mode) => {
                const modeDraft = draft.modes[mode]
                return (
                  <section key={mode} className={modeDraft.enabled ? 'workflow-mode active' : 'workflow-mode'}>
                    <label className="workflow-mode-toggle">
                      <input
                        type="checkbox"
                        checked={modeDraft.enabled}
                        onChange={(event) => updateMode(mode, { enabled: event.target.checked })}
                      />
                      <strong>{MODE_LABELS[mode]}</strong>
                    </label>
                    {modeDraft.enabled && (
                      <div className="workflow-mode-fields">
                        {mode !== 'generate' && (
                          <label>
                            <span>{mode === 'reference' ? '参考图输入' : '重绘源图输入'}</span>
                            <select
                              value={modeDraft.sourceImage}
                              onChange={(event) => updateMode(mode, { sourceImage: event.target.value })}
                            >
                              <option value="">请选择</option>
                              {stringInputs.map((input) => (
                                <option key={input.value} value={input.value}>{input.label}</option>
                              ))}
                            </select>
                          </label>
                        )}
                        {mode === 'inpaint' && (
                          <label>
                            <span>Mask 输入</span>
                            <select
                              value={modeDraft.maskImage}
                              onChange={(event) => updateMode(mode, { maskImage: event.target.value })}
                            >
                              <option value="">请选择</option>
                              {stringInputs.map((input) => (
                                <option key={input.value} value={input.value}>{input.label}</option>
                              ))}
                            </select>
                          </label>
                        )}
                        <label>
                          <span>此模式强制启用的节点</span>
                          <select
                            multiple
                            size={4}
                            value={modeDraft.alwaysNodeIds}
                            onChange={(event) => {
                              const values = selectedValues(event.currentTarget)
                              updateMode(mode, {
                                alwaysNodeIds: values,
                                bypassNodeIds: modeDraft.bypassNodeIds.filter((id) => !values.includes(id))
                              })
                            }}
                          >
                            {descriptor.nodes.map((node) => (
                              <option key={node.id} value={node.id}>#{node.id} {node.title}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>此模式强制旁路的节点</span>
                          <select
                            multiple
                            size={4}
                            value={modeDraft.bypassNodeIds}
                            onChange={(event) => {
                              const values = selectedValues(event.currentTarget)
                              updateMode(mode, {
                                bypassNodeIds: values,
                                alwaysNodeIds: modeDraft.alwaysNodeIds.filter((id) => !values.includes(id))
                              })
                            }}
                          >
                            {descriptor.nodes.map((node) => (
                              <option key={node.id} value={node.id}>#{node.id} {node.title}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}
                  </section>
                )
              })}
            </div>

            <div className="workflow-binding-actions">
              <button type="button" onClick={saveBinding}>保存绑定到草稿</button>
              {selectedBinding && <button type="button" onClick={removeBinding}>移除绑定</button>}
            </div>
          </div>
        )}

        <p className={messageIsError ? 'connection-test-result error' : 'connection-test-note'} aria-live="polite">
          {message || '直接读取 ComfyUI 保存的画布；无需导出 API 格式。'}
        </p>
      </div>
    </details>
  )
}
