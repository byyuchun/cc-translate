import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Cursor, Entry, EntryStatus, EntryTarget } from '../types'

const PANE = 'translate'
const PLUGIN = 'cc-translate'
const MAX_DIALOG_CACHE = 40

const entries = atom({ plugin: 'cc-translate', key: 'entries' } as const, [] as Entry[], {
  shape: 'entries-1',
})
const cursor = atom({ plugin: 'cc-translate', key: 'cursor' } as const, { count: 0, tail: '' } as Cursor, {
  shape: 'cursor-1',
})
const showOriginal = atom({ plugin: 'cc-translate', key: 'showOriginal' } as const, true)
const paused = atom({ plugin: 'cc-translate', key: 'paused' } as const, false)
const status = atom({ plugin: 'cc-translate', key: 'status' } as const, '')
const tick = atom({ plugin: 'cc-translate', key: 'tick' } as const, 0)

type Settings = {
  baseUrl: string
  token: string
  model: string
  protocol: 'anthropic' | 'openai'
  auth: 'bearer' | 'x-api-key'
  configPath: string
  autoInput: boolean
  maxEntries: number
  useSessionEnv: boolean
}

let cached: Settings | undefined
let isPumping = false
let typedDraft = ''
let serial = 0
let pendingField: { text: string } | undefined
const translationCache = new Map<string, string>()
const dialogCache = new Map<string, unknown[]>()

// ---------------------------------------------------------------- settings

const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const homeOf = (path: string, home: string): string =>
  path.startsWith('~/') ? `${home}/${path.slice(2)}` : path === '~' ? home : path

const settingsOf = (options: PluginOptions): Settings => {
  const maxEntries = options.max_entries
  return {
    baseUrl: textOf(options.base_url),
    token: textOf(options.token),
    model: textOf(options.model),
    protocol: options.protocol === 'openai' ? 'openai' : 'anthropic',
    auth: options.auth === 'x-api-key' ? 'x-api-key' : 'bearer',
    configPath: textOf(options.config_path) || '~/.claude/cc-translate.json',
    autoInput: options.auto_input !== false,
    useSessionEnv: options.use_session_env === true,
    maxEntries:
      typeof maxEntries === 'number' ? Math.min(2000, Math.max(20, maxEntries)) : 300,
  }
}

async function readConfigFile($: EngineInterface, path: string): Promise<Record<string, unknown>> {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const raw = await $.fs.read(homeOf(path, home))
    return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function getSettings($: EngineInterface, fallback: Settings): Promise<Settings> {
  if (cached) return cached
  const file = await readConfigFile($, fallback.configPath)
  const envBase = fallback.useSessionEnv ? textOf(await $.env.get('ANTHROPIC_BASE_URL')) : ''
  const envToken = fallback.useSessionEnv ? textOf(await $.env.get('ANTHROPIC_AUTH_TOKEN')) : ''
  const envModel = fallback.useSessionEnv
    ? textOf(await $.env.get('ANTHROPIC_MODEL')).replace(/\[[^\]]*\]$/, '')
    : ''
  const baseUrl = fallback.baseUrl || textOf(file.base_url) || envBase
  const token =
    fallback.token ||
    textOf(file.token) ||
    textOf(file.api_key) ||
    textOf(file.auth_token) ||
    envToken
  const model = fallback.model || textOf(file.model) || envModel
  const protocol =
    file.protocol === 'openai' || file.protocol === 'anthropic'
      ? file.protocol
      : fallback.protocol
  const auth =
    file.auth === 'x-api-key' || file.auth === 'bearer' ? file.auth : fallback.auth
  cached = {
    ...fallback,
    baseUrl,
    token,
    model,
    protocol,
    auth,
    autoInput: fallback.autoInput && file.auto_input !== false,
  }
  return cached
}

const isReady = (settings: Settings): boolean =>
  settings.baseUrl.length > 0 && settings.token.length > 0 && settings.model.length > 0

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}

function endpointOf(settings: Settings): string {
  const base = settings.baseUrl.replace(/\/+$/, '')
  if (settings.protocol === 'openai') return `${base}/chat/completions`
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
}

// ---------------------------------------------------------------- model call

function systemFor(target: EntryTarget): string {
  const to =
    target === 'zh'
      ? 'Simplified Chinese. Keep widely used English technical terms (API, token, commit, prompt) where translating them would confuse.'
      : 'English.'
  return [
    `You are a translation engine inside a software-engineering CLI. Translate the user's message into ${to}`,
    '',
    'Rules:',
    '- Preserve Markdown structure exactly: headings, lists, tables, block quotes, links, emphasis.',
    '- Preserve code fences, inline code, file paths, shell commands, identifiers, URLs, versions and numbers verbatim.',
    '- Do not translate inside code fences. Translate a code comment only when the language is clear and the comment is prose.',
    '- Keep the original tone. Do not summarize, explain, answer the message, or add a preface.',
    '- Output only the translation, with no surrounding quotes, labels or commentary.',
  ].join('\n')
}

