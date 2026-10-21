/** Стан слухача, як його останнім записав listener.py у bus.json. */
export type VoiceState =
  | 'off'
  | 'loading'
  | 'ready'
  | 'armed'
  | 'transcribing'
  | 'muted'
  | 'error'

export type VoiceStatus = { state: VoiceState; msg: string | null }

/** Рядок журналу панелі (подія з bus.json). */
export type VoiceEntry = {
  seq: number
  kind: 'command' | 'ignored' | 'part' | 'cancelled' | 'info' | 'error'
  text: string
  ms: number | null
}

/** Чия сесія отримує команди: ця, інша чи жодна. */
export type VoiceOwner = 'me' | 'other' | 'none'

/**
 * Що чекає на «так» людини: голосова КОМАНДА, яку фільтр визнав ризиковою,
 * або руйнівна ДІЯ, яку гвард зупинив у ході, запущеному голосом.
 */
export type VoicePending = {
  kind: 'command' | 'action'
  text: string
  raw: string | null
  reason: string
  at: number
  key: string | null
}

/**
 * Налаштування з вікна ⚙ — у control.json, спільні для всіх сесій і слухача.
 * `beep`: off — тиша; wake — сигнал, щойно почуто активатор; end — коли команду завершено;
 *   both — обидва.
 * `autoEnd`: false — команда триває до стоп-слова, тиша її не обриває.
 * `wake` / `stop` / `cancel`: слова через кому; порожній `wake` — дефолт слухача, `cancel` — слово
 *   скасування команди (діє в обох режимах).
 * `prompt` / `hotwords`: своя підказка розпізнавачу і свої слова-підказки (слова
 *   свого проєкту); порожньо — загальні зі слухача.
 * `language`: мова інтерфейсу мода й розпізнавання; порожні `wake` / `stop` / `cancel` / `prompt`
 *   означають типові для неї.
 */
export type VoiceSettings = {
  beep: 'off' | 'wake' | 'end' | 'both'
  autoEnd: boolean
  wake: string
  stop: string
  cancel: string
  prompt: string
  hotwords: string
  language: 'uk' | 'en'
  /** off — без моделі (лише локальний список); both — чистка + «розпізнано»; clean — лише чистка. */
  filterMode: 'off' | 'both' | 'clean'
  filterModel: 'haiku' | 'sonnet'
  filterTimeoutMs: 3000 | 6000 | 10000
  /** Власні правила чистки — дописуються до системної інструкції фільтра. */
  filterNotes: string
  /** Своя системна інструкція фільтра; порожньо = типова мови (safety.defaultFilterSystem). */
  filterSystem: string
  /** Моделі розпізнавання; порожньо = типова для пристрою (читає слухач). */
  wakeModel: string
  model: string
  /** Фраза зміни чату (експериментально) одразу після активатора; порожньо = типова мови. */
  chat: string
  /** Агенти в голосовому режимі самі додають правила в словник (інструмент add_term). */
  autoTerms: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'voice-mod': {
      status: VoiceStatus
      log: VoiceEntry[]
      muted: boolean
      owner: VoiceOwner
      /** Власника закріплено (🔒): відправка в інших чатах його не перехоплює. */
      locked: boolean
      /** Назва чату, що слухає (коли це інший чат); null — невідома. */
      ownerTitle: string | null
      /** Гвард дій увімкнено: хід запустив голос, і людина відтоді нічого не набирала. */
      guarded: boolean
      pending: VoicePending | null
      decisions: string[]
      /** Небезпечне підтверджується лише мишкою чи текстом; за замовчуванням увімкнено. */
      safeMode: boolean
      /** Журнал почутого розгорнуто під рядком панелі. */
      historyOpen: boolean
      /** Вікно налаштувань (⚙) відкрите. */
      settingsOpen: boolean
      /** Розділ «Розширені» у ⚙ розгорнуто. */
      advancedOpen: boolean
      settings: VoiceSettings
      /** Відкрита підказка ⓘ у вікні ⚙ (ключ поля й коли натиснули); одна одночасно. */
      hint: { key: string; at: number } | null
      /** Текст особистого словника (glossary.txt), поки відкрите ⚙; null — ще не читали. */
      glossary: string | null
      /** Чернетки полів від «Згенерувати»; null — чернетки нема. */
      glossaryDraft: string | null
      hotwordsDraft: string | null
      /** Генерація термінології агентом: стан, повідомлення під полем, id агента. */
      glossaryGen: { state: 'running' | 'done' | 'error'; msg: string; at: number; agentId: string | null } | null
      /** Моделі розпізнавання, що вже на диску (звітує слухач у bus.json). */
      models: string[]
      /** Пристрій розпізнавання слухача: від нього залежать типові моделі й пам'ять у списках. */
      device: 'cuda' | 'cpu'
    }
  }
}
