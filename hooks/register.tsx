import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, Register, RenderChildren } from 'claude-code'

import type { VoiceEntry, VoiceOwner, VoicePending, VoiceSettings, VoiceState, VoiceStatus } from '../types'
import { chatPhraseRest, matchChat, parseListing } from './chats'
import {
  ADD_TERM_DESCRIPTION,
  checkRule,
  generatorPrompt,
  glossaryStats,
  isGeneratorReply,
  knownHeard,
  mergeHotwords,
  parseGenerated,
  ruleLine,
} from './glossary'
import type { Chat, Listing } from './chats'
import { DEFAULT_WORDS, STR, langOf, reasonText } from './i18n'
import type { Strings } from './i18n'
import { DEFAULT_MODEL, isUnsuitable, modelOptions } from './models'
import type { Lang, Slot } from './models'
import { cleanForSpeech, findSpeakBlock, speakLang, speakSection, voiceOf, voiceOptions } from './speak'
import type { SpeakLang } from './speak'
import {
  callKey,
  describeCall,
  destructiveReason,
  filterPrompt,
  defaultFilterSystem,
  filterSystem,
  isNo,
  isYes,
  parseFilterReply,
} from './safety'

// Голосові команди. Мод вантажать УСІ сесії, а слухач (listener.py) — один
// на машину: його піднімає будь-яка сесія, другий екземпляр сам виходить
// (mutex). Обмін — файлами в ~/.claude/voice-mod:
//   bus.json     стан слухача + останні події з наскрізним seq (пише слухач)
//   owner.json   яка сесія отримує команди (пишуть сесії)
//   control.json мікрофон вимкнено чи ні (пишуть сесії, читає слухач)
// Команди забирає лише сесія-власник. Власником стає та, де людина востаннє
// щось відправила, натиснула «Слухати тут» чи набрала /voice-here: сигналу
// «цей чат зараз на екрані» API модів не дає. Замочок (🔒, /voice-lock)
// закріплює власника: відправка в інших чатах його не перехоплює, лише явне
// «Слухати тут» (і воно ж знімає закріплення). Закріплення живе в owner.json —
// його бачать усі сесії; сесія-власник закрилась — закріплення зникає з нею.
//
// Зміна чату (експериментально): «Клоде, зміна чату <назва>, <команда>» — лише
// на початку команди. Власник питає ListAgents назви чатів, зіставляє їх із
// сесіями мода за ref (кожна сесія пише свій у alive-<session>.json) і кладе
// в owner.json нового власника з `handoff` — командою, яку той забирає сам:
// фільтр і картки підтвердження працюють у тому чаті, де команда виконається.
//
// Безпека — два шари (логіка в safety.ts):
//   команда: модель чистить текст і ставить мітку ризику, локальний список
//     слів страхує; «підтвердити» → картка, «Клоде, так/ні» або кнопка;
//   дія: у ході, запущеному голосом, руйнівний виклик інструмента
//     зупиняється до «так» людини — і тоді дозволений рівно ТОЙ САМИЙ виклик.

const PANE = 'voice'
const PANE_ROWS = 10 // панель — лише історія: рядок стану живе над полем вводу
const SETTINGS_PANE = 'voice-settings'
const SETTINGS_ROWS = 30
const HINT_MS = 10_000 // підказка ⓘ закривається сама
const TICK_MS = 500
const BUS_STALE_MS = 4000 // слухач пише серцебиття раз на секунду
const OWNER_STALE_MS = 8000
const OWNER_BEAT_MS = 2000
const SPAWN_GAP_MS = 15_000 // модель вантажиться секунди — не плодити спроб
const ALIVE_BEAT_MS = 5000 // пульс сесії для слухача: без жодного 2 хв — він виходить
const ALIVE_FRESH_MS = 15_000 // чат, що стільки не писав пульсу, у зміну чату не потрапляє
const REF_RETRY_MS = 60_000 // свій ref з ListAgents — повтор, якщо не вийшло
const TITLE_REFRESH_MS = 120_000 // назву чату людина могла змінити, а застосунок — дати сам
const PENDING_COMMAND_MS = 30_000 // команду без відповіді — скасувати
const PENDING_ACTION_MS = 120_000
const CARD_SETTLE_MS = 1500 // свіжу картку кнопкою не підтвердити
const GEN_TIMEOUT_MS = 10 * 60_000 // агент-генератор, що мовчить довше, вважаємо зниклим
const ADD_TERM = 'mcp__voice-mod__add_term'
const APPROVAL_MS = 120_000 // дозвіл на дію живе стільки, і лише на один виклик
const VOICE_MARK = '🎙'

const status = atom({ plugin: 'voice-mod', key: 'status' } as const, {
  state: 'off',
  msg: null,
})
const log = atom({ plugin: 'voice-mod', key: 'log' } as const, [])
const muted = atom({ plugin: 'voice-mod', key: 'muted' } as const, false)
const owner = atom({ plugin: 'voice-mod', key: 'owner' } as const, 'none')
const locked = atom({ plugin: 'voice-mod', key: 'locked' } as const, false)
// Назва чату, що зараз слухає (коли це інший чат) — з його alive-файлу; null — невідома.
const ownerTitle = atom({ plugin: 'voice-mod', key: 'ownerTitle' } as const, null)
// Гвард дій увімкнено: ходом заправляв голос, і людина відтоді нічого не набирала.
const guarded = atom({ plugin: 'voice-mod', key: 'guarded' } as const, false)
const pending = atom({ plugin: 'voice-mod', key: 'pending' } as const, null)
const decisions = atom({ plugin: 'voice-mod', key: 'decisions' } as const, [])
// Безпечний режим: небезпечне підтверджується лише мишкою чи текстом, голосом —
// ні (чужий голос, відео, обмовка). Живе в control.json — один на всі сесії;
// нема поля → увімкнено.
const safeMode = atom({ plugin: 'voice-mod', key: 'safeMode' } as const, true)
const historyOpen = atom({ plugin: 'voice-mod', key: 'historyOpen' } as const, false)
const settingsOpen = atom({ plugin: 'voice-mod', key: 'settingsOpen' } as const, false)
// «Розширені» у ⚙ розгорнуто; базові налаштування видно завжди.
const advancedOpen = atom({ plugin: 'voice-mod', key: 'advancedOpen' } as const, false)
const SETTINGS_DEFAULT: VoiceSettings = {
  beep: 'end',
  autoEnd: true,
  wake: '',
  stop: '', // порожнє = стоп-слово за замовчуванням для мови (DEFAULT_WORDS)
  cancel: '', // порожнє = слово скасування за замовчуванням для мови
  prompt: '',
  hotwords: '',
  language: 'uk',
  filterMode: 'both',
  filterModel: 'haiku',
  filterTimeoutMs: 6000,
  filterNotes: '',
  filterSystem: '',
  wakeModel: '',
  model: '',
  chat: '',
  autoTerms: true,
  speak: false,
  speakVoiceUk: '',
  speakVoiceEn: '',
}
const settings = atom({ plugin: 'voice-mod', key: 'settings' } as const, SETTINGS_DEFAULT)
// Текст особистого словника, як він на диску, — для редактора у ⚙ (читає тік, поки ⚙ відкрите).
const glossary = atom({ plugin: 'voice-mod', key: 'glossary' } as const, null)
// Чернетки полів словника й слів-підказок від «Згенерувати»: на диск — лише Enter людини.
const glossaryDraft = atom({ plugin: 'voice-mod', key: 'glossaryDraft' } as const, null)
const hotwordsDraft = atom({ plugin: 'voice-mod', key: 'hotwordsDraft' } as const, null)
const glossaryGen = atom({ plugin: 'voice-mod', key: 'glossaryGen' } as const, null)
// Відкрита підказка ⓘ у ⚙ (одна на всіх); тік закриває її через HINT_MS.
const hint = atom({ plugin: 'voice-mod', key: 'hint' } as const, null)
// Що слухач звітує в bus.json: моделі на диску й пристрій (від нього типові моделі).
const models = atom({ plugin: 'voice-mod', key: 'models' } as const, [])
const device = atom({ plugin: 'voice-mod', key: 'device' } as const, 'cuda')
// Модуль озвучення (Piper) і голоси на диску — звітує слухач у bus.json, як models.
const tts = atom({ plugin: 'voice-mod', key: 'tts' } as const, 'absent')
const voices = atom({ plugin: 'voice-mod', key: 'voices' } as const, [])
// Кнопки ⚙ озвучення виконує слухач: не працює — у ⚙ підказка замість мертвої кнопки.
const listener = atom({ plugin: 'voice-mod', key: 'listener' } as const, 'down')

// Короткі підписи для рядка панелі: він один, поруч іще останнє почуте й кнопки.
const shortOf = (t: Strings, state: VoiceState): string =>
  ({
    off: t.stateOff,
    loading: t.stateLoading,
    ready: t.stateReady,
    armed: t.stateArmed,
    transcribing: t.stateTranscribing,
    speaking: t.stateSpeaking,
    muted: t.stateMuted,
    error: t.stateError,
  })[state]

// Ключі теми, а не сирі кольори: застосунок сам веде їх за світлою/темною темою.
const DOT: Record<VoiceState, string> = {
  off: 'inactive',
  loading: 'warning',
  ready: 'success',
  armed: 'claude',
  transcribing: 'suggestion',
  speaking: 'suggestion',
  muted: 'inactive',
  error: 'error',
}

const ICON: Record<VoiceState, string> = {
  off: '⚪',
  loading: '⏳',
  ready: '🟢',
  armed: '🟡',
  transcribing: '🔵',
  speaking: '🔊',
  muted: '🔇',
  error: '🔴',
}

const KINDS = new Set(['command', 'ignored', 'part', 'spoke', 'cancelled', 'info', 'error'])
const STATES = new Set<string>(['off', 'loading', 'ready', 'armed', 'transcribing', 'speaking', 'muted', 'error'])

type Paths = {
  python: string
  home: string
  script: string
  bus: string
  owner: string
  control: string
  glossary: string
  speak: string
}

const TTS_STATES = new Set<string>(['absent', 'installing', 'ready', 'error'])

type BusEvent = { seq: number; kind: string; text?: string | null; ms?: number | null }
export type Bus = {
  at: number
  state: string
  msg: string | null
  seq: number
  events: BusEvent[]
  models: string[] | null // нема поля (старий слухач) → null
  device: 'cuda' | 'cpu' | null
  tts: 'absent' | 'installing' | 'ready' | 'error' | null // нема поля → null
  voices: string[] | null
}
// handoff — команда, передана зміною чату новому власнику; seq — подія bus.json,
// з якої її взято (новий власник цю подію сам не обробляє).
type Handoff = { id: string; seq: number; text: string }
// why — чому голос тут: людина написала в цьому чаті, натиснула «Сюди», сказала «зміна
// чату» чи це перша сесія; інші чати показують цю причину в сповіщенні про перемикання.
export type Why = 'typed' | 'button' | 'voice' | 'first'
type Owner = { session: string | null; at: number; locked: boolean; handoff: Handoff | null; why: Why | null }
const WHYS = new Set<string>(['typed', 'button', 'voice', 'first'])