function chunksOf(text: string, limit = 4000): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  let buf: string[] = []
  let length = 0
  let inFence = false
  for (const line of lines) {
    const isFence = /^\s*(```|~~~)/.test(line)
    if (length + line.length + 1 > limit && buf.length > 0 && !inFence) {
      out.push(buf.join('\n'))
      buf = []
      length = 0
    }
    buf.push(line)
    length += line.length + 1
    if (isFence) inFence = !inFence
  }
  if (buf.length > 0) out.push(buf.join('\n'))
  return out.length > 0 ? out : ['']
}

const looksTranslatable = (text: string): boolean => /[\p{L}]/u.test(text)

async function callModel(
  $: EngineInterface,
  settings: Settings,
  system: string,
  user: string,
  maxTokens = 4096,
): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  let body: unknown
  if (settings.protocol === 'openai') {
    headers.authorization = `Bearer ${settings.token}`
    body = {
      model: settings.model,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }
  } else {
    headers['anthropic-version'] = '2023-06-01'
    if (settings.auth === 'x-api-key') headers['x-api-key'] = settings.token
    else headers.authorization = `Bearer ${settings.token}`
    body = {
      model: settings.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }
  }

  const response = await $.http.fetch(endpointOf(settings), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 180)}`)

  let data: unknown
  try {
    data = JSON.parse(response.text)
  } catch {
    throw new Error('端点返回的不是 JSON')
  }

  const record = data as Record<string, unknown>
  if (settings.protocol === 'openai') {
    const choices = Array.isArray(record.choices)
      ? (record.choices as Array<Record<string, unknown>>)
      : []
    const message = choices[0]?.message as Record<string, unknown> | undefined
    const content = message?.content
    if (typeof content === 'string' && content.trim()) return content.trim()
    throw new Error('端点返回了空内容')
  }

  const content = Array.isArray(record.content)
    ? (record.content as Array<Record<string, unknown>>)
    : []
  const joined = content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
  if (joined.trim()) return joined.trim()
  throw new Error('端点返回了空内容')
}

async function translate(
  $: EngineInterface,
  settings: Settings,
  text: string,
  target: EntryTarget,
): Promise<string> {
  if (!text.trim() || !looksTranslatable(text)) return text
  const key = `${target}\u0000${text}`
  const hit = translationCache.get(key)
  if (hit !== undefined) return hit

  const parts = chunksOf(text)
  const out: string[] = []
  for (const part of parts) out.push(await callModel($, settings, systemFor(target), part))
  const joined = out.join('\n')
  if (translationCache.size > 500) translationCache.clear()
  translationCache.set(key, joined)
  return joined
}

// ---------------------------------------------------------------- state help

function newId(): string {
  serial += 1
  return `${Date.now().toString(36)}-${serial}`
}

function hashOf(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const hasCJK = (text: string): boolean =>
  /[㐀-䶿一-鿿豈-﫿]/.test(text)

const preview = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 240 ? `${one.slice(0, 240)}…` : one
}

async function redraw($: EngineInterface): Promise<void> {
  await update($, tick, value => value + 1)
}

async function flash($: EngineInterface, text: string): Promise<void> {
  await update($, status, () => text)
  $.clock.after(4000, () => {
    void update($, status, () => '')
  })
}

async function appendEntries($: EngineInterface, adds: Entry[], maxEntries: number): Promise<void> {
  if (adds.length === 0) return
  await update($, entries, list => {
    const seen = new Set(list.map(entry => entry.sig))
    const fresh = adds.filter(entry => entry.sig.length > 0 && !seen.has(entry.sig))
    if (fresh.length === 0) return list
    return [...list, ...fresh].slice(-maxEntries)
  })
}

const labelOf = (entry: Entry): string => {
  if (entry.role === 'you') return '你'
  if (entry.role === 'claude') return 'Claude'
  if (entry.role === 'tool') return '工具'
  return '提示'
}

// ---------------------------------------------------------------- tool rows

