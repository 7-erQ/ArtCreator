import { useLanguage } from './useLanguage'
import { localizedError, t, message as msg, type LocalizedText } from '../../shared/language'
import { FormEvent, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_GENERATION_EFFECT_CHOICE,
  DEFAULT_COMFYUI_BASE_URL,
  DEFAULT_LIBLIB_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_PREVIEW_MAX_EDGE,
  DEFAULT_SCREENSHOT_COMPRESSION,
  DEFAULT_TEXT_MODEL,
  type CredentialTarget,
  type ComfyUiWorkflowBinding,
  type ConnectionTestResult,
  type GenerationEffectChoice,
  type ImageProvider,
  type PublicSettings
} from '../../shared/contracts'
import { IMAGE_PROVIDERS } from '../../shared/image-models'
import {
  GENERATION_EFFECT_SCHEMES,
  getGenerationEffectScheme
} from './GenerationEffectScheme'
import { ComfyUiWorkflowBindingsEditor } from './ComfyUiWorkflowBindingsEditor'

type ImageCredentialField = 'apiKey' | 'accessKey' | 'secretKey'

interface ImageProviderDraft {
  baseUrl: string
  credentials: Partial<Record<ImageCredentialField, string>>
}

interface ImageProviderSettingsDefinition {
  kicker: string
  title: string
  baseUrlLabel: string
  defaultBaseUrl: string
  credentialLabel?: string
  credentialFields: readonly {
    id: ImageCredentialField
    label: string
    ariaLabel: string
    placeholder: string
  }[]
  testLabel: string
  testingLabel: string
  testNote: string
  clearLabel?: string
}

const IMAGE_PROVIDER_SETTINGS: Record<ImageProvider, ImageProviderSettingsDefinition> = {
  openai: {
    kicker: 'OPENAI IMAGE',
    title: 'OpenAI 图片',
    baseUrlLabel: 'OpenAI 图片 Base URL',
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    credentialLabel: 'OpenAI 图片 API Key',
    credentialFields: [{
      id: 'apiKey',
      label: 'Key 值',
      ariaLabel: 'OpenAI 图片 API Key',
      placeholder: 'sk-...'
    }],
    testLabel: '测试 OpenAI 生图',
    testingLabel: '正在测试 OpenAI 生图…',
    testNote: '将真实生成并丢弃一张低质量测试图，可能产生费用。',
    clearLabel: '清除 OpenAI 图片 Key'
  },
  liblib: {
    kicker: 'LIBLIBAI IMAGE',
    title: 'LiblibAI 图片',
    baseUrlLabel: 'LiblibAI Base URL',
    defaultBaseUrl: DEFAULT_LIBLIB_BASE_URL,
    credentialLabel: 'AccessKey / SecretKey',
    credentialFields: [{
      id: 'accessKey',
      label: 'AccessKey',
      ariaLabel: 'LiblibAI AccessKey',
      placeholder: 'AccessKey'
    }, {
      id: 'secretKey',
      label: 'SecretKey',
      ariaLabel: 'LiblibAI SecretKey',
      placeholder: 'SecretKey'
    }],
    testLabel: '测试 LiblibAI 连接',
    testingLabel: '正在测试 LiblibAI…',
    testNote: '仅查询随机任务 UUID，不提交生图任务，不产生生成费用。',
    clearLabel: '同时清除两项凭据'
  },
  comfyui: {
    kicker: 'LOCAL COMFYUI',
    title: '本地 ComfyUI',
    baseUrlLabel: 'ComfyUI Base URL',
    defaultBaseUrl: DEFAULT_COMFYUI_BASE_URL,
    credentialFields: [],
    testLabel: '测试 ComfyUI 连接',
    testingLabel: '正在测试 ComfyUI…',
    testNote: '只读取系统状态和标准核心节点，不上传图片、不提交工作流。'
  }
}