/** bus.json → дані або null (нема файлу, пишеться саме зараз, битий). */
export function parseBus(text: string): Bus | null {
  try {
    const v = JSON.parse(text) as Partial<Bus>
    if (typeof v.at !== 'number' || typeof v.seq !== 'number' || !Array.isArray(v.events)) return null
    return {
      at: v.at,
      state: String(v.state),
      msg: v.msg ?? null,
      seq: v.seq,
      events: v.events,
      models: Array.isArray(v.models) ? v.models.filter((m): m is string => typeof m === 'string') : null,
      device: v.device === 'cuda' || v.device === 'cpu' ? v.device : null,
      tts: TTS_STATES.has(String(v.tts)) ? (v.tts as Bus['tts']) : null,
      voices: Array.isArray(v.voices) ? v.voices.filter((m): m is string => typeof m === 'string') : null,
    }
  } catch {
    return null
  }
}

/** Події bus.json → рядки журналу панелі (лише відомих видів). */
export function toEntries(events: readonly BusEvent[]): VoiceEntry[] {
  return events
    .filter(ev => KINDS.has(ev.kind) && typeof ev.text === 'string')
    .map(ev => ({
      seq: ev.seq,
      kind: ev.kind as VoiceEntry['kind'],
      text: ev.text as string,
      ms: typeof ev.ms === 'number' ? ev.ms : null,
    }))
}

/** Хто власник для сесії `me`, з урахуванням давності запису. */
export function ownerOf(o: Owner | null, me: string, now: number): VoiceOwner {
  if (!o || !o.session || now - o.at > OWNER_STALE_MS) return 'none'
  return o.session === me ? 'me' : 'other'
}

/** Закріплення діє, лише поки власник живий (пише пульс). */
export function isLockedOf(o: Owner | null, now: number): boolean {
  return ownerOf(o, '', now) !== 'none' && o?.locked === true
}

// Живуть до перезавантаження мода (новий модуль — нові змінні); стан панелі — в атомах.
// Обіцянка першого boot: паралельні виклики (prompt.submit і stop) чекають той самий, а не
// виходять одразу з ще порожнім mySession.
let booting: Promise<void> | undefined
let mySession = ''
let lastSeq = -1 // -1: ще не читали bus — старі команди не повторюємо
let shownSeq = -1
let lastSpawnAt = 0
let lastOwnerBeat = 0
let lastAliveBeat = 0
let commandsLang: Lang | null = null // мова, якою зареєстровано slash-команди
let statusKey = '' // що востаннє показано в рядку стану застосунку
let ticker: { cancel: () => void } | undefined
let daemon: HookStream<{ stream: 'stdout' | 'stderr'; text: string }, unknown> | undefined
const queue: Queued[] = []
let isDraining = false
// Людина набрала повідомлення — наступний хід уже її, і гвард знімається. Ходи від
// фонових задач, сповіщень і розкладу гвард не знімають: їх міг запустити голос.
let isHumanNext = false
let isTicking = false // тік довший за TICK_MS не має накладатися на наступний
let skipSeq = -1 // подія bus.json, передана сюди зміною чату: її несе handoff, не шина
let ownerChain: Promise<unknown> = Promise.resolve()
const approvals = new Map<string, number>() // ключ виклику → коли дозволили
// Хід головного циклу цієї сесії, що йде зараз; null — сесія вільна або невідомо
// (мод перезавантажили посеред ходу) — тоді команда йде як завжди, prompt.submit.
let mainTurn: string | null = null
// Команди, сказані, поки агент працює: prompt.submit плагіна чекав би кінця ходу, тож
// вони йдуть контекстом результату наступного інструмента головного циклу, а якщо
// інструментів уже не буде — prompt.submit на turn.complete.
const midTurn: { text: string; raw: string | null }[] = []
// Відповідь, набрана в чаті: хук prompt.submit лише кладе її сюди, а виконує
// тік — відправка нового промпту зсередини того самого хука губиться.
let typedAnswer: 'yes' | 'no' | null = null
let myRef: string | null = null // як ListAgents називає цей чат («[e4001a]»)
let myTitle: string | null = null // назва цього чату в бічній панелі — для інших чатів
let lastRefAt = 0
// Власник, якого цей чат бачив на минулому тіку: зміна → сповіщення з причиною.
// undefined — ще не дивились (старт і перезавантаження мода не сповіщають).
let seenOwner: string | null | undefined
let lastHandoff = '' // id останньої забраної передачі
// isCancel — слухач скасував порожню команду («Клоде, відміна»): лише відхиляє висячу картку.
type Queued = { text: string; seq: number; isHandoff: boolean; isCancel?: boolean }

async function paths($: EngineInterface): Promise<Paths> {
  const profile = (await $.env.get('USERPROFILE')) ?? ''
  const home = `${profile}\\.claude\\voice-mod`
  return {
    home,
    python: `${home}\\venv\\Scripts\\python.exe`,
    script: `${$.plugin.root}\\listener\\listener.py`,
    bus: `${home}\\bus.json`,
    owner: `${home}\\owner.json`,
    control: `${home}\\control.json`,
    glossary: `${home}\\glossary.txt`,
    speak: `${home}\\speak.json`,
  }
}

// Запит слухачу: текст блоку відповіді або stop. Файл пишемо цілим (не злиттям) і без BOM;
// seq = at = мс, щоб слухач відрізняв новий запит і відкидав застарілий.
type SpeakRequest = { seq: number; at: number; session: string } & (
  | { text: string; lang: SpeakLang; voice: string }
  | { stop: true }
)

async function requestSpeak($: EngineInterface, req: SpeakRequest): Promise<void> {
  const p = await paths($)
  await $.fs.write(p.speak, JSON.stringify(req))
}

/** Запит від імені цієї сесії; час береться тут. */
async function sendSpeak(
  $: EngineInterface,
  body: { text: string; lang: SpeakLang; voice: string } | { stop: true },
): Promise<void> {
  const at = await $.clock.now()
  await requestSpeak($, { seq: at, at, session: mySession, ...body })
}

/** stop — лише коли озвучення ввімкнене: вимкнене не пише жодного файлу (слухач і так
 * замовкає сам, щойно в control.json speak: false). */
async function stopSpeaking($: EngineInterface): Promise<void> {
  if ((await read($, settings)).speak) await sendSpeak($, { stop: true })
}

async function readJson($: EngineInterface, path: string): Promise<string | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    return await $.fs.read(path)
  } catch {
    return null
  }
}

async function readOwner($: EngineInterface, p: Paths): Promise<Owner | null> {
  const text = await readJson($, p.owner)
  if (!text) return null
  try {
    const v = JSON.parse(text) as Partial<Owner>
    const h = v.handoff
    return {
      session: typeof v.session === 'string' ? v.session : null,
      at: Number(v.at) || 0,
      locked: v.locked === true,
      handoff:
        h && typeof h.id === 'string' && typeof h.seq === 'number' && typeof h.text === 'string'
          ? { id: h.id, seq: h.seq, text: h.text }
          : null,
      why: typeof v.why === 'string' && WHYS.has(v.why) ? (v.why as Why) : null,
    }
  } catch {
    return null
  }
}

/**
 * Кожне «прочитати → записати» owner.json у цій сесії — по черзі: інакше пульс,
 * claim і зміна чату, що йдуть паралельно (тік і черга команд), перетирають одне
 * одного — і передана команда губиться.
 */
function withOwner<T>(fn: () => Promise<T>): Promise<T> {
  const run = ownerChain.then(fn, fn)
  ownerChain = run.catch(() => {})
  return run
}

/**
 * Стати власником. `auto` — неявне (відправили повідомлення, перша сесія): чужий
 * закріплений власник не перехоплюється. `explicit` — «Сюди» / /voice-here: бере
 * завжди, а чуже закріплення знімає. Своє закріплення лишається. `why` — причина для
 * сповіщень; голос, що вже тут, причини не міняє (пульс від набраного не «перемикання»).
 */
function claim($: EngineInterface, how: 'auto' | 'explicit', why: Why): Promise<void> {
  return withOwner(async () => {
    const p = await paths($)
    const now = await $.clock.now()
    const o = await readOwner($, p)
    const isMine = o?.session === mySession
    if (how === 'auto' && !isMine && isLockedOf(o, now)) return
    const isLocked = isMine && o?.locked === true
    // Свою ще не забрану передачу не губимо.
    const handoff = isMine ? (o?.handoff ?? null) : null
    const reason = isMine && ownerOf(o, mySession, now) === 'me' ? (o?.why ?? why) : why
    await $.fs.write(p.owner, JSON.stringify({ session: mySession, at: now, locked: isLocked, handoff, why: reason }))
    lastOwnerBeat = now
    await update($, owner, () => 'me')
    await update($, locked, () => isLocked)
    // Голос перейшов сюди (був чужий чи нікого) — що б не говорилось у чаті попереднього власника, зупинити.
    if (ownerOf(o, mySession, now) !== 'me') await stopSpeaking($).catch(() => {})
  })
}

/** Замочок: закріплює чи знімає лише власник; повертає, що вийшло (null — не власник). */
function setLocked($: EngineInterface, value: boolean): Promise<boolean | null> {
  return withOwner(async () => {
    const p = await paths($)
    const now = await $.clock.now()
    const o = await readOwner($, p)
    if (ownerOf(o, mySession, now) !== 'me') return null
    await $.fs.write(p.owner, JSON.stringify({ session: mySession, at: now, locked: value, handoff: o?.handoff ?? null, why: o?.why ?? null }))
    lastOwnerBeat = now
    await update($, locked, () => value)
    return value
  })
}

function release($: EngineInterface): Promise<void> {
  return withOwner(async () => {
    const p = await paths($)
    const o = await readOwner($, p)
    if (o?.session === mySession) {
      await $.fs.write(p.owner, JSON.stringify({ session: null, at: 0, locked: false }))
    }
  })
}

/** Пульс власника: перечитати і писати, лише якщо голос досі тут; закріплення й передачу переносить. */
function ownerBeat($: EngineInterface, now: number): Promise<void> {
  return withOwner(async () => {
    const p = await paths($)
    const fresh = await readOwner($, p)
    if (fresh?.session !== mySession) return
    await $.fs.write(p.owner, JSON.stringify({ session: mySession, at: now, locked: fresh.locked, handoff: fresh.handoff, why: fresh.why }))
    lastOwnerBeat = now
  })
}

/** Голос передали сюди зміною чату: спершу в чергу, потім прибрати з файлу (збій запису не губить команду). */
function takeHandoff($: EngineInterface, t: Strings, now: number): Promise<void> {
  return withOwner(async () => {
    const p = await paths($)
    const fresh = await readOwner($, p)
    const hand = fresh?.session === mySession ? fresh.handoff : null
    if (!hand || hand.id === lastHandoff) return
    lastHandoff = hand.id
    skipSeq = hand.seq
    if (hand.text) queue.push({ text: hand.text, seq: -1, isHandoff: true })
    await note($, t.noteChatArrived(hand.text))
    await $.fs.write(p.owner, JSON.stringify({ session: mySession, at: now, locked: fresh?.locked === true, why: fresh?.why ?? 'voice' }))
    lastOwnerBeat = now
    // Голос перейшов сюди — що говорилось у чаті попереднього власника, замовкає.
    await stopSpeaking($).catch(() => {})
  })
}

