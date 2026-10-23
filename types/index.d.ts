export type EntryRole = 'you' | 'claude' | 'tool' | 'note'
export type EntryStatus = 'pending' | 'working' | 'done' | 'error'
export type EntryTarget = 'zh' | 'en'

export type Entry = {
  id: string
  sig: string
  role: EntryRole
  original: string
  translated: string
  status: EntryStatus
  target: EntryTarget
  error?: string
}

export type Cursor = {
  count: number
  tail: string
}

declare module 'claude-code' {
  interface PluginState {
    'cc-translate': {
      entries: Shaped<Entry[]>
      cursor: Shaped<Cursor>
      showOriginal: boolean
      paused: boolean
      status: string
      tick: number
    }
  }
}