const TOOL_ZH: Record<string, string> = {
  Bash: '执行命令',
  Read: '读取文件',
  Write: '写入文件',
  Edit: '编辑文件',
  MultiEdit: '批量编辑',
  NotebookEdit: '编辑笔记本',
  Glob: '查找文件',
  Grep: '搜索内容',
  LS: '列出目录',
  WebFetch: '抓取网页',
  WebSearch: '搜索网络',
  Task: '启动子任务',
  Agent: '启动子代理',
  TodoWrite: '更新待办',
  AskUserQuestion: '向你提问',
  Skill: '调用技能',
}

function detailOf(input: Record<string, unknown>): string {
  const keys = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt']
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      const one = value.replace(/\s+/g, ' ').trim()
      return one.length > 160 ? `${one.slice(0, 160)}…` : one
    }
  }
  return ''
}

function toolEntry(use: {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
}): Entry {
  const detail = detailOf(use.input)
  const suffix = detail ? ` · ${detail}` : ''
  const verb = TOOL_ZH[use.tool] ?? `调用工具 ${use.tool}`
  return {
    id: newId(),
    sig: `t:${use.tool_use_id}`,
    role: 'tool',
    original: `${use.tool}${suffix}`,
    translated: `${verb}${suffix}`,
    status: 'done',
    target: 'zh',
  }
}

// ---------------------------------------------------------------- dialog translation

async function translateQuestions(
  $: EngineInterface,
  settings: Settings,
  questions: unknown,
): Promise<unknown[]> {
  const system = [
    'You translate UI text for a developer tool.',
    'Input is a JSON array of questions. Output ONLY valid JSON with the same array shape and the same keys.',
    'Translate the values of "question", "header", "label", "description" into Simplified Chinese.',
    'Keep option "value" fields, booleans, numbers and every other key exactly as they are.',
    'Do not add or remove questions or options. Do not wrap the JSON in a code fence.',
  ].join('\n')
  const raw = await callModel($, settings, system, JSON.stringify(questions), 2048)
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  const parsed = JSON.parse(cleaned) as unknown
  if (!Array.isArray(parsed) || parsed.length !== (questions as unknown[]).length) {
    throw new Error('bad dialog translation')
  }
  return parsed
}

// ---------------------------------------------------------------- send / fill

async function doSend($: EngineInterface, settings: Settings, raw: string): Promise<void> {
  const text = raw.trim()
  if (!text) return
  if (!isReady(settings)) {
    await flash($, '未配置端点：编辑 ~/.claude/cc-translate.json')
    return
  }

  typedDraft = ''
  pendingField = { text: '' }
  await redraw($)

  const id = newId()
  await appendEntries(
    $,
    [
      {
        id,
        sig: `you:${id}`,
        role: 'you',
        original: text,
        translated: '',
        status: 'working',
        target: 'en',
      },
    ],
    settings.maxEntries,
  )

  try {
    const english = await translate($, settings, text, 'en')
    await update($, entries, list =>
      list.map(entry =>
        entry.id === id ? { ...entry, translated: english, status: 'done' as EntryStatus } : entry,
      ),
    )
    await $.prompt.submit({ text: english, asUser: true })
    await flash($, '已发送英文')
  } catch (error) {
    await update($, entries, list =>
      list.map(entry =>
        entry.id === id
          ? { ...entry, status: 'error' as EntryStatus, error: errText(error) }
          : entry,
      ),
    )
    pendingField = { text }
    await redraw($)
    await flash($, '翻译失败，草稿已放回输入框')
  }
}

async function doFill($: EngineInterface, settings: Settings, raw: string): Promise<void> {
  const text = raw.trim()
  if (!text) return
  if (!isReady(settings)) {
    await flash($, '未配置端点：编辑 ~/.claude/cc-translate.json')
    return
  }
  try {
    const english = await translate($, settings, text, 'en')
    await $.prompt.fill({ text: english })
    await flash($, '英文已填入主输入框，回车发送')
  } catch (error) {
    await $.prompt.fill({ text })
    await flash($, `翻译失败，已填入原文：${errText(error)}`)
  }
}

// ---------------------------------------------------------------- pump

function startPump($: EngineInterface, settingsRef: () => Settings): void {
  $.clock.every(1200, () => {
    if (isPumping) return
    isPumping = true
    void (async () => {
      try {
        const settings = settingsRef()
        if (!isReady(settings)) return
        if (await read($, paused)) return
        const list = await read($, entries)
        const one = list.find(entry => entry.status === 'pending')
        if (!one) return

        await update($, entries, all =>
          all.map(entry =>
            entry.id === one.id ? { ...entry, status: 'working' as EntryStatus } : entry,
          ),
        )
        try {
          const translated = await translate($, settings, one.original, one.target)
          await update($, entries, all =>
            all.map(entry =>
              entry.id === one.id
                ? { ...entry, translated, status: 'done' as EntryStatus }
                : entry,
            ),
          )
        } catch (error) {
          await update($, entries, all =>
            all.map(entry =>
              entry.id === one.id
                ? { ...entry, status: 'error' as EntryStatus, error: errText(error) }
                : entry,
            ),
          )
        }
      } finally {
        isPumping = false
      }
    })()
  })
}