export function App(): React.JSX.Element {
  useLanguage()
  const helpDialog = useRef<HTMLDialogElement>(null)
  const [settings, setSettings] = useState<PublicSettings>()
  const [hotkey, setHotkey] = useState('Alt+Shift+G')
  const [textBaseUrl, setTextBaseUrl] = useState(DEFAULT_OPENAI_BASE_URL)
  const [textModel, setTextModel] = useState(DEFAULT_TEXT_MODEL)
  const [imageProvider, setImageProvider] = useState<ImageProvider>('openai')
  const [imageProviderDrafts, setImageProviderDrafts] = useState<Record<ImageProvider, ImageProviderDraft>>({
    openai: { baseUrl: DEFAULT_OPENAI_BASE_URL, credentials: {} },
    liblib: { baseUrl: DEFAULT_LIBLIB_BASE_URL, credentials: {} },
    comfyui: { baseUrl: DEFAULT_COMFYUI_BASE_URL, credentials: {} }
  })
  const [comfyUiWorkflowBindings, setComfyUiWorkflowBindings] = useState<ComfyUiWorkflowBinding[]>([])
  const [previewMaxEdge, setPreviewMaxEdge] = useState(String(DEFAULT_PREVIEW_MAX_EDGE))
  const [generationEffectChoice, setGenerationEffectChoice] = useState<GenerationEffectChoice>(
    DEFAULT_GENERATION_EFFECT_CHOICE
  )
  const [screenshotCompressionEnabled, setScreenshotCompressionEnabled] = useState<boolean>(
    DEFAULT_SCREENSHOT_COMPRESSION.enabled
  )
  const [screenshotCompressionMaxEdge, setScreenshotCompressionMaxEdge] = useState(
    String(DEFAULT_SCREENSHOT_COMPRESSION.maxEdge)
  )
  const [screenshotCompressionQuality, setScreenshotCompressionQuality] = useState(
    String(DEFAULT_SCREENSHOT_COMPRESSION.quality)
  )
  const [textApiKey, setTextApiKey] = useState('')
  const [clearingCredential, setClearingCredential] = useState<CredentialTarget>()
  const [message, setMessage] = useState<LocalizedText>('')
  const [messageIsError, setMessageIsError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testingText, setTestingText] = useState(false)
  const [testingImageProvider, setTestingImageProvider] = useState<ImageProvider>()
  const [textTestResult, setTextTestResult] = useState<ConnectionTestResult>()
  const [imageTestResults, setImageTestResults] = useState<Partial<Record<ImageProvider, ConnectionTestResult>>>({})

  useEffect(() => {
    void window.artCreator.settings.get().then((value) => {
      setSettings(value)
      setHotkey(value.hotkey)
      setTextBaseUrl(value.textBaseUrl)
      setTextModel(value.textModel)
      setImageProvider(value.lastGenerationOptions.imageModel.provider)
      setImageProviderDrafts((current) => ({
        openai: { ...current.openai, baseUrl: value.openaiImageBaseUrl },
        liblib: { ...current.liblib, baseUrl: value.liblibImageBaseUrl },
        comfyui: { ...current.comfyui, baseUrl: value.comfyUiBaseUrl }
      }))
      setComfyUiWorkflowBindings(value.comfyUiWorkflowBindings)
      setPreviewMaxEdge(String(value.previewMaxEdge))
      setGenerationEffectChoice(value.generationEffectChoice)
      setScreenshotCompressionEnabled(value.screenshotCompression.enabled)
      setScreenshotCompressionMaxEdge(String(value.screenshotCompression.maxEdge))
      setScreenshotCompressionQuality(String(value.screenshotCompression.quality))
    })
  }, [])

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSaving(true)
    setMessage('')
    setMessageIsError(false)
    try {
      const value = await window.artCreator.settings.update({
        hotkey,
        textBaseUrl,
        textModel,
        openaiImageBaseUrl: imageProviderDrafts.openai.baseUrl,
        liblibImageBaseUrl: imageProviderDrafts.liblib.baseUrl,
        comfyUiBaseUrl: imageProviderDrafts.comfyui.baseUrl,
        comfyUiWorkflowBindings,
        previewMaxEdge: Number(previewMaxEdge),
        generationEffectChoice,
        screenshotCompression: {
          enabled: screenshotCompressionEnabled,
          maxEdge: Number(screenshotCompressionMaxEdge),
          quality: Number(screenshotCompressionQuality)
        },
        ...(textApiKey ? { textApiKey } : {}),
        ...(imageProviderDrafts.openai.credentials.apiKey
          ? { openaiImageApiKey: imageProviderDrafts.openai.credentials.apiKey }
          : {}),
        ...(imageProviderDrafts.liblib.credentials.accessKey
          ? { liblibAccessKey: imageProviderDrafts.liblib.credentials.accessKey }
          : {}),
        ...(imageProviderDrafts.liblib.credentials.secretKey
          ? { liblibSecretKey: imageProviderDrafts.liblib.credentials.secretKey }
          : {})
      })
      setSettings(value)
      setTextBaseUrl(value.textBaseUrl)
      setTextModel(value.textModel)
      setImageProviderDrafts({
        openai: { baseUrl: value.openaiImageBaseUrl, credentials: {} },
        liblib: { baseUrl: value.liblibImageBaseUrl, credentials: {} },
        comfyui: { baseUrl: value.comfyUiBaseUrl, credentials: {} }
      })
      setComfyUiWorkflowBindings(value.comfyUiWorkflowBindings)
      setPreviewMaxEdge(String(value.previewMaxEdge))
      setGenerationEffectChoice(value.generationEffectChoice)
      setScreenshotCompressionEnabled(value.screenshotCompression.enabled)
      setScreenshotCompressionMaxEdge(String(value.screenshotCompression.maxEdge))
      setScreenshotCompressionQuality(String(value.screenshotCompression.quality))
      setTextApiKey('')
      setMessage(value.hotkeyError ?? '设置已安全保存。')
      setMessageIsError(Boolean(value.hotkeyError))
    } catch (error) {
      setMessage(localizedError(error, '保存失败。'))
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  async function testTextConnection(): Promise<void> {
    setTestingText(true)
    setTextTestResult(undefined)
    try {
      setTextTestResult(await window.artCreator.settings.testConnection({
        target: 'text',
        baseUrl: textBaseUrl,
        model: textModel,
        ...(textApiKey ? { apiKey: textApiKey } : {})
      }))
    } catch {
      setTextTestResult({ ok: false, message: '提示词配置无效，请检查填写内容。' })
    } finally {
      setTestingText(false)
    }
  }

  async function testImageConnection(): Promise<void> {
    const provider = imageProvider
    setTestingImageProvider(provider)
    setImageTestResults((current) => ({ ...current, [provider]: undefined }))
    try {
      const result = provider === 'openai'
        ? await window.artCreator.settings.testConnection({
            target: 'openai_image',
            baseUrl: imageProviderDrafts.openai.baseUrl,
            ...(imageProviderDrafts.openai.credentials.apiKey
              ? { apiKey: imageProviderDrafts.openai.credentials.apiKey }
              : {})
          })
        : provider === 'liblib'
          ? await window.artCreator.settings.testConnection({
            target: 'liblib',
            baseUrl: imageProviderDrafts.liblib.baseUrl,
            ...(imageProviderDrafts.liblib.credentials.accessKey
              ? { accessKey: imageProviderDrafts.liblib.credentials.accessKey }
              : {}),
            ...(imageProviderDrafts.liblib.credentials.secretKey
              ? { secretKey: imageProviderDrafts.liblib.credentials.secretKey }
              : {})
            })
          : await window.artCreator.settings.testConnection({
              target: 'comfyui',
              baseUrl: imageProviderDrafts.comfyui.baseUrl
            })
      setImageTestResults((current) => ({ ...current, [provider]: result }))
    } catch {
      const message = provider === 'openai'
        ? 'OpenAI 生图配置无效，请检查填写内容。'
        : provider === 'liblib'
          ? 'LiblibAI 配置无效，请检查填写内容。'
          : 'ComfyUI 配置无效，请检查本地服务和 Base URL。'
      setImageTestResults((current) => ({
        ...current,
        [provider]: { ok: false, message }
      }))
    } finally {
      setTestingImageProvider(undefined)
    }
  }

  async function clearCredential(target: CredentialTarget): Promise<void> {
    const label = msg(target === 'text' ? '文本 API Key' :
      target === 'openai_image' ? 'OpenAI 图片 API Key' : 'LiblibAI 凭据')
    if (!window.confirm(t('确定清除已保存的{0}？清除后将立即生效。', label))) return

    setClearingCredential(target)
    setMessage('')
    setMessageIsError(false)
    try {
      const value = await window.artCreator.settings.clearCredential(target)
      setSettings(value)
      if (target === 'text') {
        setTextApiKey('')
        setTextTestResult(undefined)
      } else {
        const provider = target === 'openai_image' ? 'openai' : 'liblib'
        setImageProviderDrafts((current) => ({
          ...current,
          [provider]: { ...current[provider], credentials: {} }
        }))
        setImageTestResults((current) => ({ ...current, [provider]: undefined }))
      }
      setMessage(msg('{0} 已清除。', label))
    } catch {
      setMessage(msg('{0} 清除失败。', label))
      setMessageIsError(true)
    } finally {
      setClearingCredential(undefined)
    }
  }

  function updateImageBaseUrl(baseUrl: string): void {
    const provider = imageProvider
    setImageProviderDrafts((current) => ({
      ...current,
      [provider]: { ...current[provider], baseUrl }
    }))
    setImageTestResults((current) => ({ ...current, [provider]: undefined }))
  }

  function updateImageCredential(field: ImageCredentialField, value: string): void {
    const provider = imageProvider
    setImageProviderDrafts((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        credentials: { ...current[provider].credentials, [field]: value }
      }
    }))
    setImageTestResults((current) => ({ ...current, [provider]: undefined }))
  }

  const configuredCount = Number(settings?.hasTextApiKey) +
    Number(settings?.hasOpenaiImageApiKey) + Number(settings?.hasLiblibCredentials)
  const imageProviderSettings = IMAGE_PROVIDER_SETTINGS[imageProvider]
  const imageProviderDraft = imageProviderDrafts[imageProvider]
  const imageProviderConfigured = imageProvider === 'openai'
    ? settings?.hasOpenaiImageApiKey
    : imageProvider === 'liblib'
      ? settings?.hasLiblibCredentials
      : true
  const imageTestResult = imageTestResults[imageProvider]
  const anyConnectionTestRunning = testingText || testingImageProvider !== undefined

  return (
    <main className="settings-shell">
      <div className="orb orb-one" />
      <div className="orb orb-two" />
      <header className="hero">
        <p className="eyebrow">ART CREATOR / DESKTOP</p>
        <h1>{t('圈住灵感，')}<br />{t('让素材落在原位。')}</h1>
        <p className="lede">{t('快捷框选屏幕语境，由 AI 生成素材并置顶预览。')}</p>
        <button
          className="operation-help-button"
          type="button"
          disabled={!settings}
          onClick={() => helpDialog.current?.showModal()}
        >{t('快捷键与操作说明')}</button>
      </header>

      <form className="settings-card" onSubmit={(event) => void submit(event)}>
        <div className="card-heading">
          <div>
            <span className="step">01</span>
            <h2>{t('模型连接')}</h2>
          </div>
          <span className={configuredCount === 3 ? 'status ready' : 'status'}>
            {configuredCount}{t('/3 已配置')}</span>
        </div>

        <div className="connection-grid">
          <section className="connection-panel">
            <div className="connection-heading">
              <div>
                <span className="connection-kicker">TEXT</span>
                <h3>{t('提示词分析')}</h3>
              </div>
              <span className={settings?.hasTextApiKey ? 'connection-dot ready' : 'connection-dot'} />
            </div>
            <label>
              <span>{t('文本模型')}</span>
              <input
                value={textModel}
                onChange={(event) => {
                  setTextModel(event.target.value)
                  setTextTestResult(undefined)
                }}
                placeholder={DEFAULT_TEXT_MODEL}
                autoComplete="off"
                required
                maxLength={200}
                pattern=".*\S.*"
                title={t('请输入文本模型。')}
              />
            </label>
            <label>
              <span>{t('文本 Base URL')}</span>
              <input
                value={textBaseUrl}
                onChange={(event) => {
                  setTextBaseUrl(event.target.value)
                  setTextTestResult(undefined)
                }}
                placeholder={DEFAULT_OPENAI_BASE_URL}
                autoComplete="url"
              />
            </label>
            <details className="credential-foldout">
              <summary>
                <span>{t('文本 API Key')}</span>
                <span className={settings?.hasTextApiKey ? 'credential-state ready' : 'credential-state'}>
                  {settings?.hasTextApiKey ? t('已保存') : t('未配置')}
                </span>
              </summary>
              <div className="credential-foldout-body">
                <label>
                  <span>{t('Key 值')}</span>
                  <input
                    aria-label={t('文本 API Key')}
                    type="password"
                    value={textApiKey}
                    onChange={(event) => {
                      setTextApiKey(event.target.value)
                      setTextTestResult(undefined)
                    }}
                    placeholder={settings?.hasTextApiKey ? t('已保存；留空保持不变') : 'sk-...'}
                    autoComplete="off"
                    disabled={clearingCredential === 'text'}
                  />
                </label>
                {settings?.hasTextApiKey && (
                  <button
                    className="credential-delete-button"
                    type="button"
                    disabled={saving || anyConnectionTestRunning || Boolean(clearingCredential)}
                    onClick={() => void clearCredential('text')}
                  >
                    {clearingCredential === 'text' ? t('正在清除…') : t('清除文本 Key')}
                  </button>
                )}
              </div>
            </details>
            <button
              className="connection-test-button"
              type="button"
              disabled={saving || anyConnectionTestRunning || Boolean(clearingCredential)}
              onClick={() => void testTextConnection()}
            >
              {testingText ? t('正在测试提示词配置…') : t('测试提示词配置')}
            </button>
            {textTestResult && (
              <p
                className={textTestResult.ok ? 'connection-test-result' : 'connection-test-result error'}
                aria-live="polite"
              >
                {t(textTestResult.message)}
              </p>
            )}
          </section>

          <section className="connection-panel image-provider-panel">
            <div className="connection-heading">
              <div>
                <span className="connection-kicker">{imageProviderSettings.kicker}</span>
                <h3>{t(imageProviderSettings.title)}</h3>
              </div>
              <span className={imageProviderConfigured ? 'connection-dot ready' : 'connection-dot'} />
            </div>
            <label className="image-provider-select">
              <span>{t('图片供应商')}</span>
              <select
                aria-label={t('图片供应商')}
                value={imageProvider}
                onChange={(event) => setImageProvider(event.target.value as ImageProvider)}
                disabled={anyConnectionTestRunning || Boolean(clearingCredential)}
              >
                {IMAGE_PROVIDERS.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.label}</option>
                ))}
              </select>
              <small>{t('选择要编辑的连接；实际生图方案仍在截图工具栏中选择。')}</small>
            </label>
            <label>
              <span>{t(imageProviderSettings.baseUrlLabel)}</span>
              <input
                value={imageProviderDraft.baseUrl}
                onChange={(event) => updateImageBaseUrl(event.target.value)}
                placeholder={imageProviderSettings.defaultBaseUrl}
                autoComplete="url"
              />
            </label>
            {imageProvider !== 'comfyui' ? (
              <details className="credential-foldout">
              <summary>
                <span>{t(imageProviderSettings.credentialLabel)}</span>
                <span className={imageProviderConfigured ? 'credential-state ready' : 'credential-state'}>
                  {imageProviderConfigured ? t('已保存') : t('未配置')}
                </span>
              </summary>
              <div className="credential-foldout-body">
                {imageProviderSettings.credentialFields.map((field) => (
                  <label key={field.id}>
                    <span>{t(field.label)}</span>
                    <input
                      aria-label={t(field.ariaLabel)}
                      type="password"
                      value={imageProviderDraft.credentials[field.id] ?? ''}
                      onChange={(event) => updateImageCredential(field.id, event.target.value)}
                      placeholder={imageProviderConfigured
                        ? t('已保存；留空保持不变')
                        : field.placeholder}
                      autoComplete="off"
                      disabled={Boolean(clearingCredential)}
                    />
                  </label>
                ))}
                {imageProviderConfigured && (
                  <button
                    className="credential-delete-button"
                    type="button"
                    disabled={saving || anyConnectionTestRunning || Boolean(clearingCredential)}
                    onClick={() => void clearCredential(imageProvider === 'openai' ? 'openai_image' : 'liblib')}
                  >
                    {clearingCredential
                      ? t('正在清除…')
                      : t(imageProviderSettings.clearLabel)}
                  </button>
                )}
              </div>
              </details>
            ) : (
              <p className="connection-test-note">
                {t('无需凭据。仅允许 localhost、127.0.0.1 或 [::1]；ComfyUI temp 文件由本地服务管理，Art Creator 不会清理。')}</p>
            )}
            <button
              className="connection-test-button"
              type="button"
              disabled={saving || anyConnectionTestRunning || Boolean(clearingCredential)}
              onClick={() => void testImageConnection()}
            >
              {testingImageProvider === imageProvider
                ? t(imageProviderSettings.testingLabel)
                : t(imageProviderSettings.testLabel)}
            </button>
            <small className="connection-test-note">{t(imageProviderSettings.testNote)}</small>
            {imageTestResult && (
              <p
                className={imageTestResult.ok ? 'connection-test-result' : 'connection-test-result error'}
                aria-live="polite"
              >
                {t(imageTestResult.message)}
              </p>
            )}
            {imageProvider === 'comfyui' && (
              <ComfyUiWorkflowBindingsEditor
                baseUrl={imageProviderDrafts.comfyui.baseUrl}
                bindings={comfyUiWorkflowBindings}
                disabled={saving || anyConnectionTestRunning || Boolean(clearingCredential)}
                onChange={setComfyUiWorkflowBindings}
              />
            )}
          </section>
        </div>

        <p className="connection-warning">
          {t('云端供应商填写其完整根地址（路径可能是 /v1 或 /openai，请勿自行补齐）。ComfyUI 只允许本机回环地址和自定义端口，不支持远程主机或认证代理。')}</p>

        <details className="advanced-settings">
          <summary>{t('详细生成配置')}</summary>
          <label className="advanced-field">
            <span>{t('首次预览最大边（像素）')}</span>
            <input
              type="number"
              min={64}
              max={2048}
              step={16}
              value={previewMaxEdge}
              onChange={(event) => setPreviewMaxEdge(event.target.value)}
              required
            />
            <small>{t('框选尺寸超出时会等比缩小，小框保持原尺寸。默认 512。')}</small>
          </label>
          <div className="advanced-divider" />
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={screenshotCompressionEnabled}
              onChange={(event) => setScreenshotCompressionEnabled(event.target.checked)}
            />
            <span>
              <strong>{t('压缩识图截图')}</strong>
              <small>{t('仅压缩发送给提示词分析模型的截图，原始截图和重绘输入不受影响。')}</small>
            </span>
          </label>
          <div className="compression-grid">
            <label>
              <span>{t('压缩最长边（像素）')}</span>
              <input
                type="number"
                min={256}
                max={2048}
                step={32}
                value={screenshotCompressionMaxEdge}
                onChange={(event) => setScreenshotCompressionMaxEdge(event.target.value)}
                disabled={!screenshotCompressionEnabled}
                required
              />
              <small>{t('按比例缩小且不会放大小图，默认 1024。')}</small>
            </label>
            <label>
              <span>{t('JPEG 质量（1–100）')}</span>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={screenshotCompressionQuality}
                onChange={(event) => setScreenshotCompressionQuality(event.target.value)}
                disabled={!screenshotCompressionEnabled}
                required
              />
              <small>{t('数值越低，请求体越小；默认 80。')}</small>
            </label>
          </div>
        </details>

        <label className="generation-effect-setting">
          <span>{t('生成加载特效')}</span>
          <select
            aria-label={t('生成加载特效')}
            value={generationEffectChoice}
            onChange={(event) => setGenerationEffectChoice(
              event.target.value as GenerationEffectChoice
            )}
          >
            <option value="random">{t('每个任务随机')}</option>
            {GENERATION_EFFECT_SCHEMES.map((scheme) => (
              <option key={scheme.id} value={scheme.id}>{t(scheme.label)}</option>
            ))}
          </select>
          <small>
            {generationEffectChoice === 'random'
              ? t('每个新建生成任务稳定随机一套，同一悬浮窗不会中途切换。')
              : t('{0} 新建任务时生效。', t(getGenerationEffectScheme(generationEffectChoice).description))}
          </small>
        </label>

        <div className="divider" />

        <label>
          <span>{t('全局快捷键')}</span>
          <input value={hotkey} onChange={(event) => setHotkey(event.target.value)} />
          <small>{window.artCreator.platform === 'darwin' ? t('默认：Option + Shift + G') : t('默认：Alt + Shift + G')}</small>
        </label>

        <button type="submit" disabled={saving || Boolean(clearingCredential)}>
          {saving ? t('正在保存…') : t('保存设置')}
        </button>
        <button className="secondary-button" type="button" onClick={() => void window.artCreator.capture.start()}>
          {t('开始截图生成')}</button>
        <p className={messageIsError || settings?.hotkeyError ? 'message error' : 'message'}>
          {t(message || settings?.hotkeyError)}
        </p>
      </form>

      <footer>{t('截图与生成结果默认不落盘 · 三组凭据均只保存在系统加密存储')}</footer>
      <dialog ref={helpDialog} className="operation-help-dialog" aria-labelledby="operation-help-title">
        <header className="operation-help-header">
          <h2 id="operation-help-title">{t('快捷键与操作说明')}</h2>
          <form method="dialog"><button autoFocus aria-label={t('关闭操作说明')}>{t('关闭')}</button></form>
        </header>
        <div className="operation-help-content" tabIndex={0} aria-label={t('操作说明内容')}>
          <section>
            <h3>{t('开始截图')}</h3>
            <p>{t('当前已保存的全局快捷键：')}<kbd>{settings?.hotkey}</kbd>{t('。')}
              {window.artCreator.platform === 'darwin' && t(' macOS 中 Alt 对应 Option。')}
              {t('也可点击主页或托盘菜单的“开始截图生成”。')}</p>
            <p>{t('生图选项沿用上次真实提交的选择，重启后仍保留；提示词与选框需重新填写或选择。')}</p>
          </section>
          <section>
            <h3>{t('框选与生成')}</h3>
            <dl>
              <dt>{t('绿色框')}</dt><dd>{t('先拖动选择上下文；没有红框时也作为生成位置与尺寸。')}</dd>
              <dt>{t('红色框')}</dt><dd>{t('可选，在绿框内拖动选择生成位置与尺寸。')}</dd>
              <dt>{t('蓝色框')}</dt><dd>{t('可选，完成有效蓝框后自动启用参考生成，之后仍可手动改模式。 模型不支持参考生成时，需更换模型或撤销蓝框才能提交。')}</dd>
              <dt>{t('多张参考图')}</dt><dd>{t('参考生成时可继续在空白处按顺序框选，最多四张； 继续编辑固定使用当前图片作为参考图1，最多再选三个蓝框。')}</dd>
              <dt>{t('参考图回退')}</dt><dd>{t('普通参考生成没有蓝框时使用红框，没有红框时使用绿框。')}</dd>
              <dt>{t('调整选框')}</dt><dd>{t('绿框尚无红框时，在绿框中拖动创建红框；尚无蓝框时， 在已有框中拖动创建蓝框。后续拖动框体移动，拖动四角调整尺寸。')}</dd>
              <dt><kbd>Space</kbd></dt><dd>{t('绘制绿框或红框时切换固定宽高比；不改变蓝框比例。')}</dd>
              <dt><kbd>Esc</kbd></dt><dd>{t('依次清空涂鸦、撤销最后一个蓝框、红框、绿框；没有选框时退出截图。 也可点击“取消”。')}</dd>
              <dt>{t('涂鸦')}</dt><dd>{t('切换到“涂鸦”，在红框或无红框时的绿框内画 mask。 局部重绘需要本次有效涂鸦；清空后需重新绘制。')}</dd>
            </dl>
            <p>{t('从零生成不使用蓝框图片；参考生成使用参考图；局部重绘使用输出区域原图与涂鸦 mask。 提示词处理独立选择；“直接使用”不调用文本润色，AI 润色可选择语言。')}</p>
          </section>
          <section>
            <h3>{t('悬浮预览')}</h3>
            <dl>
              <dt>{t('拖动 / 缩放')}</dt><dd>{t('左键拖动移动预览，拖动右下角调整显示尺寸。')}</dd>
              <dt><kbd>Shift</kbd> {t(' + 拖动')}</dt><dd>{t('克隆当前预览并拖动新实例。')}</dd>
              <dt><kbd>Ctrl</kbd> {t(' + 拖动')}</dt><dd>{t('把 PNG 拖出到支持文件拖放的应用。')}</dd>
              <dt>{t('右键 / 更多')}</dt><dd>{t('打开菜单，可重新配置、继续编辑、放大、精细处理或查看属性； 可用操作取决于任务状态与模型能力。')}</dd>
              <dt>{t('历史版本')}</dt><dd>{t('鼠标移入显示左右切换按钮；生成期间不可切换，切换后复制与保存使用当前版本。')}</dd>
              <dt>{t('复制 / 保存')}</dt><dd>{t('工具栏复制图片到剪贴板或保存 PNG；“编辑”修改提示词，“重生成”再次生成。')}</dd>
              <dt>{t('鼠标穿透')}</dt><dd>{t('启用后鼠标操作穿过预览；从托盘的“置顶预览”子菜单选择对应预览的“恢复交互”。')}</dd>
            </dl>
          </section>
          <section>
            <h3>{t('生图日志')}</h3>
            <p>{t('右键托盘图标，选择“打开日志目录”。日志记录原始及最终提示词、参数、阶段与结果， 不保存截图或生成图片；日志按文件大小轮转保留。')}</p>
          </section>
        </div>
      </dialog>
    </main>
  )
}