/** ListAgents, якщо дозволено без питання людини (діалог щохвилини — гірше, ніж без функції). */
async function listAgents($: EngineInterface): Promise<Listing | null> {
  try {
    if ((await $.tool.check({ tool: 'ListAgents', input: {} })).decision !== 'allow') return null
    const r = await $.tool.call({ tool: 'ListAgents' })
    const listing = (r.result as { listing?: unknown } | undefined)?.listing
    return typeof listing === 'string' ? parseListing(listing) : null
  } catch {
    return null
  }
}

/** Свій ref і назва з ListAgents: ref — щоб зміна чату знайшла цей чат, назва — щоб інші показали її. */
async function refreshSelf($: EngineInterface): Promise<void> {
  const self = (await listAgents($))?.self
  if (!self) return
  myRef = self.ref
  myTitle = self.title
}

/** Назва чату-сесії з її alive-файлу; null — файлу нема чи назви ще не дізнались. */
async function titleOf($: EngineInterface, session: string): Promise<string | null> {
  try {
    const v = JSON.parse((await readJson($, `${(await paths($)).home}\\alive-${session}.json`)) ?? '{}') as { title?: unknown }
    return typeof v.title === 'string' && v.title.trim() ? v.title.trim() : null
  } catch {
    return null
  }
}

/** Власник змінився — сповістити в цьому чаті, куди пішов голос і чому. */
async function announceOwner($: EngineInterface, t: Strings, cur: string | null, why: Why | null): Promise<void> {
  const text =
    cur === null
      ? t.switchNone
      : cur === mySession
        ? t.switchHere(why ?? '')
        : t.switchThere((await titleOf($, cur)) ?? t.otherChat, why ?? '')
  await note($, text)
  $.ui.toast(text)
}

/** Чати, куди можна передати голос: цей і ті, де мод живий і його ref відомий. */
async function chatsNow($: EngineInterface, listing: Listing): Promise<Chat[]> {
  const p = await paths($)
  const now = await $.clock.now()
  const byRef = new Map<string, string>()
  for (const f of await $.fs.list(p.home).catch(() => [])) {
    const m = /^alive-(.+)\.json$/.exec(f.name)
    if (!m?.[1] || m[1] === mySession) continue
    try {
      const v = JSON.parse((await readJson($, `${p.home}\\${f.name}`)) ?? '{}') as { at?: number; ref?: string }
      if (typeof v.ref === 'string' && now - Number(v.at) < ALIVE_FRESH_MS) byRef.set(v.ref, m[1])
    } catch {
      // битий чи недописаний файл — цей чат пропускаємо
    }
  }
  const chats: Chat[] = listing.self ? [{ id: mySession, title: listing.self.title }] : []
  for (const peer of listing.peers) {
    const id = byRef.get(peer.ref)
    if (id) chats.push({ id, title: peer.title })
  }
  return chats
}

/** «Зміна чату <назва>, <команда>»: знайти чат і віддати йому голос разом із командою. */
async function switchChat($: EngineInterface, t: Strings, rest: string, seq: number): Promise<void> {
  const fail = async (text: string) => {
    await note($, text)
    $.ui.toast(text)
  }
  if (!rest) return fail(t.chatNoName)
  const listing = await listAgents($)
  if (!listing) return fail(t.chatUnavailable)
  const found = matchChat(rest, await chatsNow($, listing))
  if (!found) return fail(t.chatNotFound(rest.length > 40 ? `${rest.slice(0, 39)}…` : rest))
  if ('ambiguous' in found) return fail(t.chatAmbiguous(found.ambiguous.map(c => `«${c.title}»`).join(', ')))
  const { chat, text } = found
  if (chat.id === mySession) {
    await note($, t.noteChatHere(chat.title))
    if (text) await handleCommand($, { text, seq: -1, isHandoff: true })
    return
  }
  const isSent = await withOwner(async () => {
    const p = await paths($)
    const now = await $.clock.now()
    const o = await readOwner($, p)
    // Поки питали ListAgents, голос могли забрати — тоді чужим замком не розпоряджаємось.
    if (ownerOf(o, mySession, now) !== 'me') return false
    const handoff: Handoff = { id: `${mySession}:${now}`, seq, text }
    await $.fs.write(p.owner, JSON.stringify({ session: chat.id, at: now, locked: o?.locked === true, handoff, why: 'voice' }))
    return true
  })
  if (!isSent) return fail(t.chatLost)
  await update($, owner, () => 'other')
  await note($, t.noteChatSwitched(chat.title, text)) // саме перемикання сповістить тік
}

type Control = { muted?: boolean; safeMode?: boolean; restart?: number; cancelAt?: number; ttsInstall?: number; ttsRemove?: number } & Partial<VoiceSettings>

/** control.json → налаштування; невідоме чи бите значення — дефолт. */
export function settingsOf(c: Control): VoiceSettings {
  return {
    beep: c.beep === 'off' || c.beep === 'wake' || c.beep === 'both' ? c.beep : 'end',
    autoEnd: c.autoEnd !== false,
    wake: typeof c.wake === 'string' ? c.wake.trim() : '',
    stop: typeof c.stop === 'string' ? c.stop.trim() : '',
    cancel: typeof c.cancel === 'string' ? c.cancel.trim() : '',
    prompt: typeof c.prompt === 'string' ? c.prompt.trim() : '',
    hotwords: typeof c.hotwords === 'string' ? c.hotwords.trim() : '',
    language: langOf(c.language),
    filterMode: c.filterMode === 'off' || c.filterMode === 'clean' ? c.filterMode : 'both',
    filterModel: c.filterModel === 'sonnet' ? 'sonnet' : 'haiku',
    filterTimeoutMs: c.filterTimeoutMs === 3000 || c.filterTimeoutMs === 10000 ? c.filterTimeoutMs : 6000,
    filterNotes: typeof c.filterNotes === 'string' ? c.filterNotes.trim() : '',
    filterSystem: typeof c.filterSystem === 'string' ? c.filterSystem.trim() : '',
    wakeModel: typeof c.wakeModel === 'string' ? c.wakeModel.trim() : '',
    model: typeof c.model === 'string' ? c.model.trim() : '',
    chat: typeof c.chat === 'string' ? c.chat.trim() : '',
    autoTerms: c.autoTerms !== false,
    speak: c.speak === true,
    speakVoiceUk: typeof c.speakVoiceUk === 'string' ? c.speakVoiceUk.trim() : '',
    speakVoiceEn: typeof c.speakVoiceEn === 'string' ? c.speakVoiceEn.trim() : '',
  }
}