// ---------------------------------------------------------------- register

export const register: Register = (on, options) => {
  const base = settingsOf(options)
  const settingsRef = (): Settings => cached ?? base

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'zh', description: '打开翻译侧栏并聚焦输入框' })
    await $.command.register({ name: 'zh-close', description: '关闭翻译侧栏' })
    await $.command.register({ name: 'zh-config', description: '查看翻译端点配置（不显示 token）' })
    await $.command.register({ name: 'zh-test', description: '用一句话测试翻译端点是否可用' })
    await $.command.register({ name: 'zh-clear', description: '清空翻译侧栏的历史' })

    const opened = await $.ui.open({ id: PANE, title: '翻译' })
    if (!opened.isPlaced) {
      $.ui.status('翻译侧栏需要更宽的终端，或运行 /zh')
    }

    await getSettings($, base)
    startPump($, settingsRef)
    return next(e)
  })

  on('command.run', { command: 'zh' }, async $ => {
    await getSettings($, base)
    const opened = await $.ui.open({ id: PANE, title: '翻译', focus: true })
    return {
      text: opened.isPlaced ? '翻译侧栏已打开。' : `翻译侧栏没有落座：${opened.reason ?? '终端太窄'}`,
    }
  })

  on('command.run', { command: 'zh-close' }, async $ => {
    await $.ui.close({ id: PANE })
    return { text: '翻译侧栏已关闭。' }
  })

  on('command.run', { command: 'zh-clear' }, async $ => {
    await update($, entries, () => [])
    return { text: '翻译历史已清空。' }
  })

  on('command.run', { command: 'zh-config' }, async $ => {
    cached = undefined
    const current = await getSettings($, base)
    return {
      text: [
        `端点: ${current.baseUrl || '(未设置)'}`,
        `模型: ${current.model || '(未设置)'}`,
        `协议: ${current.protocol} / ${current.auth}`,
        `Token: ${current.token ? '已设置' : '(未设置)'}`,
        `配置文件: ${current.configPath}`,
      ].join('\n'),
    }
  })

  on('command.run', { command: 'zh-test' }, async $ => {
    cached = undefined
    const current = await getSettings($, base)
    if (!isReady(current)) {
      return { text: '未配置端点：写 ~/.claude/cc-translate.json 或设置插件配置后重试。' }
    }
    try {
      const out = await translate($, current, 'Translation endpoint self-test. Reply in Chinese.', 'zh')
      return { text: `端点可用（${hostOf(current.baseUrl)} · ${current.model}）\n${out}` }
    } catch (error) {
      return { text: `端点调用失败：${errText(error)}` }
    }
  })

  // A Chinese prompt typed in the main box becomes English before it is sent.
  on('prompt.submit', async ($, e, next) => {
    const current = await getSettings($, base)
    if (e.command || e.isMeta) return next(e)
    if (e.origin.kind === 'plugin') return next(e)
    const text = e.text
    if (!text.trim()) return next(e)

    if (hasCJK(text) && current.autoInput && isReady(current)) {
      try {
        const english = await translate($, current, text, 'en')
        const id = newId()
        await appendEntries(
          $,
          [
            {
              id,
              sig: `you:${id}`,
              role: 'you',
              original: text,
              translated: english,
              status: 'done',
              target: 'en',
            },
          ],
          current.maxEntries,
        )
        return next({ ...e, text: english })
      } catch (error) {
        await flash($, `输入翻译失败，按原文发送：${errText(error)}`)
      }
    }

    const id = newId()
    await appendEntries(
      $,
      [
        {
          id,
          sig: `you:${id}`,
          role: 'you',
          original: text,
          translated: isReady(current) ? '' : text,
          status: isReady(current) ? 'pending' : 'done',
          target: 'zh',
        },
      ],
      current.maxEntries,
    )
    return next(e)
  }).catch(($, e, next) => next(e))

  // After a turn, pick up the assistant text and tool calls it added.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const current = await getSettings($, base)
    const messages = await $.session.messages()
    if (!Array.isArray(messages)) return next(e)

    const known = (await read($, cursor)) ?? { count: 0, tail: '' }
    const tailMatches =
      known.count > 0 &&
      known.count <= messages.length &&
      hashOf(messages[known.count - 1].text) === known.tail
    const start = tailMatches ? known.count : Math.max(0, known.count - 6)

    const adds: Entry[] = []
    for (let index = start; index < messages.length; index += 1) {
      const message = messages[index]
      if (message.role !== 'assistant') continue
      const text = message.text.trim()
      if (text) {
        adds.push({
          id: newId(),
          sig: `a:${hashOf(text)}`,
          role: 'claude',
          original: text,
          translated: '',
          status: isReady(current) ? 'pending' : 'done',
          target: 'zh',
        })
      }
      for (const use of message.toolUses) adds.push(toolEntry(use))
    }

    if (adds.length > 0) await appendEntries($, adds, current.maxEntries)
    await update($, cursor, () => ({
      count: messages.length,
      tail: hashOf(messages[messages.length - 1]?.text ?? ''),
    }))
    return next(e)
  })

  // AskUserQuestion's dialog: translate the question and its options in place.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const current = await getSettings($, base)
    if (!isReady(current)) return next(e)
    const key = `${e.requestId}:${hashOf(JSON.stringify(e.props.questions))}`
    const hit = dialogCache.get(key)
    if (hit) return next({ ...e, props: { ...e.props, questions: hit } })

    void (async () => {
      try {
        const translated = await translateQuestions($, current, e.props.questions)
        if (dialogCache.size > MAX_DIALOG_CACHE) dialogCache.clear()
        dialogCache.set(key, translated)
        $.ui.invalidate('ui.render')
      } catch {
        // Leave the dialog as the engine drew it.
      }
    })()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e) as Record<string, any>
    const current = await getSettings($, base)
    const list = await read($, entries)
    const isShowingOriginal = await read($, showOriginal)
    const isPaused = await read($, paused)
    const line = await read($, status)
    await read($, tick)
    const canType = e.surface !== 'mobile'
    const host = current.baseUrl ? hostOf(current.baseUrl) : ''
    const header = isReady(current)
      ? `${host} · ${current.model}`
      : '未配置翻译端点（~/.claude/cc-translate.json）'
    const visible = list.slice(-120)

    // A value is drawn exactly once, only when the send/failure path asked for
    // one; every other redraw leaves the field alone so typing is not wiped.
    const fieldValue = pendingField?.text
    pendingField = undefined

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{header}</Text>
          <Text dimColor>{isPaused ? '· 已暂停' : '· 自动翻译'}</Text>
        </Box>
        {line ? <Text dimColor>{line}</Text> : null}

        {canType ? (
          <Box marginTop={1}>
            <Input
              key="compose"
              label="译"
              placeholder="输入中文，Enter 翻译并发送"
              submitLabel="send"
              value={fieldValue}
              onInput={(value: string) => {
                typedDraft = value
              }}
              onSubmit={(value: string) => {
                void doSend($, current, value)
              }}
            />
          </Box>
        ) : (
          <Text dimColor>在桌面端或终端打开本面板即可输入。</Text>
        )}

        <Box flexDirection="row" gap={1} marginTop={1}>
          {canType ? (
            <Button key="send" variant="primary" onPress={() => void doSend($, current, typedDraft)}>
              翻译并发送
            </Button>
          ) : null}
          {canType ? (
            <Button key="fill" onPress={() => void doFill($, current, typedDraft)}>
              翻译并填草稿
            </Button>
          ) : null}
          <Button key="pause" plain onPress={() => update($, paused, value => !value)}>
            {isPaused ? '继续' : '暂停'}
          </Button>
          <Button
            key="originals"
            plain
            onPress={() => update($, showOriginal, value => !value)}
          >
            {isShowingOriginal ? '隐藏原文' : '显示原文'}
          </Button>
          <Button key="clear" plain onPress={() => update($, entries, () => [])}>
            清空
          </Button>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {visible.length === 0 ? <Text dimColor>还没有对话。输入中文开始。</Text> : null}
          {visible.map(entry => (
            <Box key={entry.id} flexDirection="column" marginBottom={1}>
              <Text dimColor>{labelOf(entry)}</Text>
              {entry.status === 'pending' || entry.status === 'working' ? (
                <Text dimColor>翻译中…</Text>
              ) : entry.status === 'error' ? (
                <Text dimColor>翻译失败：{entry.error ?? ''}</Text>
              ) : (
                <Markdown text={entry.translated || entry.original} />
              )}
              {isShowingOriginal && entry.role !== 'tool' && entry.original ? (
                <Text dimColor wrap="truncate-end">
                  {preview(entry.original)}
                </Text>
              ) : null}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