/** Перше слово зі списку через кому — як його показувати людині. */
export function firstWord(list: string, fallback: string): string {
  const w = (list.split(',')[0] ?? '').trim() || fallback
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/** control.json — спільний для всіх сесій і слухача; пишемо злиттям, не поверх. */
async function writeControl($: EngineInterface, patch: Control): Promise<void> {
  const p = await paths($)
  let cur: Control = {}
  try {
    cur = JSON.parse((await readJson($, p.control)) ?? '{}') as Control
  } catch {
    cur = {}
  }
  await $.fs.write(p.control, JSON.stringify({ ...cur, ...patch }))
}

async function setMuted($: EngineInterface, value: boolean): Promise<void> {
  await writeControl($, { muted: value })
  if (!value) lastSpawnAt = 0 // увімкнули — слухача піднімаємо на найближчому тіку
  await update($, muted, () => value)
}

/** Рядки мовою з налаштувань (її оновлює тік і сам ⚙). */
async function strings($: EngineInterface): Promise<Strings> {
  return STR[(await read($, settings)).language]
}

async function setSafeMode($: EngineInterface, value: boolean): Promise<void> {
  await writeControl($, { safeMode: value })
  await update($, safeMode, () => value)
  const t = await strings($)
  await note($, value ? t.noteSafeOn : t.noteSafeOff)
}

/**
 * Піднімає слухача ВІДВ'ЯЗАНИМ процесом (`--detach`): дочірній процес мода
 * гине разом із модулем — кінець сесії чи hot-reload коштували б 20 с
 * завантаження моделей. Сам слухач виходить, коли 2 хв нема жодної сесії.
 * Якщо інший уже живий — новий вийде сам (mutex).
 */
async function runDaemon($: EngineInterface, p: Paths): Promise<void> {
  const child = $.process.spawn({
    argv: [p.python, '-u', p.script, '--home', p.home, '--detach'],
    env: {
      HF_HOME: `${p.home}\\hf`,
      HF_HUB_OFFLINE: '1', // моделі вже на диску — старт без мережі
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    },
  })
  daemon = child
  try {
    // Стан іде через bus.json; вивід лише вичитуємо, щоб труба не забилась.
    for (;;) {
      const step = await child.next()
      if (step.done) break
    }
  } finally {
    daemon = undefined
  }
}

async function tick($: EngineInterface): Promise<void> {
  const p = await paths($)
  const now = await $.clock.now()
  const bus = parseBus((await readJson($, p.bus)) ?? '')
  const isAlive = bus !== null && bus.state !== 'off' && now - bus.at < BUS_STALE_MS

  if (now - lastAliveBeat > ALIVE_BEAT_MS) {
    lastAliveBeat = now
    await $.fs.write(`${p.home}\\alive-${mySession}.json`, JSON.stringify({ at: now, ref: myRef, title: myTitle }))
  }
  if (now - lastRefAt > (myRef ? TITLE_REFRESH_MS : REF_RETRY_MS)) {
    lastRefAt = now
    void refreshSelf($).catch(() => {})
  }

  let control: Control = {}
  try {
    control = JSON.parse((await readJson($, p.control)) ?? '{}') as Control
  } catch {
    control = {}
  }
  const isMuted = control.muted === true
  const isSafe = control.safeMode !== false
  if ((await read($, muted)) !== isMuted) await update($, muted, () => isMuted)
  if ((await read($, safeMode)) !== isSafe) await update($, safeMode, () => isSafe)
  const set = settingsOf(control)
  if (JSON.stringify(await read($, settings)) !== JSON.stringify(set)) await update($, settings, () => set)
  const t = STR[set.language]
  if (commandsLang !== set.language) await registerCommands($, set.language) // мову змінили ззовні
  if (bus?.models && JSON.stringify(await read($, models)) !== JSON.stringify(bus.models)) {
    const list = bus.models
    await update($, models, () => list)
  }
  if (bus?.device && (await read($, device)) !== bus.device) {
    const dev = bus.device
    await update($, device, () => dev)
  }
  // Нема поля tts у шині живого слухача — це слухач старої версії (null); у вже мертвій шині
  // відсутність поля нічого не каже — лишаємо, що знали.
  const busTts = bus === null ? undefined : (bus.tts ?? (isAlive ? null : undefined))
  if (busTts !== undefined && (await read($, tts)) !== busTts) {
    const st = busTts
    const wasInstalling = (await read($, tts)) === 'installing'
    await update($, tts, () => st)
    // Щойно встановили — одразу вмикаємо (один раз); далі перемикач у людини.
    if (wasInstalling && st === 'ready') await setSetting($, { speak: true })
  }
  if (bus?.voices && JSON.stringify(await read($, voices)) !== JSON.stringify(bus.voices)) {
    const list = bus.voices
    await update($, voices, () => list)
  }
  const open = await read($, hint)
  if (open && now - open.at >= HINT_MS) await update($, hint, () => null)
  // Словник могли правити й у зовнішньому редакторі; той самий текст атом не чіпає —
  // інакше перерисовка стирала б недозбережене в полі.
  if (await read($, settingsOpen)) await loadGlossary($, t)
  const gen = await read($, glossaryGen)
  if (gen?.state === 'running' && now - gen.at > GEN_TIMEOUT_MS) {
    await update($, glossaryGen, () => ({ ...gen, state: 'error' as const, msg: t.genTimeout }))
  }

  // Мікрофон вимкнено — слухача не піднімаємо зовсім (живий сам вийде за хвилину).
  let noPython = false
  if (!isAlive && !isMuted && !daemon && now - lastSpawnAt > SPAWN_GAP_MS) {
    if (await $.fs.exists(p.python)) {
      lastSpawnAt = now
      void runDaemon($, p).catch(() => {})
    } else {
      noPython = true
    }
  }
  // «Запускається» — і поки живий дочірній процес, і поки відв'язаний слухач ще не написав шину.
  const isStarting = !noPython && (daemon !== undefined || now - lastSpawnAt <= SPAWN_GAP_MS)
  const up = isAlive ? 'up' : isMuted ? 'muted' : isStarting ? 'starting' : 'down'
  if ((await read($, listener)) !== up) await update($, listener, () => up)
  if (noPython) {
    await update($, status, () => ({ state: 'error' as const, msg: t.noPython(p.python) }))
    return
  }

  const o = await readOwner($, p)
  let who = ownerOf(o, mySession, now)
  if (who === 'none' && o === null) {
    // Жодна сесія ще не брала мікрофон — перша, хто його бачить, і бере.
    await claim($, 'auto', 'first')
    who = 'me'
  } else if (who === 'me' && o?.handoff && o.handoff.id !== lastHandoff) {
    await takeHandoff($, t, now)
  } else if (who === 'me' && now - lastOwnerBeat > OWNER_BEAT_MS) {
    await ownerBeat($, now)
  }
  if ((await read($, owner)) !== who) await update($, owner, () => who)
  const nowOwner = who === 'me' ? mySession : who === 'other' ? (o?.session ?? null) : null
  if (seenOwner !== undefined && nowOwner !== seenOwner) await announceOwner($, t, nowOwner, o?.why ?? null)
  seenOwner = nowOwner
  const title = who === 'other' && o?.session ? await titleOf($, o.session) : null
  if ((await read($, ownerTitle)) !== title) await update($, ownerTitle, () => title)
  const isLocked = isLockedOf(o, now)
  if ((await read($, locked)) !== isLocked) await update($, locked, () => isLocked)

  const next: VoiceStatus = !isAlive && isMuted
    ? { state: 'muted', msg: null }
    : !bus
    ? { state: 'off', msg: daemon ? t.starting : null }
    : !isAlive
      ? { state: 'off', msg: t.notResponding }
      : { state: (STATES.has(bus.state) ? bus.state : 'error') as VoiceState, msg: bus.msg }
  const cur = await read($, status)
  if (cur.state !== next.state || cur.msg !== next.msg) await update($, status, () => next)
  // Рядок стану застосунку оновлюємо і при зміні мови, а не лише стану.
  const line = `${ICON[next.state]} ${t.statusLine(shortOf(t, next.state))}${who === 'other' ? t.otherSessionSuffix(title ?? t.otherChat) : ''}${isLocked ? t.lockedSuffix : ''}`
  if (line !== statusKey) {
    statusKey = line
    $.ui.status(line)
  }


  if (!bus) return
  if (lastSeq < 0 || bus.seq < lastSeq) lastSeq = bus.seq // перше читання або новий файл
  for (const ev of bus.events) {
    if (ev.seq <= lastSeq) continue
    if (ev.seq === skipSeq || ev.seq === o?.handoff?.seq) continue // передана зміною чату — вже в черзі
    if (ev.kind === 'command' && who === 'me' && typeof ev.text === 'string' && ev.text.trim()) {
      queue.push({ text: ev.text.trim(), seq: ev.seq, isHandoff: false })
    }
    // Скасовано саме лише словом скасування — це відповідь «ні» на картку, якщо вона висить.
    // Скасована диктовка (текст є) картки не чіпає: у чат вона не йде, а в історії є ✗.
    if (ev.kind === 'cancelled' && who === 'me' && typeof ev.text === 'string' && !ev.text.trim()) {
      queue.push({ text: '', seq: ev.seq, isHandoff: false, isCancel: true })
    }
  }
  lastSeq = bus.seq // одразу: тік нижче ще чекає, а подія вже в черзі
  if (typedAnswer) {
    const answer = typedAnswer
    typedAnswer = null
    await (answer === 'yes' ? approve($) : reject($, 'cancelled'))
  }
  if (queue.length && !isDraining) void drain($).catch(() => {})
  await expirePending($, now)
  if (bus.seq !== shownSeq) {
    shownSeq = bus.seq
    const entries = toEntries(bus.events)
    await update($, log, () => entries)
  }
}

async function note($: EngineInterface, text: string): Promise<void> {
  await update($, decisions, list => [...list, text].slice(-6))
}

function heardOf(t: Strings, text: string, raw: string | null): string {
  return raw && raw.trim() !== text.trim() ? `\n${t.heardSuffix(raw.trim())}` : ''
}

/** 🎙 — щоб і людина, і модель бачили: це розпізнана мова, у ній бувають помилки.
 * Агент працює — у чергу посеред ходу (див. `midTurn`). */
function submitVoice($: EngineInterface, t: Strings, text: string, raw: string | null): void {
  if (mainTurn !== null) {
    midTurn.push({ text, raw })
    return
  }
  // Не чекаємо: submit резолвиться лише зі стартом ходу, а тік має йти далі.
  void $.prompt.submit({ text: `${VOICE_MARK} ${text}${heardOf(t, text, raw)}`, asUser: true }).catch(() => {})
}

/** Команди з черги посеред ходу — одним блоком у контекст результату інструмента.
 * Гвард дій — ДО того, як агент їх прочитає: тепер у ході є голосова команда. */
async function deliverMidTurn<R extends { context?: readonly string[] }>($: EngineInterface, r: R): Promise<R> {
  const t = await strings($)
  await update($, guarded, () => true)
  const sent = midTurn.splice(0)
  if (!sent.length) return r // паралельний виклик уже забрав
  const block = sent
    .map(c => `${VOICE_MARK} ${t.midTurnCommand(c.text)}${heardOf(t, c.text, c.raw)}`)
    .join('\n\n')
  try {
    for (const c of sent) await note($, t.noteMidTurn(c.text))
    $.ui.toast(t.toastMidTurn)
  } catch {
    // примітка й тост — не причина загубити вже забрану з черги команду
  }
  return { ...r, context: [...(r.context ?? []), block] }
}

/** Модель чистить текст і ставить мітку; без моделі — сирий текст і локальна оцінка. */
async function filterCommand($: EngineInterface, raw: string, set: VoiceSettings) {
  try {
    const r = await $.model.complete({
      model: set.filterModel,
      system: filterSystem(set.language, set.filterNotes, set.filterSystem, set.hotwords),
      prompt: filterPrompt(raw),
      maxTokens: 400,
      effort: 'low',
      timeoutMs: set.filterTimeoutMs,
    })
    return parseFilterReply(raw, r.isAnswered ? r.text : null)
  } catch {
    return parseFilterReply(raw, null)
  }
}

/** `at` — картка, яку людина бачила, натискаючи: якщо її вже підмінила нова, нічого не робимо. */
async function approve($: EngineInterface, at?: number): Promise<void> {
  const p = await read($, pending)
  if (!p || (at !== undefined && p.at !== at)) return
  const t = await strings($)
  // Кнопкою — лише картку, яку встигли роздивитись: свіжа могла щойно підмінити стару
  // під курсором (нова дія з того самого голосового ходу).
  if (at !== undefined && (await $.clock.now()) - p.at < CARD_SETTLE_MS) {
    $.ui.toast(t.toastCardFresh)
    return
  }
  await update($, pending, () => null)
  if (p.kind === 'command') {
    await note($, t.noteAllowed(p.text))
    // Режим діє на те, що йде зараз: у clean «розпізнано» не додаємо і після картки.
    const mode = (await read($, settings)).filterMode
    submitVoice($, t, p.text, mode === 'clean' ? null : p.raw)
    return
  }
  if (p.key) approvals.set(p.key, await $.clock.now())
  await note($, t.noteAllowedAction(p.text))
  submitVoice($, t, t.confirmedAction(p.text), null)
}

async function reject($: EngineInterface, why: 'cancelled' | 'late', at?: number): Promise<void> {
  const p = await read($, pending)
  if (!p || (at !== undefined && p.at !== at)) return
  await update($, pending, () => null)
  const t = await strings($)
  await note($, t.noteRejected(why === 'late' ? t.rejectLate : t.rejectCancelled, p.text))
  if (p.kind === 'action') {
    submitVoice($, t, t.cancelledAction(p.text), null)
  }
}

async function expirePending($: EngineInterface, now: number): Promise<void> {
  const p = await read($, pending)
  if (!p) return
  const limit = p.kind === 'command' ? PENDING_COMMAND_MS : PENDING_ACTION_MS
  if (now - p.at > limit) await reject($, 'late')
}

async function handleCommand($: EngineInterface, cmd: Queued): Promise<void> {
  if (cmd.isCancel) {
    if ((await read($, owner)) === 'me' && (await read($, pending))) await reject($, 'cancelled')
    return // без картки — лише запис «✗ скасовано» в історії
  }
  const raw = cmd.text
  const set = await read($, settings)
  const t = STR[set.language]
  if (!cmd.isHandoff && (await read($, owner)) !== 'me') {
    // Сказана, поки голос переходив в інший чат: тут їй уже не місце, а туди вона не дійде.
    await note($, t.noteNotOwner(raw))
    $.ui.toast(t.noteNotOwner(raw))
    return
  }
  if (await read($, pending)) {
    if (isNo(raw)) return reject($, 'cancelled') // «ні» голосом безпечне завжди
    if (isYes(raw)) {
      if (!(await read($, safeMode))) return approve($)
      // «Так» голосом у безпечному режимі не рахується — і агенту не йде.
      await note($, t.noteVoiceNoConfirm)
      $.ui.toast(t.toastSafe)
      return
    }
  }
  // Зміна чату — лише фразою на початку команди; передана команда — вже без неї.
  const rest = cmd.isHandoff ? null : chatPhraseRest(raw, set.chat || DEFAULT_WORDS[set.language].chat)
  if (rest !== null) return switchChat($, t, rest, cmd.seq)
  // «off» — без моделі: лише локальний список; «clean» — не додаємо «(розпізнано: …)».
  const f = set.filterMode === 'off' ? parseFilterReply(raw, null) : await filterCommand($, raw, set)
  if (f.risk === 'confirm') {
    const at = await $.clock.now()
    await update($, pending, () => ({
      kind: 'command' as const,
      text: f.clean,
      raw,
      reason: f.reason ?? 'ризикова команда', // ключ у t.reasons; показується перекладом
      at,
      key: null,
    }))
    $.ui.toast(t.toastConfirm(f.clean))
    return
  }
  submitVoice($, t, f.clean, set.filterMode === 'clean' ? null : raw)
}

/** Черга, а не паралель: відповідь «так» має застати картку, яку створила попередня фраза. */
async function drain($: EngineInterface): Promise<void> {
  if (isDraining) return
  isDraining = true
  try {
    for (let cmd = queue.shift(); cmd !== undefined; cmd = queue.shift()) {
      await handleCommand($, cmd)
    }
  } finally {
    isDraining = false
  }
}

// Команди, панель, тік — один раз на завантаження модуля. Звідки б не прийшов
// перший виклик: мод, увімкнений посеред сесії, session.start не бачить
// (виміряно 2026-10-18), тож запасні входи нижче.
// Рядок стану — над полем вводу (AbovePrompt), панель відкривається лише як
// історія: за кнопкою 🕘 чи /voice-panel. Верх екрана лишається іншим модам.
async function setSetting($: EngineInterface, patch: Partial<VoiceSettings>): Promise<void> {
  await writeControl($, patch)
  await update($, settings, cur => ({ ...cur, ...patch }))
  if (patch.autoTerms !== undefined) $.ui.invalidate('tool.describe') // опис add_term: увімкнено чи ні
  if (patch.language && commandsLang !== patch.language) await registerCommands($, patch.language)
}

/** Slash-команди з описами мовою інтерфейсу; наново — коли мову змінили. */
async function registerCommands($: EngineInterface, lang: Lang): Promise<void> {
  commandsLang = lang
  const t = STR[lang]
  await $.command.register({ name: 'voice-panel', description: t.cmdPanel })
  await $.command.register({ name: 'voice-here', description: t.cmdHere })
  await $.command.register({ name: 'voice-lock', description: t.cmdLock })
  await $.command.register({ name: 'voice-mute', description: t.cmdMute })
  await $.command.register({ name: 'voice-confirm', description: t.cmdConfirm })
  await $.command.register({ name: 'voice-cancel', description: t.cmdCancel })
  await $.command.register({ name: 'voice-safe', description: t.cmdSafe })
}

/** Натиск ⓘ: відкриває підказку поля, повторний — закриває; відкрита лише одна. */
async function toggleHint($: EngineInterface, field: string): Promise<void> {
  const cur = await read($, hint)
  const at = await $.clock.now()
  await update($, hint, () => (cur?.key === field ? null : { key: field, at }))
}

/** Особистий словник → атом; файлу ще нема — шаблон із поясненням формату (на диск — лише при збереженні). */
async function loadGlossary($: EngineInterface, t: Strings): Promise<void> {
  const p = await paths($)
  const text = (await $.fs.exists(p.glossary)) ? await $.fs.read(p.glossary) : t.glossaryTemplate
  if ((await read($, glossary)) !== text) await update($, glossary, () => text)
}

async function saveGlossary($: EngineInterface, text: string): Promise<void> {
  const p = await paths($)
  const body = text.endsWith('\n') ? text : `${text}\n`
  await $.fs.write(p.glossary, body) // слухач перечитує файл сам, щойно той змінився
  await update($, glossary, () => body)
  await update($, glossaryDraft, () => null)
  const t = await strings($)
  $.ui.toast(t.glossarySaved(glossaryStats(body).rules))
}

/** «Згенерувати»: агент Opus (Explore — лише читає) досліджує проєкт; відповідь — у turn.complete. */
async function generateGlossary($: EngineInterface): Promise<void> {
  if ((await read($, glossaryGen))?.state === 'running') return
  const set = await read($, settings)
  const t = STR[set.language]
  const at = await $.clock.now()
  await update($, glossaryGen, () => ({ state: 'running' as const, msg: t.genRunning, at, agentId: null }))
  try {
    const p = await paths($)
    const heard = (await read($, log))
      .filter(x => x.kind === 'command' || x.kind === 'ignored' || x.kind === 'part')
      .map(x => x.text)
      .slice(-40)
    const messages = (await $.session.messages())
      .filter(m => m.role === 'user' && m.text.trim())
      .map(m => m.text.replace(/\s+/g, ' ').slice(0, 300))
      .slice(-30)
    const chats = ((await listAgents($))?.peers ?? []).map(c => c.title)
    const prompt = generatorPrompt({
      lang: set.language,
      root: await $.session.root(),
      glossary: (await readJson($, p.glossary)) ?? '',
      hotwords: set.hotwords,
      heard,
      messages,
      chats,
    })
    const r = await $.agent.spawn({ prompt, description: t.genAgentName, subagentType: 'Explore', model: 'opus' })
    // agentId може й не прийти (тестовий рушій його не віддає) — тоді впізнаємо за відповіддю.
    const { deny, agentId } = r as { deny?: string; agentId?: string }
    if (deny) throw new Error(deny)
    await update($, glossaryGen, g => (g ? { ...g, agentId: agentId ?? null } : g))
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await update($, glossaryGen, () => ({ state: 'error' as const, msg: t.genFailed(why), at, agentId: null }))
  }
}

/** Відповідь генератора → чернетки полів: нові правила в кінець словника, нові слова-підказки. */
async function applyGenerated($: EngineInterface, reply: string): Promise<void> {
  const set = await read($, settings)
  const t = STR[set.language]
  const gen = await read($, glossaryGen)
  if (!gen) return
  const base = (await read($, glossaryDraft)) ?? (await read($, glossary)) ?? t.glossaryTemplate
  const got = parseGenerated(reply, base)
  if (!got) {
    await update($, glossaryGen, () => ({ ...gen, state: 'error' as const, msg: t.genBadReply }))
    return
  }
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  if (got.rules.length) {
    const lines = got.rules.map(r => ruleLine(r)).join('\n')
    await update($, glossaryDraft, () => `${base.replace(/\s*$/, '')}\n\n${t.genSection(day)}\n${lines}\n`)
  }
  const words = mergeHotwords((await read($, hotwordsDraft)) ?? set.hotwords, got.hotwords)
  if (words.added) await update($, hotwordsDraft, () => words.text)
  await update($, glossaryGen, () => ({ ...gen, state: 'done' as const, msg: t.genDone(got.rules.length, words.added) }))
}

/** Агент у голосовому режимі сам додає правило (інструмент add_term); вимикач — у ⚙. */
async function addTerm($: EngineInterface, heard: unknown, write: unknown): Promise<{ result: string } | { deny: string }> {
  const set = await read($, settings)
  const t = STR[set.language]
  if (!set.autoTerms) return { deny: t.termsOff }
  const rule = checkRule(heard, write)
  if (typeof rule === 'string') return { deny: rule }
  const p = await paths($)
  const cur = (await readJson($, p.glossary)) ?? t.glossaryTemplate
  const known = knownHeard(cur)
  const fresh = rule.heard.filter(v => !known.has(v))
  if (!fresh.length) return { result: t.termExists }
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const line = ruleLine({ heard: fresh, write: rule.write }, t.autoNote(day))
  const body = `${cur.replace(/\s*$/, '')}\n${line}\n`
  await $.fs.write(p.glossary, body)
  await update($, glossary, () => body)
  await note($, t.noteTermAdded(fresh.join(' | '), rule.write))
  $.ui.toast(t.noteTermAdded(fresh.join(' | '), rule.write))
  return { result: t.termAdded(fresh.join(' | '), rule.write) }
}

/** Відкрити словник у редакторі за замовчуванням (explorer віддає файл асоційованій програмі й виходить). */
async function openGlossary($: EngineInterface): Promise<void> {
  const p = await paths($)
  const t = await strings($)
  if (!(await $.fs.exists(p.glossary))) await $.fs.write(p.glossary, t.glossaryTemplate)
  const child = $.process.spawn({ argv: ['explorer.exe', p.glossary] })
  for (;;) {
    const step = await child.next()
    if (step.done) break
  }
}

async function setSettingsOpen($: EngineInterface, isOpen: boolean): Promise<void> {
  await update($, settingsOpen, () => isOpen)
  if (isOpen) await loadGlossary($, await strings($)).catch(() => {})
  if (isOpen) await $.ui.open({ id: SETTINGS_PANE, title: (await strings($)).settingsTitle, rows: SETTINGS_ROWS })
  else await $.ui.close({ id: SETTINGS_PANE })
}

async function setHistory($: EngineInterface, isOpen: boolean): Promise<void> {
  await update($, historyOpen, () => isOpen)
  if (isOpen) await $.ui.open({ id: PANE, title: (await strings($)).historyTitle, rows: PANE_ROWS })
  else await $.ui.close({ id: PANE })
}

function boot($: EngineInterface): Promise<void> {
  // Збій запуску не кешуємо: наступний виклик спробує знову (ticker ставиться останнім кроком bootOnce,
  // реєстрації команд/інструмента ідемпотентні).
  booting ??= bootOnce($).catch(err => {
    booting = undefined
    throw err
  })
  return booting
}

async function bootOnce($: EngineInterface): Promise<void> {
  mySession = await $.session.id()
  // Мову беремо з control.json одразу: тік ще не відпрацював, а описи команд — з першого разу правильні.
  const p = await paths($)
  let control: Control = {}
  try {
    control = JSON.parse((await readJson($, p.control)) ?? '{}') as Control
  } catch {
    control = {}
  }
  const set = settingsOf(control)
  await update($, settings, () => set)
  await registerCommands($, set.language)
  void $.tool
    .register({
      name: 'add_term',
      description: ADD_TERM_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          heard: { type: 'array', items: { type: 'string' }, description: 'Misrecognized forms, lowercase, as they appeared' },
          write: { type: 'string', description: 'The correct spelling' },
        },
        required: ['heard', 'write'],
      },
    })
    .catch(() => {})
  // Панель, лишена відкритою старою версією мода, — історія лише на вимогу.
  if (!(await read($, historyOpen))) void $.ui.close({ id: PANE }).catch(() => {})
  if (!(await read($, settingsOpen))) void $.ui.close({ id: SETTINGS_PANE }).catch(() => {})
  ticker = $.clock.every(TICK_MS, () => {
    if (isTicking) return
    isTicking = true
    void tick($)
      .catch(() => {})
      .finally(() => {
        isTicking = false
      })
  })
}

/** Слухач відв'язаний — зупинити його можна лише проханням через control.json;
 * він виходить зі станом «off», і тік піднімає нового (через 2 с, щоб старий
 * встиг звільнити mutex). */
async function restartDaemon($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await writeControl($, { restart: now })
  lastSpawnAt = now - SPAWN_GAP_MS + 2000
  const t = await strings($)
  await update($, status, () => ({ state: 'off' as const, msg: t.restarting }))
}

/** Блок «🔊» з відповіді власника голосу → speak.json. Не власник, озвучення вимкнене чи
 * блоку нема — нічого. */
async function speakAnswer($: EngineInterface, answer: string): Promise<void> {
  const block = findSpeakBlock(answer)
  if (block === null) return
  await boot($)
  const set = await read($, settings)
  if (!set.speak) return
  const p = await paths($)
  if (ownerOf(await readOwner($, p), mySession, await $.clock.now()) !== 'me') return
  const text = cleanForSpeech(block)
  if (text === '') return
  const lang = speakLang(text)
  await sendSpeak($, { text, lang, voice: voiceOf(set, lang) })
}

/** Людина набрала текст у чаті-власнику — що говориться, замовкає. Голосова команда (🎙) не рахується. */
async function stopSpeakIfOwner($: EngineInterface): Promise<void> {
  await boot($)
  const p = await paths($)
  if (ownerOf(await readOwner($, p), mySession, await $.clock.now()) === 'me') await stopSpeaking($)
}

/** Кнопка «Встановити озвучення»: Piper і голос слухач ставить сам, лише після цього натиску. */
async function installTts($: EngineInterface): Promise<void> {
  await writeControl($, { ttsInstall: await $.clock.now() })
}

/** Видалення озвучення: слухач прибирає Piper і голоси; перемикач гасимо одразу. */
async function removeTts($: EngineInterface): Promise<void> {
  await writeControl($, { ttsRemove: await $.clock.now(), speak: false })
  await update($, settings, cur => ({ ...cur, speak: false }))
}

/** ✖: слухач один на машину, тож просимо його через control.json (мітка часу, як restart). */
async function cancelCommand($: EngineInterface): Promise<void> {
  await writeControl($, { cancelAt: await $.clock.now() })
}

const HUMAN = new Set(['composer', 'bridge', 'sdk'])

export const register: Register = on => {
  // Людина закрила панель хрестиком — кнопка 🕘 має це знати.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, historyOpen, () => false)
    if (e.id === SETTINGS_PANE) await update($, settingsOpen, () => false)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await boot($)
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    const isHuman = HUMAN.has(e.origin.kind)
    void boot($)
      .then(() => (isHuman ? claim($, 'auto', 'typed') : undefined))
      .catch(() => {})
    // Набране людиною «так»/«ні», поки картка чекає, — це відповідь на неї,
    // а не повідомлення агенту. Текст — дозволений шлях і в безпечному режимі.
    if (isHuman && (await read($, pending))) {
      const answer = isYes(e.text) ? 'yes' : isNo(e.text) ? 'no' : null
      if (answer) {
        typedAnswer = answer
        return { drop: (await strings($)).dropAnswer }
      }
    }
    if (isHuman && !e.text.trimStart().startsWith(VOICE_MARK)) {
      isHumanNext = true
      await stopSpeakIfOwner($).catch(() => {})
    }
    return next(e)
  })

  // Гвард дій: від ходу, запущеного голосом, і до наступного повідомлення, набраного
  // людиною — разом із субагентами, фоновими задачами та їхніми сповіщеннями.
  // Після гварда — команда, сказана посеред ходу: лише виклику головного циклу, який зробила
  // модель (не субагенту і не власному $.tool.call мода — там контекст ніхто не прочитає).
  on('tool.call', async ($, e, next) => {
    void boot($).catch(() => {})
    const guard = async () => {
      if (!(await read($, guarded))) return next(e)
      const args = e as unknown as Record<string, unknown>
      const why = destructiveReason(e.tool, args)
      if (!why) return next(e)
      const key = callKey(e.tool, args)
      const okAt = approvals.get(key)
      if (okAt !== undefined && (await $.clock.now()) - okAt < APPROVAL_MS) {
        approvals.delete(key) // дозвіл одноразовий
        return next(e)
      }
      const text = describeCall(e.tool, args)
      const at = await $.clock.now()
      await update($, pending, () => ({ kind: 'action' as const, text, raw: null, reason: why, at, key }))
      const t = await strings($)
      $.ui.toast(t.toastBlocked(reasonText(t, why)))
      return { deny: t.denyBlocked(reasonText(t, why)) }
    }
    const r = await guard()
    // Виклик плагіна ($.tool.call) контексту моделі не віддає — лише виклик рушія (моделі).
    // Помилка (зокрема Esc посеред інструмента) — хід міг уже скінчитись: черга чекає
    // наступного кроку або turn.complete, а не йде в перерваний результат.
    if (r.deny !== undefined || r.isError || e.agentId !== undefined || next.origin.plugin !== 'engine') return r
    if (mainTurn === null || !midTurn.length) return r
    try {
      return await deliverMidTurn($, r)
    } catch {
      return r // черга лишилась — піде на наступному кроці чи після ходу
    }
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    // Шар безпеки: збій читання рядків не має перетворитись на пропуск виклику.
    try {
      return { deny: (await strings($)).denyGuardFailed }
    } catch {
      return { deny: STR.uk.denyGuardFailed }
    }
  })

  on('tool.call', { tool: ADD_TERM }, async ($, e) => {
    await boot($)
    const args = e as unknown as { heard?: unknown; write?: unknown }
    return addTerm($, args.heard, args.write)
  })

  // Вимкнено в ⚙ — інструмент ховається за ToolSearch, а опис каже, що кликати не треба.
  on('tool.describe', { tool: ADD_TERM }, async ($, e, next) => {
    const d = await next(e)
    if ((await read($, settings)).autoTerms) return d
    return { description: `DISABLED by the user in the voice settings — do not call. ${d.description}`, isDeferred: true }
  })

  on('turn.complete', async ($, e, next) => {
    // Кінець ходу головного циклу (і перерваного теж): чого не встигли доставити
    // посеред ходу — відправити як звичайно, по черзі. Кінець ходу субагента — не кінець.
    if (!e.agentId && e.turnId === mainTurn) {
      // Рядки — ще до зняття ходу: сказане тим часом стає в ту саму чергу, порядок не ламається.
      const t = midTurn.length ? await strings($).catch(() => STR.uk) : STR.uk
      mainTurn = null
      for (const c of midTurn.splice(0)) submitVoice($, t, c.text, c.raw)
    }
    const done = await next(e)
    const gen = await read($, glossaryGen)
    // Свій агент — за id; рушій, що id не повернув, — за формою відповіді генератора.
    const isMine = gen?.agentId ? gen.agentId === e.agentId : isGeneratorReply(e.answer)
    if (e.agentId && gen?.state === 'running' && isMine) {
      await applyGenerated($, e.reason === 'answer' ? e.answer : '').catch(() => {})
    }
    // Озвучка — лише відповідь головного циклу; відповідь генератора (навіть без id) не озвучується.
    if (!e.agentId && e.reason === 'answer' && !isMine && !isGeneratorReply(e.answer)) {
      await speakAnswer($, e.answer).catch(() => {})
    }
    return done
  })

  // Озвучення ввімкнене — інструкція про блок «🔊» ОСТАННІМ розділом (session: текст залежить від мови).
  // Збій не йде в рушій: без розділу промпт лишається таким, як його склав рушій.
  on('prompt.compose', async ($, e, next) => {
    const done = await next(e)
    try {
      await boot($)
      const set = await read($, settings)
      if (!set.speak) return done
      return { sections: [...done.sections, { id: 'voice-mod:speak', text: speakSection(set.language), scope: 'session' as const }] }
    } catch {
      return done
    }
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      mainTurn = e.turnId
      if (e.text.trimStart().startsWith(VOICE_MARK)) await update($, guarded, () => true)
      else if (isHumanNext) await update($, guarded, () => false)
      isHumanNext = false
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    await release($).catch(() => {})
    void daemon?.return(undefined)
    return next(e)
  })

  on('command.run', { command: 'voice-panel' }, async $ => {
    await boot($)
    await setHistory($, true)
    return { text: (await strings($)).resPanel }
  })

  on('command.run', { command: 'voice-here' }, async $ => {
    await boot($)
    await claim($, 'explicit', 'button')
    return { text: (await strings($)).resHere }
  })

  on('command.run', { command: 'voice-lock' }, async $ => {
    await boot($)
    const t = await strings($)
    const done = await setLocked($, !(await read($, locked)))
    return { text: done === null ? t.resLockNotOwner : done ? t.resLocked : t.resUnlocked }
  })

  on('command.run', { command: 'voice-confirm' }, async $ => {
    await boot($)
    const t = await strings($)
    if (!(await read($, pending))) return { text: t.resNothingConfirm }
    await approve($)
    return { text: t.resConfirmed }
  })

  on('command.run', { command: 'voice-cancel' }, async $ => {
    await boot($)
    const t = await strings($)
    if (!(await read($, pending))) return { text: t.resNothingCancel }
    await reject($, 'cancelled')
    return { text: t.resCancelled }
  })

  on('command.run', { command: 'voice-safe' }, async $ => {
    await boot($)
    const next = !(await read($, safeMode))
    await setSafeMode($, next)
    const t = await strings($)
    return { text: next ? t.resSafeOn : t.resSafeOff }
  })

  on('command.run', { command: 'voice-mute' }, async $ => {
    await boot($)
    const next = !(await read($, muted))
    await setMuted($, next)
    const t = await strings($)
    return { text: next ? t.resMicOff : t.resMicOn }
  })


  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e) // опитування в рядку важливіше
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, status)
    const list = await read($, log)
    const isMuted = await read($, muted)
    const who = await read($, owner)
    const isLocked = await read($, locked)
    const otherTitle = await read($, ownerTitle)
    const wait = await read($, pending)
    const isSafe = await read($, safeMode)
    const isHistory = await read($, historyOpen)
    const isSettings = await read($, settingsOpen)
    const set = await read($, settings)
    const t = STR[set.language]
    const wakeWord = firstWord(set.wake, firstWord(DEFAULT_WORDS[set.language].wake, ''))

    // У рядку — лише останнє почуте; решта журналу — панеллю за кнопкою 🕘.
    const heard = [...list].reverse().find(it => it.kind === 'command' || it.kind === 'ignored' || it.kind === 'cancelled')
    // Повідомлення слухача варте рядка, лише коли пояснює стан («запускаю…», помилка).
    // armed — ще й підказка режиму без автозавершення («Роби» — відправити).
    const msg =
      s.msg &&
      (s.state === 'off' ||
        s.state === 'loading' ||
        s.state === 'error' ||
        s.state === 'armed' ||
        s.state === 'transcribing' ||
        s.state === 'speaking' || // текст, що зараз звучить
        (s.state === 'ready' && s.msg.startsWith('⬇'))) // прогрес докачки моделі
        ? s.msg
        : null

    // Кнопка = гліф; її підпис — підказка, що виринає в рядку при наведенні
    // (hover-група `scope`): нативного тултипа в кнопки API модів не має.
    const tools: { key: string; glyph: string; hint: string; press: () => unknown; primary?: boolean }[] = [
      // ✖ — лише коли слухач уже в режимі команди (почув активатор / слухає чи розпізнає команду) або говорить.
      ...(s.state === 'armed' || s.state === 'transcribing' || s.state === 'speaking'
        ? [{
            key: 'cancel',
            glyph: '✖',
            hint: s.state === 'speaking' ? t.hintStopSpeaking : t.hintCancel,
            press: () => cancelCommand($),
            primary: true,
          }]
        : []),
      // Не власник — 🎧 «Сюди»; власник — режим: «Авто» (за чатом, де пишуть) чи «Закріплено».
      who !== 'me'
        ? {
            key: 'here',
            glyph: t.hereLabel, // словами, як і режим: що зробить кнопка — видно без наведення
            hint: isLocked ? t.hintHereLocked(otherTitle ?? t.otherChat) : t.hintHere,
            press: () => claim($, 'explicit', 'button'),
            primary: true,
          }
        : {
            key: 'lock',
            glyph: isLocked ? t.modePinned : t.modeAuto,
            hint: isLocked ? t.hintModePinned : t.hintModeAuto,
            press: async () => {
              const done = await setLocked($, !isLocked)
              if (done !== null) $.ui.toast(done ? t.toastPinned : t.toastAuto)
            },
          },
      {
        key: 'mute',
        glyph: isMuted ? '🔇' : '🎤',
        hint: isMuted ? t.hintMuteOn : t.hintMuteOff,
        press: () => setMuted($, !isMuted),
      },
      {
        key: 'settings',
        glyph: '⚙',
        hint: isSettings ? t.hintSettingsHide : t.hintSettingsShow,
        press: () => setSettingsOpen($, !isSettings),
      },
      {
        key: 'history',
        glyph: '🕘',
        hint: isHistory ? t.hintHistoryHide : t.hintHistoryShow,
        press: () => setHistory($, !isHistory),
      },
    ]
    const scope = (key: string) => `voice-hint-${key}`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Text color={DOT[s.state]}>●</Text>
          <Text weight="medium" wrap="truncate-end">
            {shortOf(t, s.state)}
          </Text>
          <Text
            key="owner"
            size="footnote"
            color={who === 'other' ? 'warning' : undefined}
            dimColor={who !== 'other'}
            wrap="truncate-end"
          >
            {who === 'me' ? t.ownerMe : who === 'other' ? t.ownerOther(otherTitle ?? t.otherChat) : t.ownerNone}
            {who === 'other' && isLocked ? t.lockedSuffix : ''}
          </Text>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            {msg && (s.state === 'armed' || s.state === 'transcribing') ? (
              // Живий текст команди, яку зараз диктують, — поки вона не пішла.
              // Не в цьому чаті — з ціллю: куди піде команда, видно ще до відправки.
              <Text key="heard" size="footnote" color={who === 'me' ? 'suggestion' : 'warning'} wrap="truncate-start">
                🎙 {who === 'me' ? '' : who === 'other' ? t.liveTo(otherTitle ?? t.otherChat) : t.liveNowhere}
                {msg}
              </Text>
            ) : msg && s.state === 'speaking' ? (
              <Text key="heard" size="footnote" color="suggestion" wrap="truncate-end">
                {t.speakingLine(msg)}
              </Text>
            ) : msg || !heard ? (
              <Text key="heard" size="footnote" dimColor wrap="truncate-end">
                {msg ?? t.sayWake(wakeWord)}
              </Text>
            ) : heard.kind === 'command' ? (
              // Команда, що пішла агенту, — помітно; просто почуте — блідо.
              <Text key="heard" size="footnote" color="success" weight="medium" wrap="truncate-end">
                ✓ {heard.text}
                {heard.ms !== null ? `  ${(heard.ms / 1000).toFixed(1)} ${t.seconds}` : ''}
              </Text>
            ) : heard.kind === 'cancelled' ? (
              <Text key="heard" size="footnote" dimColor wrap="truncate-end">
                {t.cancelledLine(heard.text)}
              </Text>
            ) : (
              <Text key="heard" size="footnote" dimColor wrap="truncate-end">
                · {heard.text}
              </Text>
            )}
          </Box>
          {tools.map(t => (
            <Box key={`hint-${t.key}`} display="none" hover={{ scope: scope(t.key), display: 'flex' }}>
              <Text size="footnote" color="suggestion" wrap="truncate-end">
                {t.hint}
              </Text>
            </Box>
          ))}
          {tools.map(t => (
            <Button
              key={t.key}
              label={t.glyph}
              plain
              variant={t.primary ? 'primary' : undefined}
              dimColor={
                !t.primary &&
                !(t.key === 'history' && isHistory) &&
                !(t.key === 'settings' && isSettings) &&
                !(t.key === 'lock' && isLocked)
              }
              hover={{ scope: scope(t.key) }}
              onPress={() => void Promise.resolve(t.press()).catch(() => {})}
            />
          ))}
        </Box>
        {wait ? (
          <Box key="pending" flexDirection="column">
            <Box flexDirection="row" alignItems="center" columnGap={1}>
              <Text weight="semibold" color="warning" wrap="truncate-end">
                ⚠ {wait.kind === 'command' ? t.confirmCommand : t.confirmAction}: {wait.text}
              </Text>
              <Button key="yes" label={t.yes} variant="primary" onPress={() => void approve($, wait.at).catch(() => {})} />
              <Button key="no" label={t.no} onPress={() => void reject($, 'cancelled', wait.at).catch(() => {})} />
            </Box>
            <Text size="footnote" dimColor>
              {t.why}: {reasonText(t, wait.reason)}.{' '}
              {isSafe ? t.safeCardHint(wakeWord) : t.voiceCardHint(wakeWord)}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, log)
    const notes = await read($, decisions)
    const t = await strings($)
    return (
      <Box flexDirection="column">
        {notes.map((n, i) => (
          <Text key={`d${i}`} size="footnote" dimColor>
            {n}
          </Text>
        ))}
        {list.length === 0 ? (
          <Text size="footnote" dimColor>
            {t.historyEmpty}
          </Text>
        ) : null}
        {[...list].reverse().map(it => (
          <Text
            key={`l${it.seq}`}
            size="footnote"
            dimColor={it.kind === 'ignored' || it.kind === 'info' || it.kind === 'part' || it.kind === 'spoke'}
            color={it.kind === 'error' ? 'error' : it.kind === 'cancelled' ? 'warning' : undefined}
          >
            {it.kind === 'command' ? '→ ' : it.kind === 'error' ? '! ' : it.kind === 'part' ? '… ' : it.kind === 'cancelled' ? '' : '· '}
            {it.kind === 'cancelled' ? t.cancelledLine(it.text) : it.text}
            {it.ms !== null ? `  (${(it.ms / 1000).toFixed(1)} ${t.seconds})` : ''}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const t = await strings($)
    if (!('Input' in els) || !('Select' in els)) {
      // Мобільний застосунок полів вводу ще не малює.
      const { Text } = els
      return <Text dimColor>{t.settingsMobile}</Text>
    }
    const { Box, Text, Button, Input, Select } = els
    const set = await read($, settings)
    const isSafe = await read($, safeMode)
    const open = await read($, hint)
    const draft = await read($, glossaryDraft)
    const wordsDraft = await read($, hotwordsDraft)
    const gen = await read($, glossaryGen)
    const dictionary = draft ?? (await read($, glossary)) ?? t.glossaryTemplate
    const dictStats = glossaryStats(dictionary)
    const installed = new Set(await read($, models))
    const dev = await read($, device)
    const ttsState = await read($, tts)
    const voiceList = new Set(await read($, voices))
    // Встановлює й видаляє слухач: старої версії (tts null) чи не працює — кнопка була б мертвою.
    const up = await read($, listener)
    const ttsWait =
      ttsState === 'ready' || ttsState === 'installing'
        ? null
        : up === 'muted'
          ? t.ttsNeedUnmute
          : up === 'starting'
            ? t.starting
            : up === 'down' || ttsState === null
              ? t.ttsNeedRestart
              : null
    const progress = (await read($, status)).msg
    const defaults = DEFAULT_WORDS[set.language]
    const stopWord = firstWord(set.stop, defaults.stop)
    const cancelWord = firstWord(set.cancel, defaults.cancel)
    const wakeWord = firstWord(set.wake, firstWord(defaults.wake, ''))
    const scope = (field: string) => `voice-settings-hint-${field}`
    // Біля назви — ⓘ: натиск відкриває підказку під полем (одна на всі, 10 с), а наведення
    // курсора показує той самий текст поруч (hover-група, як підказки кнопок у рядку).
    const row = (field: string, title: string, control: RenderChildren, hintText: string, extra?: RenderChildren) => (
      <Box key={`r-${field}`} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Text weight="medium">{title}</Text>
          {control}
          <Button
            key={`info-${field}`}
            label="ⓘ"
            plain
            dimColor={open?.key !== field}
            hover={{ scope: scope(field) }}
            onPress={() => void toggleHint($, field)}
          />
          <Box key={`h-${field}`} display="none" flexShrink={1} minWidth={0} hover={{ scope: scope(field), display: 'flex' }}>
            <Text size="footnote" color="suggestion" wrap="truncate-end">
              {hintText}
            </Text>
          </Box>
        </Box>
        {extra}
        {open?.key === field ? (
          <Box key="hint">
            <Text size="footnote" dimColor>
              {hintText}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
    // Модель, непридатна для мови, у файлі лишається, а слухач бере типову — показуємо її.
    const modelRow = (field: 'wakeModel' | 'model', slot: Slot, title: string, hintText: string) => {
      const chosen = set[field]
      const byDefault = DEFAULT_MODEL[dev][slot]
      const isBad = chosen !== '' && isUnsuitable(chosen, set.language)
      return row(
        field,
        title,
        <Select
          key={field}
          value={isBad ? '' : chosen}
          options={[
            { value: '', label: t.modelDefault(byDefault) },
            ...modelOptions(slot, set.language, dev, installed),
          ]}
          onSelect={(v: string) => void setSetting($, field === 'model' ? { model: v } : { wakeModel: v })}
        />,
        hintText,
        isBad ? (
          <Box key={`note-${field}`}>
            <Text size="footnote" color="warning">
              {t.modelUnsuitable(byDefault)}
            </Text>
          </Box>
        ) : null,
      )
    }
    const timeouts = [3000, 6000, 10000] as const
    const defaultSystem = defaultFilterSystem(set.language)
    // Заголовок групи в «Розширених»: налаштування згруповані за тим, що вони змінюють.
    const group = (k: string, title: string) => (
      <Box key={`g-${k}`} marginTop={1} marginBottom={1}>
        <Text weight="semibold" color="suggestion">
          {title}
        </Text>
      </Box>
    )
    const isAdvanced = await read($, advancedOpen)
    return (
      <Box flexDirection="column">
        {row(
          'language',
          t.setLanguage,
          <Select
            key="language"
            value={set.language}
            options={[
              { value: 'uk', label: t.languageNames.uk },
              { value: 'en', label: t.languageNames.en },
            ]}
            onSelect={(v: string) => void setSetting($, { language: langOf(v) })}
          />,
          t.setLanguageHint,
        )}
        {row(
          'wake',
          t.setWake,
          <Input
            key="wake"
            value={set.wake}
            placeholder={defaults.wake}
            submitLabel={t.save}
            onSubmit={(v: string) => void setSetting($, { wake: v.trim() })}
          />,
          t.wakeHint,
        )}
        {row(
          'autoEnd',
          t.setAutoEnd,
          <Button
            key="autoEnd"
            label={set.autoEnd ? t.on : t.off}
            onPress={() => void setSetting($, { autoEnd: !set.autoEnd })}
          />,
          set.autoEnd ? t.autoOnHint : t.autoOffHint(stopWord),
        )}
        {/* Стоп-слово слухач слухає лише без автозавершення — інакше поле нічого не змінює. */}
        {set.autoEnd
          ? null
          : row(
              'stop',
              t.setStop,
              <Input
                key="stop"
                value={set.stop}
                placeholder={defaults.stop}
                submitLabel={t.save}
                onSubmit={(v: string) => void setSetting($, { stop: v.trim() })}
              />,
              t.stopHint(stopWord),
            )}
        {/* Слово скасування діє в обох режимах — на відміну від стоп-слова, поле видно завжди. */}
        {row(
          'cancel',
          t.setCancel,
          <Input
            key="cancel"
            value={set.cancel}
            placeholder={defaults.cancel}
            submitLabel={t.save}
            onSubmit={(v: string) => void setSetting($, { cancel: v.trim() })}
          />,
          t.cancelHint(cancelWord),
        )}
        {row(
          'beep',
          t.setBeep,
          <Select
            key="beep"
            value={set.beep}
            options={[
              { value: 'off', label: t.beepOff },
              { value: 'wake', label: t.beepWake },
              { value: 'end', label: t.beepEnd },
              { value: 'both', label: t.beepBoth },
            ]}
            onSelect={(v: string) => void setSetting($, { beep: v as VoiceSettings['beep'] })}
          />,
          t.beepHint,
        )}
        {row(
          'speak',
          t.setSpeak,
          ttsState === 'ready' ? (
            <Button
              key="speak"
              label={set.speak ? t.on : t.off}
              onPress={() => void setSetting($, { speak: !set.speak }).catch(() => {})}
            />
          ) : ttsState === 'installing' ? (
            // Прогрес — те, що слухач пише в шину (`bus.msg`).
            <Text key="ttsProgress" size="footnote" color="suggestion" wrap="truncate-end">
              {progress ?? t.ttsInstalling}
            </Text>
          ) : ttsWait ? (
            <Text key="ttsWait" size="footnote" color="warning">
              {ttsWait}
            </Text>
          ) : (
            <Button
              key="ttsInstall"
              label={ttsState === 'error' ? t.ttsRetry : t.ttsInstall}
              onPress={() => void installTts($).catch(() => {})}
            />
          ),
          t.speakHint,
          ttsState === 'ready' || ttsState === 'installing' || ttsWait ? null : (
            <Box key="ttsNote">
              <Text size="footnote" dimColor>
                {t.ttsInstallNote}
              </Text>
            </Box>
          ),
        )}
        <Box key="r-restart" flexDirection="row" alignItems="center" columnGap={1} marginBottom={1}>
          <Button key="restart" label={t.restartButton} onPress={() => void restartDaemon($)} />
        </Box>
        <Button
          key="advanced"
          label={`${isAdvanced ? '▾' : '▸'} ${t.advanced}`}
          plain
          onPress={() => void update($, advancedOpen, v => !v).catch(() => {})}
        />
        {isAdvanced
          ? [
              group('recognition', t.groupRecognition),
              modelRow('wakeModel', 'wake', t.setWakeModel, t.wakeModelHint),
              modelRow('model', 'big', t.setModel, t.modelHint),
              row(
                'prompt',
                t.setPrompt,
                <Input
                  key="prompt"
                  value={set.prompt}
                  placeholder={t.promptPlaceholder}
                  submitLabel={t.save}
                  onSubmit={(v: string) => void setSetting($, { prompt: v.trim() })}
                />,
                t.promptHint,
              ),
              row(
                'hotwords',
                t.setHotwords,
                <Input
                  key="hotwords"
                  value={wordsDraft ?? set.hotwords}
                  placeholder={t.hotwordsPlaceholder}
                  submitLabel={t.save}
                  onSubmit={(v: string) => {
                    void setSetting($, { hotwords: v.trim() })
                      .then(() => update($, hotwordsDraft, () => null))
                      .catch(() => {})
                  }}
                />,
                t.hotwordsHint,
              ),
              row(
                'glossary',
                t.setGlossary,
                <Box key="glossary-buttons" flexDirection="row" columnGap={1}>
                  <Button
                    key="glossaryGenerate"
                    label={gen?.state === 'running' ? t.genRunningLabel : t.glossaryGenerate}
                    dimColor={gen?.state === 'running'}
                    onPress={() => void generateGlossary($).catch(() => {})}
                  />
                  <Button key="glossaryOpen" label={t.glossaryOpen} plain onPress={() => void openGlossary($).catch(() => {})} />
                </Box>,
                t.glossaryHint,
                <Box key="glossary-edit" flexDirection="column">
                  <Input
                    key="glossary"
                    value={dictionary}
                    rows={8}
                    submitLabel={t.save}
                    onSubmit={(v: string) => void saveGlossary($, v).catch(() => {})}
                  />
                  <Text key="glossary-stats" size="footnote" color={dictStats.bad.length ? 'warning' : undefined} dimColor={!dictStats.bad.length}>
                    {t.glossaryStats(dictStats.rules, `${dictStats.bad.slice(0, 5).join(', ')}${dictStats.bad.length > 5 ? '…' : ''}`)}
                  </Text>
                  {gen ? (
                    <Text key="glossary-gen" size="footnote" color={gen.state === 'error' ? 'error' : gen.state === 'done' ? 'success' : 'suggestion'}>
                      {gen.msg}
                    </Text>
                  ) : null}
                  {draft !== null || wordsDraft !== null ? (
                    <Box key="glossary-draft" flexDirection="row" alignItems="center" columnGap={1}>
                      <Text size="footnote" color="warning">
                        {t.draftNote}
                      </Text>
                      <Button
                        key="glossaryDiscard"
                        label={t.draftDiscard}
                        plain
                        onPress={() => {
                          void update($, glossaryDraft, () => null)
                            .then(() => update($, hotwordsDraft, () => null))
                            .catch(() => {})
                        }}
                      />
                    </Box>
                  ) : null}
                </Box>,
              ),
              row(
                'autoTerms',
                t.setAutoTerms,
                <Button
                  key="autoTerms"
                  label={set.autoTerms ? t.on : t.off}
                  onPress={() => void setSetting($, { autoTerms: !set.autoTerms }).catch(() => {})}
                />,
                t.autoTermsHint,
              ),
              group('processing', t.groupProcessing),
              row(
                'filterMode',
                t.setFilterMode,
                <Select
                  key="filterMode"
                  value={set.filterMode}
                  options={[
                    { value: 'off', label: t.filterModeOff },
                    { value: 'both', label: t.filterModeBoth },
                    { value: 'clean', label: t.filterModeClean },
                  ]}
                  onSelect={(v: string) => void setSetting($, { filterMode: v as VoiceSettings['filterMode'] })}
                />,
                t.filterModeHint,
              ),
              ...(set.filterMode !== 'off'
                ? [
                    row(
                      'filterModel',
                      t.setFilterModel,
                      <Select
                        key="filterModel"
                        value={set.filterModel}
                        options={[
                          { value: 'haiku', label: 'haiku' },
                          { value: 'sonnet', label: 'sonnet' },
                        ]}
                        onSelect={(v: string) => void setSetting($, { filterModel: v === 'sonnet' ? 'sonnet' : 'haiku' })}
                      />,
                      t.filterModelHint,
                    ),
                    row(
                      'filterTimeout',
                      t.setFilterTimeout,
                      <Select
                        key="filterTimeout"
                        value={String(set.filterTimeoutMs)}
                        options={timeouts.map(ms => ({ value: String(ms), label: `${ms / 1000} ${t.seconds}` }))}
                        onSelect={(v: string) => {
                          const ms = timeouts.find(x => String(x) === v)
                          if (ms) void setSetting($, { filterTimeoutMs: ms })
                        }}
                      />,
                      t.filterTimeoutHint,
                    ),
                    row(
                      'filterSystem',
                      t.setFilterSystem,
                      <Button
                        key="filterSystemReset"
                        label={t.filterSystemReset}
                        plain
                        dimColor={!set.filterSystem}
                        onPress={() => void setSetting($, { filterSystem: '' }).catch(() => {})}
                      />,
                      t.filterSystemHint,
                      <Box key="filterSystem-edit" flexDirection="column">
                        <Input
                          key="filterSystem"
                          value={set.filterSystem || defaultSystem}
                          rows={10}
                          submitLabel={t.save}
                          onSubmit={(v: string) => {
                            // Незмінна типова — не «своя»: інакше оновлення мода й зміна мови її б не чіпали.
                            const text = v.trim() === defaultSystem.trim() ? '' : v.trim()
                            void setSetting($, { filterSystem: text }).catch(() => {})
                          }}
                        />
                        <Text key="filterSystem-state" size="footnote" dimColor={!set.filterSystem} color={set.filterSystem ? 'warning' : undefined}>
                          {set.filterSystem ? t.filterSystemCustom : t.filterSystemDefault}
                        </Text>
                      </Box>,
                    ),
                    row(
                      'filterNotes',
                      t.setFilterNotes,
                      <Input
                        key="filterNotes"
                        value={set.filterNotes}
                        placeholder={t.filterNotesPlaceholder}
                        submitLabel={t.save}
                        onSubmit={(v: string) => void setSetting($, { filterNotes: v.trim() })}
                      />,
                      t.filterNotesHint,
                    ),
                  ]
                : []),
              ...(ttsState === 'ready' || ttsState === 'error'
                ? [group('speech', t.groupSpeech)]
                : []),
              ...(ttsState === 'ready'
                ? [
                    row(
                      'speakVoiceUk',
                      t.setVoiceUk,
                      <Select
                        key="speakVoiceUk"
                        value={voiceOf(set, 'uk')}
                        options={voiceOptions('uk', voiceList, t.unitMb)}
                        onSelect={(v: string) => void setSetting($, { speakVoiceUk: v })}
                      />,
                      t.voiceHint,
                    ),
                    row(
                      'speakVoiceEn',
                      t.setVoiceEn,
                      <Select
                        key="speakVoiceEn"
                        value={voiceOf(set, 'en')}
                        options={voiceOptions('en', voiceList, t.unitMb)}
                        onSelect={(v: string) => void setSetting($, { speakVoiceEn: v })}
                      />,
                      t.voiceHint,
                    ),
                  ]
                : []),
              // Видалити можна й після збою: недороблене встановлення інакше лишалось би на диску.
              // Видаляє слухач: поки він не працює, натиск загубився б — кнопки не показуємо.
              ...((ttsState === 'ready' || ttsState === 'error') && up === 'up'
                ? [
                    row(
                      'ttsRemove',
                      t.ttsRemoveTitle,
                      <Button key="ttsRemove" label={t.ttsRemove} onPress={() => void removeTts($).catch(() => {})} />,
                      t.ttsRemoveHint,
                    ),
                  ]
                : []),
              group('safety', t.groupSafety),
              row(
                'safe',
                t.setSafe,
                <Button key="safe" label={isSafe ? t.safeOn : t.safeOff} onPress={() => void setSafeMode($, !isSafe).catch(() => {})} />,
                isSafe ? t.safeOnHint : t.safeOffHint,
              ),
              row(
                'chat',
                t.setChat,
                <Input
                  key="chat"
                  value={set.chat}
                  placeholder={defaults.chat}
                  submitLabel={t.save}
                  onSubmit={(v: string) => void setSetting($, { chat: v.trim() })}
                />,
                t.chatHint(wakeWord, firstWord(set.chat, defaults.chat)),
              ),
            ]
          : null}
      </Box>
    )
  })
}
