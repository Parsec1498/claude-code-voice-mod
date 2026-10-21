import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_WORDS, STR, langOf } from './i18n'
import { settingsOf } from './register'

const HOME = 'C:\\Users\\T\\.claude\\voice-mod'
const BUS = `${HOME}\\bus.json`
const OWNER = `${HOME}\\owner.json`
const CONTROL = `${HOME}\\control.json`
const T0 = 1_000_000

type Ev = { seq: number; kind: string; text: string; ms?: number }

function bus(at: number, seq: number, events: Ev[], state = 'ready'): string {
  return JSON.stringify({ at, state, msg: null, seq, events })
}

// Підставний світ: файли в пам'яті, годинник, що йде лише за тестом, і
// слухач, який лише записує, що його запустили.
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Підставна модель фільтра: відповідь за текстом команди; без запису — чистить нічого.
type Replies = Record<string, { clean: string; risk: 'safe' | 'confirm'; reason?: string }>

function world(on: On, session: string, files: Record<string, string>, replies: Replies = {}) {
  mock.env(on, { USERPROFILE: 'C:\\Users\\T' })
  const clock = mock.clock(on, { now: T0 })
  const fs = new Map(Object.entries(files))
  const submitted: string[] = []
  const spawned: string[][] = []
  const calls: { model: unknown; timeoutMs: unknown; system: string }[] = [] // аргументи model.complete
  fs.set(`${HOME}\\venv\\Scripts\\python.exe`, '')
  on('fs.exists', async (_$, e) => ({ value: fs.has(e.path) }))
  on('fs.read', async (_$, e) => ({ value: fs.get(e.path) ?? '' }))
  on('fs.write', async (_$, e) => {
    fs.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    const dir = `${e.path ?? ''}\\`
    const names = [...fs.keys()].filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('\\'))
    return {
      value: names.map(k => ({ name: k.slice(dir.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
    }
  })
  // ListAgents — як його бачить зміна чату; рядок підставляє тест.
  const agents = { listing: '' }
  on('tool.check', async () => ({ decision: 'allow' as const }))
  // Генератор термінології: агент, якого запускає мод, і його відповідь у turn.complete.
  const spawnedAgents: { prompt: string; model?: string; subagentType?: string }[] = []
  on('agent.spawn', async (_$, e) => {
    spawnedAgents.push({ prompt: e.prompt, model: e.model, subagentType: e.subagentType })
    return { model: 'opus', agentId: 'g1' } as never
  })
  on('session.messages', async () => ({ value: [{ role: 'user', text: 'онови бота', toolUses: [] }] }) as never)
  on('session.root', async () => ({ value: 'D:\\Dev\\app' }))
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__voice-mod__${e.name}` } }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('session.id', async () => ({ value: session }))
  const commands: { name: string; description: string }[] = [] // усі виклики command.register
  on('command.register', async (_$, e) => {
    commands.push({ name: e.name, description: String(e.description) })
    return { value: { command: e.name } }
  })
  const panes: string[] = [] // журнал відкриттів/закриттів панелі
  on('ui.open', async (_$, e) => {
    panes.push(`open:${e.id}`)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', async (_$, e) => {
    panes.push(`close:${e.id}`)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('model.complete', async (_$, e) => {
    calls.push({ model: e.model, timeoutMs: e.timeoutMs, system: String(e.system) })
    const raw = String(e.prompt).replace(/<\/?command>/g, '')
    const r = replies[raw] ?? { clean: raw, risk: 'safe' as const }
    return { value: { isAnswered: true as const, text: JSON.stringify({ reason: null, ...r }), usage: USAGE } }
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  const ran: string[] = []
  on('tool.call', async (_$, e) => {
    if (e.tool === 'ListAgents') return { result: { listing: agents.listing } } as never
    const command = (e as unknown as { command?: string }).command
    // «boom» — інструмент перервано (Esc): помилка замість результату.
    if (command === 'boom') return { isError: true, result: 'Interrupted by user', text: 'Interrupted by user' } as never
    ran.push(String(command))
    return { result: 'ok' }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('process.spawn', async function* (_$, e, next) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: '{"t":"log","msg":"старт"}' }
    await new Promise<void>(r => next.signal.addEventListener('abort', () => r()))
    return { value: { code: 0, signal: null } }
  })
  return { clock, fs, submitted, spawned, calls, ran, panes, commands, agents, spawnedAgents, toasts }
}

const START = { cwd: 'D:\\Dev', surface: 'desktop', isInteractive: true } as const

// timeoutMs: відправлений $.prompt.submit тестовий набір тримає ~5 с (хід, якого
// підставний світ не дає, відпускається за бюджетом), а дефолтна межа — рівно 5 с.
test('перша сесія бере мікрофон і отримує лише НОВІ команди', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, [{ seq: 1, kind: 'command', text: 'стара команда' }]) })
  await $.session.start(START)
  await w.clock.advance(500)

  expect(JSON.parse(w.fs.get(OWNER) ?? '{}').session).toBe('A')
  expect(w.submitted).toEqual([]) // seq 1 був до старту — не повторюємо
  expect(w.spawned).toEqual([]) // слухач живий — другого не піднімаємо

  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'запусти Login на всіх', ms: 4100 }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual(['🎙 запусти Login на всіх'])

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /Голос тут/ })).toBeDefined()
  expect(await ui.find({ text: /запусти Login на всіх/ })).toBeDefined()
  await ui.unmount()
})

test('чужа сесія-власник: команд не беремо, доки не натиснули «Слухати тут»', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'B', {
    [BUS]: bus(T0, 5, []),
    [OWNER]: JSON.stringify({ session: 'A', at: T0 }),
  })
  await $.session.start(START)
  await w.clock.advance(500)

  w.fs.set(BUS, bus(T0 + 500, 6, [{ seq: 6, kind: 'command', text: 'не мені' }]))
  w.fs.set(OWNER, JSON.stringify({ session: 'A', at: T0 + 500 }))
  await w.clock.advance(500)
  expect(w.submitted).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /Голос → «інший чат»/ })).toBeDefined() // назви A ще не знаємо
    expect(await ui.find({ text: /🎧 Сюди/ })).toBeDefined() // підпис кнопки — словами
    expect(await ui.find({ text: /Сюди: голос слухатиме цей чат/ })).toBeDefined() // і підказка
    await ui.unmount()
  }

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'here' })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(OWNER) ?? '{}').session).toBe('B')

  w.fs.set(BUS, bus(T0 + 1000, 7, [{ seq: 7, kind: 'command', text: 'тепер мені' }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual(['🎙 тепер мені'])
})

test('замочок: власник закріплює себе, пульс закріплення не стирає', async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)

  let ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /🔓 Авто/ })).toBeDefined() // режим — словами, не лише гліфом
  expect(await ui.find({ text: /Авто: голос іде за чатом, де ви пишете/ })).toBeDefined()
  await ui.press({ key: 'lock' })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(OWNER) ?? '{}')).toMatchObject({ session: 'A', locked: true })

  w.fs.set(BUS, bus(T0 + 3000, 1, []))
  await w.clock.advance(2500) // пульс власника переписав owner.json
  expect(JSON.parse(w.fs.get(OWNER) ?? '{}')).toMatchObject({ session: 'A', at: T0 + 3000, locked: true })

  ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /🔒 Закріплено/ })).toBeDefined()
  expect(await ui.find({ text: /Закріплено: голос тут/ })).toBeDefined()
  await ui.press({ key: 'lock' })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(OWNER) ?? '{}').locked).toBe(false)
})

test('замочок: відправка в іншому чаті голос не забирає, «Слухати тут» — забирає', async ($, on) => {
  const w = world(on, 'B', {
    [BUS]: bus(T0, 5, []),
    [OWNER]: JSON.stringify({ session: 'A', at: T0, locked: true }),
  })
  await $.session.start(START)
  await w.clock.advance(500)

  await $.prompt.submit({ text: 'привіт', origin: { kind: 'composer' }, wait: false } as never)
  await w.clock.advance(500)
  expect(JSON.parse(w.fs.get(OWNER) ?? '{}').session).toBe('A')
  const res = (await $.command.run({ command: 'voice-lock' } as never)) as { text?: string }
  expect(res.text).toBe(STR.uk.resLockNotOwner) // замкнути може лише власник

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /Голос → «інший чат» 🔒/ })).toBeDefined()
  expect(await ui.find({ text: /зніметься/ })).toBeDefined() // підказка 🎧
  await ui.press({ key: 'here' })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(OWNER) ?? '{}')).toMatchObject({ session: 'B', locked: false })
})

test('замочок зникає з власником: мертвий закріплений власник не тримає голос', async ($, on) => {
  const w = world(on, 'B', {
    [BUS]: bus(T0, 5, []),
    [OWNER]: JSON.stringify({ session: 'A', at: T0 - 60_000, locked: true }),
  })
  await $.session.start(START)
  await w.clock.advance(500)
  await $.prompt.submit({ text: 'привіт', origin: { kind: 'composer' }, wait: false } as never)
  await w.clock.advance(500)
  expect(JSON.parse(w.fs.get(OWNER) ?? '{}')).toMatchObject({ session: 'B', locked: false })
})

// Два чати: A («Тест», ref aaaaaa) і B («Запуск бота», ref b48a00); кожен бачить себе першим рядком.
const LIST_A = 'This session is Тест [aaaaaa] — the name other sessions use.\n\nPeer sessions (1):\n  Запуск бота [b48a00]  ·  interactive  ·  idle'
const ALIVE_B = `${HOME}\\alive-B.json`

test('зміна чату: власник передає голос і команду іншому чату, сам нічого не відправляє', async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [ALIVE_B]: JSON.stringify({ at: T0, ref: 'b48a00' }) })
  w.agents.listing = LIST_A
  await $.session.start(START)
  await w.clock.advance(500)
  expect(JSON.parse(w.fs.get(`${HOME}\\alive-A.json`) ?? '{}').ref).toBe(null) // ref ще не знали на першому пульсі

  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'Зміна чату, запуск бота. Перезапусти сервер.' }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual([])
  expect(JSON.parse(w.fs.get(OWNER) ?? '{}')).toMatchObject({
    session: 'B',
    handoff: { seq: 2, text: 'Перезапусти сервер.' },
  })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /Голос → «/ })).toBeDefined()
  await ui.unmount()

  w.fs.set(ALIVE_B, JSON.stringify({ at: T0 + 1000, ref: 'b48a00' }))
  await w.clock.advance(5000)
  expect(JSON.parse(w.fs.get(`${HOME}\\alive-A.json`) ?? '{}').ref).toBe('aaaaaa') // свій ref — у пульсі
})

test('зміна чату: новий власник забирає передану команду рівно один раз', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'B', { [BUS]: bus(T0, 1, []), [OWNER]: JSON.stringify({ session: 'A', at: T0 }) })
  await $.session.start(START)
  await w.clock.advance(500)

  // Подію з фразою зміни чату B бачить у шині вже власником — і не обробляє її сам.
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'Зміна чату, запуск бота. Перезапусти сервер.' }]))
  w.fs.set(OWNER, JSON.stringify({ session: 'B', at: T0 + 500, locked: true, handoff: { id: 'A:1', seq: 2, text: 'Перезапусти сервер.' } }))
  await w.clock.advance(500)
  await w.clock.advance(500)
  expect(w.submitted).toEqual(['🎙 Перезапусти сервер.'])
  const o = JSON.parse(w.fs.get(OWNER) ?? '{}')
  expect(o).toMatchObject({ session: 'B', locked: true }) // закріплення переходить разом із голосом
  expect(o.handoff).toBeUndefined()
})

test('зміна чату: посеред команди — звичайний текст; невідомий чат — нікуди', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [ALIVE_B]: JSON.stringify({ at: T0, ref: 'b48a00' }) })
  w.agents.listing = LIST_A
  await $.session.start(START)
  await w.clock.advance(500)

  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'перезапусти сервер, зміна чату запуск бота' }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual(['🎙 перезапусти сервер, зміна чату запуск бота'])

  w.fs.set(BUS, bus(T0 + 1000, 3, [{ seq: 3, kind: 'command', text: 'зміна чату погода, глянь логи' }]))
  await w.clock.advance(500)
  expect(w.submitted).toHaveLength(1)
  expect(JSON.parse(w.fs.get(OWNER) ?? '{}').session).toBe('A')

  // Чат є в ListAgents, але мод у ньому мовчить (нема свіжого alive) — теж нікуди.
  w.fs.set(ALIVE_B, JSON.stringify({ at: T0 - 60_000, ref: 'b48a00' }))
  w.fs.set(BUS, bus(T0 + 1500, 4, [{ seq: 4, kind: 'command', text: 'зміна чату запуск бота, глянь логи' }]))
  await w.clock.advance(500)
  expect(w.submitted).toHaveLength(1)
  expect(JSON.parse(w.fs.get(OWNER) ?? '{}').session).toBe('A')
})

test('власник: назва чату в рядку й у живому тексті — видно, куди піде команда', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'B', {
    [BUS]: bus(T0, 5, []),
    [OWNER]: JSON.stringify({ session: 'A', at: T0 }),
    [`${HOME}\\alive-A.json`]: JSON.stringify({ at: T0, ref: 'aaaaaa', title: 'Тест' }),
  })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, JSON.stringify({ at: T0 + 500, state: 'armed', msg: 'перезапусти сервер', seq: 5, events: [] }))
  w.fs.set(OWNER, JSON.stringify({ session: 'A', at: T0 + 500 }))
  await w.clock.advance(500)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /Голос → «Тест»/ })).toBeDefined()
  expect(await ui.find({ text: /🎙 → «Тест»: перезапусти сервер/ })).toBeDefined()
  await ui.unmount()
})

test('перемикання: сповіщення з причиною — і там, куди пішов голос, і там, звідки', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', {
    [BUS]: bus(T0, 1, []),
    [`${HOME}\\alive-B.json`]: JSON.stringify({ at: T0, ref: 'b48a00', title: 'Запуск бота' }),
  })
  await $.session.start(START)
  await w.clock.advance(500) // перша сесія взяла голос — це не перемикання, мовчимо
  expect(w.toasts).toEqual([])

  // Людина написала в чаті B (Авто) — голос пішов туди.
  w.fs.set(OWNER, JSON.stringify({ session: 'B', at: T0 + 500, locked: false, why: 'typed' }))
  await w.clock.advance(500)
  expect(w.toasts.at(-1)).toBe('Голос → «Запуск бота» — ви написали там')
  const history = await $.ui.mount(PANE)
  expect(await history.find({ text: /Голос → «Запуск бота» — ви написали там/ })).toBeDefined()
  await history.unmount()

  // Повернули кнопкою «Сюди».
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'here' })
  await band.unmount()
  await w.clock.advance(500)
  expect(w.toasts.at(-1)).toBe('Голос тепер тут — перемкнуто кнопкою')

  // Режим: «Закріплено» — тост про сам режим.
  const again = await $.ui.mount(BAND)
  await again.press({ key: 'lock' })
  await again.unmount()
  expect(w.toasts.at(-1)).toBe('Голос закріплено за цим чатом')
  expect(JSON.parse(w.fs.get(OWNER) ?? '{}')).toMatchObject({ session: 'A', locked: true, why: 'button' })

  // Чат, що слухав, закрито — голос ні в якому чаті.
  w.fs.set(OWNER, JSON.stringify({ session: 'B', at: T0 - 60_000, locked: false, why: 'typed' }))
  await w.clock.advance(500)
  expect(w.toasts.at(-1)).toMatch(/^Голос ні в якому чаті/)
})

test('мертвий слухач: сесія піднімає новий', async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0 - 60_000, 3, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  expect(w.spawned[0]?.slice(1)).toEqual([
    '-u',
    expect.stringMatching(/listener[\\/]listener\.py$/),
    '--home',
    HOME,
    '--detach', // слухач переживає сесію й hot-reload
  ])
  await $.session.end({ reason: 'other', sessionId: 's' } as never)
})

// Рядок стану й картка підтвердження — над полем вводу; панель — лише історія.
const BAND = { plugin: 'voice-mod', surface: 'desktop', component: 'AbovePrompt', props: {} as never } as const
const PANE = { plugin: 'voice-mod', surface: 'desktop', component: 'Pane', props: {} as never, requestId: 'voice' } as const
const SETTINGS = { ...PANE, requestId: 'voice-settings' } as const

type SettingsUi = Mounted<'desktop', 'Pane'>
/** ⚙ із розгорнутими «Розширеними»: їх стан — атом, тож розгортаємо лише згорнуте. */
async function settingsUi(mount: (t: typeof SETTINGS) => Promise<SettingsUi>): Promise<SettingsUi> {
  const ui = await mount(SETTINGS)
  if (!(await ui.find({ key: 'filterMode' }))) await ui.press({ key: 'advanced' })
  return ui
}

test('безпечний режим (дефолт): «так» голосом не рахується, кнопка — так', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) }, {
    'видали все': { clean: 'Видали все.', risk: 'confirm', reason: 'видалення без уточнення' },
  })
  await $.session.start(START)
  await w.clock.advance(500)

  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'видали все' }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual([])
  let ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /Підтвердіть команду: Видали все/ })).toBeDefined()
  await ui.unmount()

  w.fs.set(BUS, bus(T0 + 1000, 3, [{ seq: 3, kind: 'command', text: 'так' }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual([]) // голосом — ні, і саме «так» агенту теж не пішло
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /Безпечний режим: підтвердження — кнопкою/ })).toBeDefined()
  await w.clock.advance(2000) // свіжу картку кнопкою не підтвердити
  await ui.press({ key: 'yes' })
  expect(await ui.find({ key: 'yes' })).toBeUndefined()
  await ui.unmount()
  expect(w.submitted).toEqual(['🎙 Видали все.\n(розпізнано: «видали все»)'])
})

test('безпечний режим вимкнено: «так» голосом підтверджує', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"safeMode":false}' }, {
    'видали все': { clean: 'Видали все.', risk: 'confirm', reason: 'видалення' },
  })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'видали все' }]))
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 1000, 3, [{ seq: 3, kind: 'command', text: 'так' }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual(['🎙 Видали все.\n(розпізнано: «видали все»)'])
})

test('набране в чаті «так» відповідає на картку і агенту не йде', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) }, {
    'видали все': { clean: 'Видали все.', risk: 'confirm', reason: 'видалення' },
  })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'видали все' }]))
  await w.clock.advance(500)
  const typed = (await $.prompt.submit({ text: 'так', origin: { kind: 'composer' }, wait: false } as never)) as { drop?: string }
  expect(typed.drop).toBeDefined()
  await w.clock.advance(500)
  expect(w.submitted).toEqual(['🎙 Видали все.\n(розпізнано: «видали все»)'])

  // Перемикач у вікні ⚙ пише control.json злиттям, не затираючи muted.
  w.fs.set(CONTROL, '{"muted":true}')
  await w.clock.advance(500)
  const ui = await settingsUi(x => $.ui.mount(x))
  await ui.press({ key: 'safe' })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}')).toEqual({ muted: true, safeMode: false })
})

test('«ні» скасовує; модель «safe» не рятує від локального шару', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) }, {
    'очисть базу': { clean: 'Очисть базу.', risk: 'safe' },
  })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'очисть базу' }]))
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 1000, 3, [{ seq: 3, kind: 'command', text: 'ні' }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual([])
})

test('звичайна команда йде очищеною, з дослівним текстом поруч', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) }, {
    'ну е запусти Login ну на всіх': { clean: 'Запусти Login на всіх.', risk: 'safe' },
  })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'ну е запусти Login ну на всіх' }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual(['🎙 Запусти Login на всіх.\n(розпізнано: «ну е запусти Login ну на всіх»)'])
})

test('гвард: rm у голосовому ході — лише після «так», і рівно один раз', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)

  const rm = { tool: 'Bash', command: 'rm -rf tmp', description: 'прибрати теку' } as never
  await $.turn.start({ text: '🎙 прибери тестову теку', turnId: 't1' })
  const first = (await $.tool.call(rm)) as { deny?: string }
  expect(first.deny).toMatch(/зупинено до підтвердження/)
  expect(w.ran).toEqual([])
  // Агент зупинився чекати підтвердження — хід скінчився (посеред ходу «так» пішло б контекстом).
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false })

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /Підтвердіть дію: Bash: rm -rf tmp/ })).toBeDefined()
  await w.clock.advance(2000) // свіжу картку кнопкою не підтвердити
  await ui.press({ key: 'yes' })
  await ui.unmount()
  expect(w.submitted.at(-1)).toMatch(/^🎙 Підтверджую дію: Bash: rm -rf tmp/)

  await $.turn.start({ text: w.submitted.at(-1) ?? '', turnId: 't2' })
  expect(((await $.tool.call(rm)) as { deny?: string }).deny).toBeUndefined()
  expect(w.ran).toEqual(['rm -rf tmp'])
  // Дозвіл одноразовий: той самий виклик удруге знову зупиняється.
  expect(((await $.tool.call(rm)) as { deny?: string }).deny).toMatch(/зупинено/)

  // Хід сповіщення фонової задачі — не людина: гвард лишається.
  await $.turn.start({ text: '<task-notification>done</task-notification>', turnId: 't3' })
  expect(((await $.tool.call(rm)) as { deny?: string }).deny).toMatch(/зупинено/)

  // Людина набрала повідомлення руками — її хід гвард не чіпає.
  await $.prompt.submit({ text: 'прибери тестову теку', origin: { kind: 'composer' }, wait: false } as never)
  await $.turn.start({ text: 'прибери тестову теку', turnId: 't4' })
  expect(((await $.tool.call(rm)) as { deny?: string }).deny).toBeUndefined()
})

test('картка: кнопка «Так» підтверджує лише ту картку, яку людина бачила', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  await $.turn.start({ text: '🎙 прибери теку', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf a', description: 'x' } as never)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /rm -rf a/ })).toBeDefined()
  // Поки людина тягнеться до кнопки, нова дія підміняє картку.
  await w.clock.advance(100)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf D:/Dev', description: 'x' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false })
  await ui.press({ key: 'yes' }) // натиск по старому малюнку картки
  await ui.unmount()
  expect(w.submitted.some(x => x.includes('rm -rf'))).toBe(false)
  // Свіжа картка (молодша за 1.5 с) кнопкою не підтверджується; роздивились — можна.
  await w.clock.advance(2000)
  const again = await $.ui.mount(BAND)
  await again.press({ key: 'yes' })
  await again.unmount()
  expect(w.submitted.at(-1)).toMatch(/rm -rf D:\/Dev/)
})

// Шар дії не вимикається в жодному режимі обробки команди (filterMode).
for (const filterMode of ['off', 'clean'] as const) {
  test(`гвард діє й при filterMode=${filterMode}: голосовий rm зупиняється`, { timeoutMs: 15000 }, async ($, on) => {
    const w = world(on, 'A', {
      [BUS]: bus(T0, 1, []),
      [CONTROL]: JSON.stringify({ filterMode, language: 'en' }),
    })
    await $.session.start(START)
    await w.clock.advance(500)

    w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'run the unit tests' }]))
    await w.clock.advance(500)
    const sent = w.submitted.at(-1) ?? ''
    expect(sent).toMatch(/^🎙 /)

    await $.turn.start({ text: sent, turnId: 't1' })
    const rm = { tool: 'Bash', command: 'rm -rf x', description: 'clean' } as never
    expect(((await $.tool.call(rm)) as { deny?: string }).deny).toBeDefined()
    expect(w.ran).toEqual([])
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'yes' })).toBeDefined() // картка очікує підтвердження
    await ui.unmount()
  })
}

// Команда посеред ходу: не чекає кінця роботи агента, а йде з результатом його
// наступного виклику інструмента — як повідомлення, набране в чаті під час ходу.
type Called = { deny?: string; context?: readonly string[] }
const READ = { tool: 'Read', file_path: 'D:\\Dev\\a.txt' } as never
const mid = (text: string) => `🎙 ${STR.uk.midTurnCommand(text)}`
const done = (turnId: string, agentId?: string) =>
  ({ turnId, agentId, reason: 'answer' as const, answer: '', durationMs: 1, isAborted: false })

test('посеред ходу: команда йде з результатом наступного інструмента, не після ходу', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  await $.turn.start({ text: 'зроби рефакторинг', turnId: 't1' })
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'запусти тести' }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual([]) // агент працює — у чергу, а не prompt.submit

  const r = (await $.tool.call(READ)) as Called
  expect(r.context).toEqual([mid('запусти тести')])
  expect(r.context?.[0]).toMatch(/Голосова команда людини.*«запусти тести»/)
  expect(w.toasts).toContain(STR.uk.toastMidTurn)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ text: /відправлено під час роботи агента: запусти тести/ })).toBeDefined()
  await pane.unmount()
  // Доставлено один раз: наступний виклик — без неї, і після ходу — теж.
  expect(((await $.tool.call(READ)) as Called).context).toBeUndefined()
  await $.turn.complete(done('t1'))
  await w.clock.advance(500)
  expect(w.submitted).toEqual([])
  // Ходу нема — знову одразу prompt.submit.
  w.fs.set(BUS, bus(T0 + 1500, 3, [{ seq: 3, kind: 'command', text: 'покажи лог' }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual(['🎙 покажи лог'])
})

test('посеред ходу: інструментів більше не було — команда йде після ходу, не губиться', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  await $.turn.start({ text: 'зроби рефакторинг', turnId: 't1' })
  w.fs.set(BUS, bus(T0 + 500, 3, [
    { seq: 2, kind: 'command', text: 'запусти тести' },
    { seq: 3, kind: 'command', text: 'покажи лог' },
  ]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual([])
  await $.turn.complete({ ...done('t1'), reason: 'aborted', isAborted: true }) // і перерваний хід
  await w.clock.advance(500)
  expect(w.submitted).toEqual(['🎙 запусти тести', '🎙 покажи лог'])
})

test('посеред ходу: перерваний інструмент (помилка) команду не забирає — вона йде після ходу', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  await $.turn.start({ text: 'зроби рефакторинг', turnId: 't1' })
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'запусти тести' }]))
  await w.clock.advance(500)
  const r = (await $.tool.call({ tool: 'Bash', command: 'boom', description: 'x' } as never)) as Called & { isError?: true }
  expect(r.isError).toBe(true)
  expect(r.context).toBeUndefined()
  await $.turn.complete({ ...done('t1'), reason: 'aborted', isAborted: true })
  await w.clock.advance(500)
  expect(w.submitted).toEqual(['🎙 запусти тести'])
})

test('посеред ходу: картку підтверджено, поки хід іде — «Підтверджую дію» контекстом, дозвіл одноразовий', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  const rm = { tool: 'Bash', command: 'rm -rf x', description: 'x' } as never
  await $.turn.start({ text: '🎙 прибери теку x', turnId: 't1' })
  expect(((await $.tool.call(rm)) as Called).deny).toMatch(/зупинено до підтвердження/)

  const ui = await $.ui.mount(BAND)
  await w.clock.advance(2000) // свіжу картку кнопкою не підтвердити
  await ui.press({ key: 'yes' })
  await ui.unmount()
  expect(w.submitted).toEqual([]) // хід іде — не prompt.submit

  const r = (await $.tool.call(READ)) as Called
  expect(r.context).toEqual([mid(STR.uk.confirmedAction('Bash: rm -rf x'))])
  // Агент повторює той самий виклик у тому ж ході — один раз можна, удруге — знову картка.
  expect(((await $.tool.call(rm)) as Called).deny).toBeUndefined()
  expect(w.ran).toContain('rm -rf x')
  expect(((await $.tool.call(rm)) as Called).deny).toMatch(/зупинено/)
  expect(w.ran.filter(x => x === 'rm -rf x')).toHaveLength(1)
})

test('посеред ходу: субагенту команду не підсовуємо — лише головному циклу', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  await $.turn.start({ text: 'зроби рефакторинг', turnId: 't1' })
  await $.turn.start({ text: 'знайди виклики', turnId: 's1', agentId: 'sub1' }) // хід субагента — не хід сесії
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'запусти тести' }]))
  await w.clock.advance(500)
  const sub = (await $.tool.call({ ...(READ as object), agentId: 'sub1' } as never)) as Called
  expect(sub.context).toBeUndefined()
  await $.turn.complete(done('s1', 'sub1')) // кінець ходу субагента хід сесії не закінчує
  await w.clock.advance(500)
  expect(w.submitted).toEqual([])
  const main = (await $.tool.call(READ)) as Called
  expect(main.context).toEqual([mid('запусти тести')])
})

test('посеред ходу: власний виклик мода (ListAgents зміни чату) чергу не забирає', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [ALIVE_B]: JSON.stringify({ at: T0, ref: 'b48a00' }) })
  w.agents.listing = LIST_A
  await $.session.start(START)
  await w.clock.advance(500)
  await $.turn.start({ text: 'зроби рефакторинг', turnId: 't1' })
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'запусти тести' }]))
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 1000, 3, [{ seq: 3, kind: 'command', text: 'Зміна чату, запуск бота. Перезапусти сервер.' }]))
  await w.clock.advance(500)
  expect(JSON.parse(w.fs.get(OWNER) ?? '{}')).toMatchObject({ session: 'B' }) // ListAgents мод викликав
  expect(((await $.tool.call(READ)) as Called).context).toEqual([mid('запусти тести')])
})

test('посеред ходу: дві команди — одним блоком, по черзі', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  await $.turn.start({ text: 'зроби рефакторинг', turnId: 't1' })
  w.fs.set(BUS, bus(T0 + 500, 3, [
    { seq: 2, kind: 'command', text: 'запусти тести' },
    { seq: 3, kind: 'command', text: 'покажи лог' },
  ]))
  await w.clock.advance(500)
  const r = (await $.tool.call(READ)) as Called
  expect(r.context).toEqual([
    `${mid('запусти тести')}\n\n${mid('покажи лог')}`,
  ])
})

test('посеред ручного ходу: доставлена голосова команда вмикає гвард дій', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  await $.prompt.submit({ text: 'зроби рефакторинг', origin: { kind: 'composer' }, wait: false } as never)
  await $.turn.start({ text: 'зроби рефакторинг', turnId: 't1' })
  const rm = { tool: 'Bash', command: 'rm -rf x', description: 'x' } as never
  expect(((await $.tool.call(rm)) as Called).deny).toBeUndefined() // ручний хід — без гварда

  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'прибери теку x' }]))
  await w.clock.advance(500)
  expect(((await $.tool.call(READ)) as Called).context).toHaveLength(1)
  const after = (await $.tool.call(rm)) as Called
  expect(after.deny).toMatch(/зупинено до підтвердження/)
  expect(w.ran).toEqual(['rm -rf x', 'undefined']) // другий rm не виконано
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'yes' })).toBeDefined()
  await ui.unmount()
})

for (const filterMode of ['both', 'clean'] as const) {
  test(`посеред ходу: «(розпізнано: …)» за режимом filterMode=${filterMode}`, { timeoutMs: 15000 }, async ($, on) => {
    const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: JSON.stringify({ filterMode }) }, {
      'ну запусти тести': { clean: 'Запусти тести.', risk: 'safe' },
    })
    await $.session.start(START)
    await w.clock.advance(500)
    await $.turn.start({ text: 'зроби рефакторинг', turnId: 't1' })
    w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'ну запусти тести' }]))
    await w.clock.advance(500)
    const heard = filterMode === 'clean' ? '' : `\n${STR.uk.heardSuffix('ну запусти тести')}`
    expect(((await $.tool.call(READ)) as Called).context).toEqual([`${mid('Запусти тести.')}${heard}`])
  })
}

test('рядок над вводом — останнє почуте, історія — панеллю за 🕘', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  expect(w.panes).not.toContain('open:voice') // верх екрана мод сам не займає
  w.fs.set(BUS, bus(T0 + 500, 3, [
    { seq: 2, kind: 'ignored', text: 'стара фраза' },
    { seq: 3, kind: 'command', text: 'запусти бота', ms: 1500 },
  ]))
  await w.clock.advance(500)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /Слухаю/ })).toBeDefined()
    expect(await ui.find({ text: /✓ запусти бота\s+1\.5 с/ })).toBeDefined() // команда — з позначкою
    expect(await ui.find({ text: /стара фраза/ })).toBeUndefined()
    expect(await ui.find({ text: /Вимкнути мікрофон/ })).toBeDefined() // підказка кнопки
    await ui.unmount()
  }
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'history' })
  expect(w.panes.at(-1)).toBe('open:voice')
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ text: /стара фраза/ })).toBeDefined()
  await pane.unmount()
  await band.press({ key: 'history' })
  expect(w.panes.at(-1)).toBe('close:voice')
  await band.unmount()
})

test('проміжні фрази диктовки — лише в історії, не в «останньому почутому»', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 3, [
    { seq: 2, kind: 'command', text: 'запусти бота', ms: 1500 },
    { seq: 3, kind: 'part', text: 'потім зупини його' },
  ]))
  await w.clock.advance(500)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ text: /✓ запусти бота/ })).toBeDefined() // part не затирає «почуте»
  expect(await band.find({ text: /зупини його/ })).toBeUndefined()
  await band.press({ key: 'history' })
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ text: /… потім зупини його/ })).toBeDefined()
  expect(await pane.find({ text: /запусти бота/ })).toBeDefined()
  await pane.unmount()
  await band.unmount()
})

test('«скасовано»: у чат нічого не йде, історія й рядок показують ✗', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 3, [
    { seq: 2, kind: 'part', text: 'запусти бота' },
    { seq: 3, kind: 'cancelled', text: 'запусти бота' },
  ]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual([])
  expect(w.calls).toHaveLength(0) // скасоване навіть не чистимо моделлю
  const band = await $.ui.mount(BAND)
  expect(await band.find({ text: /✗ скасовано: запусти бота/ })).toBeDefined()
  expect(await band.find({ text: /✓/ })).toBeUndefined()
  await band.press({ key: 'history' })
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ text: /✗ скасовано: запусти бота/ })).toBeDefined()
  await pane.unmount()
  await band.unmount()
})

test('«скасовано» англійською: ✗ cancelled', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"language":"en"}' })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'cancelled', text: 'start the bot' }]))
  await w.clock.advance(500)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ text: /✗ cancelled: start the bot/ })).toBeDefined()
  await band.unmount()
})

test('«скасовано» без тексту відхиляє висячу картку; без картки — лише запис в історії', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) }, {
    'видали все': { clean: 'Видали все.', risk: 'confirm', reason: 'видалення' },
  })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'видали все' }]))
  await w.clock.advance(500)
  let band = await $.ui.mount(BAND)
  expect(await band.find({ text: /Підтвердіть команду: Видали все/ })).toBeDefined()
  await band.unmount()

  w.fs.set(BUS, bus(T0 + 1000, 3, [{ seq: 3, kind: 'cancelled', text: '' }]))
  await w.clock.advance(500)
  band = await $.ui.mount(BAND)
  expect(await band.find({ text: /Підтвердіть команду/ })).toBeUndefined() // картку відхилено
  expect(await band.find({ text: /✗ скасовано/ })).toBeDefined()
  await band.unmount()
  expect(w.submitted).toEqual([])

  // Без картки — нічого не відхиляємо й нічого не відправляємо.
  w.fs.set(BUS, bus(T0 + 1500, 4, [{ seq: 4, kind: 'cancelled', text: '' }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual([])
})

test('«скасовано» з текстом картку не чіпає: скасовано диктовку, а не відповідь на картку', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) }, {
    'видали все': { clean: 'Видали все.', risk: 'confirm', reason: 'видалення' },
  })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'видали все' }]))
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 1000, 3, [{ seq: 3, kind: 'cancelled', text: 'запусти бота' }]))
  await w.clock.advance(500)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ text: /Підтвердіть команду: Видали все/ })).toBeDefined()
  await band.unmount()
})

test('⚙: слово скасування видно завжди й воно пишеться в control.json; порожнє — ""', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  let ui = await $.ui.mount(SETTINGS)
  // Діє і з автозавершенням (на відміну від стоп-слова), тож поле є одразу.
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  expect(await ui.find({ key: 'cancel' })).toBeDefined()
  expect(await ui.find({ key: 'info-cancel' })).toBeDefined()
  expect(await ui.find({ key: 'cancel' })).toMatchObject({ props: { placeholder: 'Відміна' } })
  await ui.input({ key: 'cancel', text: ' стоп, скасуй ' })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}').cancel).toBe('стоп, скасуй')
  ui = await $.ui.mount(SETTINGS)
  await ui.input({ key: 'cancel', text: '' })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}').cancel).toBe('')
})

test('settingsOf: слово скасування — рядок, обрізаний, інакше порожньо', () => {
  expect(settingsOf({ cancel: ' відміна, скасуй ' }).cancel).toBe('відміна, скасуй')
  expect(settingsOf({ cancel: 5 } as never).cancel).toBe('')
  expect(settingsOf({}).cancel).toBe('')
})

test('пульс сесії і перезапуск через control.json, без вбивства процесу', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"muted":true}' })
  await $.session.start(START)
  await w.clock.advance(500)
  expect(JSON.parse(w.fs.get(`${HOME}\\alive-A.json`) ?? '{}').at).toBeGreaterThan(0)

  const ui = await settingsUi(x => $.ui.mount(x))
  await ui.press({ key: 'restart' })
  await ui.unmount()
  const control = JSON.parse(w.fs.get(CONTROL) ?? '{}')
  expect(control.muted).toBe(true) // перезапуск не чіпає мікрофон
  expect(control.restart).toBeGreaterThan(0)
})

test('мікрофон вимкнено — слухача не піднімаємо; увімкнули — піднімаємо', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0 - 60_000, 3, [], 'off'), [CONTROL]: '{"muted":true}' })
  await $.session.start(START)
  await w.clock.advance(20_000)
  expect(w.spawned).toEqual([])
  let ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /Mic off/ })).toBeDefined()
  await ui.press({ key: 'mute' })
  await ui.unmount()
  await w.clock.advance(500)
  expect(w.spawned).toHaveLength(1)
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}').muted).toBe(false)
  await $.session.end({ reason: 'other', sessionId: 's' } as never)
})

test('рядок: просто почуте — без позначки команди', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 3, [
    { seq: 2, kind: 'command', text: 'запусти бота', ms: 1500 },
    { seq: 3, kind: 'ignored', text: 'просто розмова' },
  ]))
  await w.clock.advance(500)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /· просто розмова/ })).toBeDefined()
  expect(await ui.find({ text: /✓/ })).toBeUndefined()
  await ui.unmount()
})

test('⚙: вікно налаштувань пише control.json, рядок без ↻ і без перемикача безпечного режиму', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"muted":true,"safeMode":true}' })
  await $.session.start(START)
  await w.clock.advance(500)

  const band = await $.ui.mount(BAND)
  expect(await band.find({ key: 'restart' })).toBeUndefined()
  expect(await band.find({ key: 'safe' })).toBeUndefined()
  await band.press({ key: 'settings' })
  expect(w.panes.at(-1)).toBe('open:voice-settings')

  const ui = await settingsUi(x => $.ui.mount(x))
  await ui.select({ key: 'beep', value: 'wake' })
  await ui.press({ key: 'autoEnd' })
  await ui.input({ key: 'wake', text: 'Джарвіс, Джарвис' })
  await ui.input({ key: 'stop', text: '' }) // порожнє стоп-слово — «дефолт мови», а не «Роби»
  await ui.unmount()
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}')).toEqual({
    muted: true,
    safeMode: true,
    beep: 'wake',
    autoEnd: false,
    wake: 'Джарвіс, Джарвис',
    stop: '',
  })

  // Рядок бере слово-активатор із налаштувань.
  await w.clock.advance(500)
  expect(await band.find({ text: /Скажіть «Джарвіс, …»/ })).toBeDefined()
  await band.press({ key: 'settings' })
  expect(w.panes.at(-1)).toBe('close:voice-settings')
  await band.unmount()
})

test('рядок: живий текст команди, поки її диктують', { timeoutMs: 15000 }, async ($, on) => {
  const live = JSON.stringify({ at: T0 + 500, state: 'armed', msg: 'запусти бота і', seq: 2, events: [] })
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, live)
  await w.clock.advance(500)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /🎙 запусти бота і/ })).toBeDefined()
  await ui.unmount()
})

test('⚙: режим сигналу «Обидва»', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"beep":"wake"}' })
  await $.session.start(START)
  await w.clock.advance(500)
  const ui = await settingsUi(x => $.ui.mount(x))
  await ui.select({ key: 'beep', value: 'both' })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}').beep).toBe('both')
})

test('⚙: своя підказка і слова-підказки — у control.json', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"muted":true}' })
  await $.session.start(START)
  await w.clock.advance(500)
  const ui = await settingsUi(x => $.ui.mount(x))
  await ui.input({ key: 'prompt', text: '  Клоде, запусти білд.  ' })
  await ui.input({ key: 'hotwords', text: 'білд, CI' })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}')).toEqual({
    muted: true,
    prompt: 'Клоде, запусти білд.',
    hotwords: 'білд, CI',
  })
})

test('мова з control.json: рядок англійською, ⚙ перемикає назад і перереєстровує команди', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"language":"en"}' })
  await $.session.start(START)
  await w.clock.advance(500)
  expect(w.commands).toHaveLength(7)
  expect(w.commands.every(c => /^[ -~]+$/.test(c.description))).toBe(true) // описи англійською

  const band = await $.ui.mount(BAND)
  expect(await band.find({ text: /Listening/ })).toBeDefined()
  expect(await band.find({ text: /Say «Claude, …»/ })).toBeDefined()
  expect(await band.find({ text: /Mute the microphone/ })).toBeDefined()

  const ui = await settingsUi(x => $.ui.mount(x))
  await ui.select({ key: 'language', value: 'uk' })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}').language).toBe('uk')
  expect(w.commands).toHaveLength(14) // сім команд наново, вже українськими описами
  expect(w.commands.slice(7).some(c => /Голосові команди/.test(c.description))).toBe(true)
  await w.clock.advance(500)
  expect(w.commands).toHaveLength(14) // тік не плодить повторів
  expect(await band.find({ text: /Слухаю/ })).toBeDefined()
  expect(await band.find({ text: /Скажіть «Клоде, …»/ })).toBeDefined()
  await band.unmount()
})

test('мову змінили у control.json ззовні — команди перереєстровані на найближчому тіку', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  expect(w.commands).toHaveLength(7)
  w.fs.set(CONTROL, '{"language":"en"}')
  await w.clock.advance(500)
  expect(w.commands).toHaveLength(14)
  expect(w.commands.slice(7).every(c => /^[ -~]+$/.test(c.description))).toBe(true)
})

test('порожнє стоп-слово = дефолт мови: «Done» для en, «Роби» для uk', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"language":"en","autoEnd":false}' })
  await $.session.start(START)
  await w.clock.advance(500)
  let ui = await settingsUi(x => $.ui.mount(x))
  await ui.press({ key: 'info-autoEnd' })
  expect((await ui.find({ key: 'hint' }))?.text).toMatch(/«Done»/)
  await ui.unmount()
  w.fs.set(CONTROL, '{"autoEnd":false}')
  await w.clock.advance(500)
  ui = await settingsUi(x => $.ui.mount(x))
  expect((await ui.find({ key: 'hint' }))?.text).toMatch(/«Роби»/) // відкрита підказка підхопила нову мову
  await ui.unmount()
})

test('англійська: картка підтвердження, deny для агента і розпізнано-суфікс', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"language":"en"}' }, {
    'delete everything': { clean: 'Delete everything.', risk: 'confirm', reason: 'deletion' },
  })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'delete everything' }]))
  await w.clock.advance(500)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ text: /Confirm the command: Delete everything/ })).toBeDefined()
  await w.clock.advance(2000) // свіжу картку кнопкою не підтвердити
  await band.press({ key: 'yes' })
  await band.unmount()
  expect(w.submitted).toEqual(['🎙 Delete everything.\n(heard: «delete everything»)'])

  const rm = { tool: 'Bash', command: 'rm -rf tmp', description: 'x' } as never
  await $.turn.start({ text: '🎙 clean the tmp folder', turnId: 't1' })
  const first = (await $.tool.call(rm)) as { deny?: string }
  expect(first.deny).toMatch(/stopped until the human confirms/)
  expect(first.deny).toMatch(/file deletion/) // причина з шару дій теж англійською
})

test('i18n: обидві мови мають однакові ключі, жодного порожнього рядка; langOf', () => {
  const uk = STR.uk as unknown as Record<string, unknown>
  const en = STR.en as unknown as Record<string, unknown>
  expect(Object.keys(en).sort()).toEqual(Object.keys(uk).sort())
  for (const k of Object.keys(uk)) {
    const a = uk[k]
    const b = en[k]
    expect(typeof b).toBe(typeof a)
    if (typeof a === 'string') {
      expect(a.length).toBeGreaterThan(0)
      expect((b as string).length).toBeGreaterThan(0)
    } else if (typeof a === 'function') {
      expect(String((a as (x: string) => string)('X')).length).toBeGreaterThan(0)
      expect(String((b as (x: string) => string)('X')).length).toBeGreaterThan(0)
    } else {
      expect(Object.keys(b as object).sort()).toEqual(Object.keys(a as object).sort())
    }
  }
  expect(langOf('en')).toBe('en')
  expect(langOf('uk')).toBe('uk')
  expect(langOf(undefined)).toBe('uk')
  expect(langOf('fr')).toBe('uk')
  expect(DEFAULT_WORDS.uk).toEqual({ wake: 'Клоде, Клод, Клауд, Claude', stop: 'Роби', cancel: 'Відміна', chat: 'Зміна чату' })
  expect(DEFAULT_WORDS.en).toEqual({ wake: 'Claude', stop: 'Done', cancel: 'Cancel', chat: 'Switch chat' })
})

const DEFAULT_SETTINGS = {
  beep: 'end',
  autoEnd: true,
  wake: '',
  stop: '',
  cancel: '',
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
}

test('settingsOf: типові значення і відкидання битих', () => {
  expect(settingsOf({})).toEqual(DEFAULT_SETTINGS)
  const bad = { filterMode: 'x', filterModel: 'gpt', filterTimeoutMs: 'x', language: 'de', wakeModel: 5, model: null, filterNotes: 7, chat: 3 }
  expect(settingsOf(bad as never)).toEqual(DEFAULT_SETTINGS)
  expect(settingsOf({ filterTimeoutMs: 4000 } as never).filterTimeoutMs).toBe(6000)
  const good = settingsOf({ filterMode: 'clean', filterModel: 'sonnet', filterTimeoutMs: 10000, filterNotes: ' a ', wakeModel: ' small ', model: 'large-v3', chat: ' Перейди в ' })
  expect(good).toMatchObject({ filterMode: 'clean', filterModel: 'sonnet', filterTimeoutMs: 10000, filterNotes: 'a', wakeModel: 'small', model: 'large-v3', chat: 'Перейди в' })
})

test('режим «off»: модель не кличемо, ризик — лише з локального списку', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"filterMode":"off"}' })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'видали логи' }]))
  await w.clock.advance(500)
  expect(w.calls).toHaveLength(0)
  expect(w.submitted).toEqual([])
  const band = await $.ui.mount(BAND)
  expect(await band.find({ text: /видали логи/ })).toBeDefined()
  await band.unmount()

  w.fs.set(CONTROL, '{"filterMode":"off"}')
  w.fs.set(BUS, bus(T0 + 1000, 3, [{ seq: 3, kind: 'command', text: 'ні' }]))
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 1500, 4, [{ seq: 4, kind: 'command', text: 'запусти Login' }]))
  await w.clock.advance(500)
  expect(w.calls).toHaveLength(0)
  expect(w.submitted).toEqual(['🎙 запусти Login'])
})

test('режим «clean»: очищений текст без «(розпізнано: …)»', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"filterMode":"clean"}' }, {
    'ну запусти логін': { clean: 'Запусти Login.', risk: 'safe' },
  })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'ну запусти логін' }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual(['🎙 Запусти Login.'])
})

test('модель, тайм-аут і власні правила фільтра йдуть у model.complete', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', {
    [BUS]: bus(T0, 1, []),
    [CONTROL]: '{"filterModel":"sonnet","filterTimeoutMs":3000,"filterNotes":"MyApp латиницею"}',
  })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'запусти ДіАрбот' }]))
  await w.clock.advance(500)
  expect(w.calls).toHaveLength(1)
  expect(w.calls[0]).toMatchObject({ model: 'sonnet', timeoutMs: 3000 })
  expect(w.calls[0]?.system.endsWith('MyApp латиницею')).toBe(true)
})

test('режим «clean»: підтверджена кнопкою команда теж без «(розпізнано: …)»', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"filterMode":"clean"}' }, {
    'видали все': { clean: 'Видали все.', risk: 'confirm', reason: 'видалення без уточнення' },
  })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, bus(T0 + 500, 2, [{ seq: 2, kind: 'command', text: 'видали все' }]))
  await w.clock.advance(500)
  expect(w.submitted).toEqual([])
  const ui = await $.ui.mount(BAND)
  await w.clock.advance(2000) // свіжу картку кнопкою не підтвердити
  await ui.press({ key: 'yes' })
  await ui.unmount()
  expect(w.submitted).toEqual(['🎙 Видали все.'])
})

const hintText = async (ui: { find: (q: { key: string }) => Promise<{ text?: string } | undefined> }) =>
  (await ui.find({ key: 'hint' }))?.text

test('ⓘ: під полями нема довгих пояснень; підказка — за натиском, одна, зникає за 10 с', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  const ui = await settingsUi(x => $.ui.mount(x))
  expect(await ui.find({ text: /Enter — зберегти/ })).toBeUndefined()
  expect(await hintText(ui)).toBeUndefined()

  await ui.press({ key: 'info-beep' })
  expect(await hintText(ui)).toMatch(/активатора/)
  await ui.press({ key: 'info-wake' }) // відкрита лише одна
  expect(await hintText(ui)).not.toMatch(/активатора/)
  expect(await hintText(ui)).toMatch(/через кому/)
  await ui.press({ key: 'info-wake' }) // повторний натиск закриває
  expect(await hintText(ui)).toBeUndefined()

  await ui.press({ key: 'info-beep' })
  await w.clock.advance(9000)
  expect(await hintText(ui)).toBeDefined()
  await w.clock.advance(1000)
  expect(await hintText(ui)).toBeUndefined()
  await ui.unmount()
})

test('⚙: словник виправлень — видно з диска, правиться в полі, відкривається в редакторі', { timeoutMs: 15000 }, async ($, on) => {
  const GLOSSARY = `${HOME}\\glossary.txt`
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)

  // Файлу ще нема — у полі шаблон із поясненням формату, на диск нічого не пишемо.
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'settings' })
  await band.unmount()
  let ui = await settingsUi(x => $.ui.mount(x))
  expect(await ui.find({ text: /Особистий словник/ })).toBeDefined()
  expect(await ui.find({ text: /Правил: 0/ })).toBeDefined()
  expect(w.fs.has(GLOSSARY)).toBe(false)

  await ui.input({ key: 'glossary', text: 'логін | лоґін => Login\nбез стрілки' })
  await ui.unmount()
  expect(w.fs.get(GLOSSARY)).toBe('логін | лоґін => Login\nбез стрілки\n')
  ui = await settingsUi(x => $.ui.mount(x))
  expect(await ui.find({ text: /Правил: 1 · рядки 2 без «=>»/ })).toBeDefined()
  await ui.unmount()

  // Правка в зовнішньому редакторі з'являється в полі сама.
  w.fs.set(GLOSSARY, 'а => б\nв => г\n')
  await w.clock.advance(500)
  ui = await settingsUi(x => $.ui.mount(x))
  expect(await ui.find({ text: /Правил: 2/ })).toBeDefined()
  await ui.press({ key: 'glossaryOpen' })
  await ui.unmount()
  await w.clock.advance(100)
  expect(w.spawned.at(-1)).toEqual(['explorer.exe', GLOSSARY])
})

test('add_term: агент сам додає правило; повтор, коротке й вимкнене — ні', { timeoutMs: 15000 }, async ($, on) => {
  const GLOSSARY = `${HOME}\\glossary.txt`
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [GLOSSARY]: '# мій\nбута => бота\n' })
  await $.session.start(START)
  await w.clock.advance(500)
  const add = (heard: string[], write: string) =>
    $.tool.call({ tool: 'mcp__voice-mod__add_term', heard, write } as never) as Promise<{ result?: string; deny?: string }>

  expect((await add(['Логін', 'лоґін'], 'Login')).result).toMatch(/Додано в словник/)
  expect(w.fs.get(GLOSSARY)).toMatch(/^# мій\nбута => бота\nлогін \| лоґін => Login  # авто \d{4}-\d\d-\d\d\n$/)
  expect((await add(['логін'], 'Login')).result).toMatch(/уже виправляє/)
  expect((await add(['бо'], 'бот')).deny).toBeDefined()
  const band = await $.ui.mount(PANE)
  expect(await band.find({ text: /📖 словник: «логін \| лоґін» => Login/ })).toBeDefined()
  await band.unmount()

  w.fs.set(CONTROL, '{"autoTerms":false}')
  await w.clock.advance(500)
  expect((await add(['майап'], 'MyApp')).deny).toMatch(/вимкнено/)
  expect(w.fs.get(GLOSSARY)).not.toMatch(/MyApp/)
})

test('«Згенерувати»: агент Opus, відповідь — чернетки полів, збереження — лише Enter', { timeoutMs: 15000 }, async ($, on) => {
  const GLOSSARY = `${HOME}\\glossary.txt`
  const w = world(on, 'A', {
    [BUS]: bus(T0, 1, []),
    [GLOSSARY]: 'логін => Login\n',
    [CONTROL]: '{"hotwords":"Login"}',
  })
  await $.session.start(START)
  await w.clock.advance(500)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'settings' })
  await band.unmount()

  let ui = await settingsUi(x => $.ui.mount(x))
  await ui.press({ key: 'glossaryGenerate' })
  await ui.unmount()
  expect(w.spawnedAgents).toHaveLength(1)
  expect(w.spawnedAgents[0]?.model).toBe('opus') // subagentType підставний рушій не передає — перевіряє типізація
  expect(w.spawnedAgents[0]?.prompt).toMatch(/онови бота/)
  ui = await settingsUi(x => $.ui.mount(x))
  expect(await ui.find({ text: /Агент Opus читає проєкт/ })).toBeDefined()
  await ui.press({ key: 'glossaryGenerate' }) // поки працює — другого не запускаємо
  await ui.unmount()
  expect(w.spawnedAgents).toHaveLength(1)

  // Чужий субагент, що закінчив тим часом, генерацію не завершує.
  await $.turn.complete({ turnId: 'a0', agentId: 'other', reason: 'answer', answer: 'Готово.', durationMs: 1, isAborted: false })
  const reply = '{"hotwords": ["MyApp", "login"], "rules": [{"heard": ["логін", "май ап"], "write": "MyApp"}]}'
  await $.turn.complete({ turnId: 'a1', agentId: 'g1', reason: 'answer', answer: reply, durationMs: 1, isAborted: false })
  ui = await settingsUi(x => $.ui.mount(x))
  expect(await ui.find({ text: /правил — 1, слів-підказок — 1/ })).toBeDefined()
  expect(await ui.find({ text: /Чернетка — ще не збережено/ })).toBeDefined()
  expect(w.fs.get(GLOSSARY)).toBe('логін => Login\n') // на диску — як було
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}').hotwords).toBe('Login')

  await ui.input({ key: 'glossary', text: 'логін => Login\n\nмай ап => MyApp' })
  await ui.input({ key: 'hotwords', text: 'Login, MyApp' })
  await ui.unmount()
  await w.clock.advance(500)
  expect(w.fs.get(GLOSSARY)).toBe('логін => Login\n\nмай ап => MyApp\n')
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}').hotwords).toBe('Login, MyApp')
  ui = await settingsUi(x => $.ui.mount(x))
  expect(await ui.find({ text: /Чернетка/ })).toBeUndefined()
  await ui.unmount()
})

test('⚙: базове видно одразу, решта — у «Розширених», згрупована', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  const ui = await $.ui.mount(SETTINGS)
  for (const k of ['language', 'wake', 'autoEnd', 'beep', 'restart', 'advanced']) {
    expect(await ui.find({ key: k })).toBeDefined()
  }
  // Стоп-слово діє лише без автозавершення — тоді й з'являється, одразу під ним.
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await ui.press({ key: 'autoEnd' })
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  const order = JSON.stringify(await ui.drawn()).match(/"key":"r-(language|wake|autoEnd|stop|beep)"/g)
  expect(order).toEqual(['"key":"r-language"', '"key":"r-wake"', '"key":"r-autoEnd"', '"key":"r-stop"', '"key":"r-beep"'])
  await ui.press({ key: 'autoEnd' })
  for (const k of ['safe', 'chat', 'filterMode', 'model', 'hotwords', 'glossary', 'autoTerms']) {
    expect(await ui.find({ key: k })).toBeUndefined()
  }
  await ui.press({ key: 'advanced' })
  for (const k of ['safe', 'chat', 'filterMode', 'filterSystem', 'model', 'hotwords', 'glossary', 'autoTerms']) {
    expect(await ui.find({ key: k })).toBeDefined()
  }
  for (const g of [/Розпізнавання/, /Обробка команди/, /Безпека й чати/]) expect(await ui.find({ text: g })).toBeDefined()
  await ui.press({ key: 'advanced' }) // і згортається назад
  expect(await ui.find({ key: 'filterMode' })).toBeUndefined()
  await ui.unmount()
})

test('⚙: інструкція моделі — типова в полі, своя йде в модель, «Типова» повертає', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  let ui = await settingsUi(x => $.ui.mount(x))
  expect(await ui.find({ text: /Ти фільтр голосових команд/ })).toBeDefined()
  expect(await ui.find({ text: /Типова інструкція/ })).toBeDefined()
  await ui.input({ key: 'filterSystem', text: 'Поверни JSON {"clean": текст, "risk": "safe"}.' })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}').filterSystem).toBe('Поверни JSON {"clean": текст, "risk": "safe"}.')

  w.fs.set(BUS, bus(T0 + 1000, 2, [{ seq: 2, kind: 'command', text: 'запусти тести' }]))
  await w.clock.advance(500)
  expect(w.calls.at(-1)?.system).toBe('Поверни JSON {"clean": текст, "risk": "safe"}.')

  ui = await settingsUi(x => $.ui.mount(x))
  expect(await ui.find({ text: /Своя інструкція/ })).toBeDefined()
  await ui.press({ key: 'filterSystemReset' })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}').filterSystem).toBe('')
  // Збережена без змін типова — лишається «типовою», а не стає своєю.
  ui = await settingsUi(x => $.ui.mount(x))
  const field = await ui.find({ key: 'filterSystem' })
  await ui.input({ key: 'filterSystem', text: String((field as { props?: { value?: string } } | undefined)?.props?.value ?? '') })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}').filterSystem).toBe('')
})

test('ⓘ: у кожного поля ⚙ є кнопка, а підказка не порожня', { timeoutMs: 15000 }, async ($, on) => {
  // Без автозавершення — щоб було видно й поле стоп-слова.
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"autoEnd":false}' })
  await $.session.start(START)
  await w.clock.advance(500)
  const ui = await settingsUi(x => $.ui.mount(x))
  const fields = [
    'language', 'safe', 'beep', 'autoEnd', 'wake', 'stop', 'cancel', 'filterMode', 'filterModel',
    'filterTimeout', 'filterNotes', 'wakeModel', 'model', 'prompt', 'hotwords', 'chat', 'glossary', 'autoTerms', 'filterSystem',
  ]
  for (const f of fields) {
    await ui.press({ key: `info-${f}` })
    expect((await hintText(ui))?.length ?? 0).toBeGreaterThan(10)
  }
  await ui.unmount()
})

test('⚙: обробка команди — поля моделі, тайм-ауту й інструкцій лише коли не «off»', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"filterMode":"off"}' })
  await $.session.start(START)
  await w.clock.advance(500)
  let ui = await settingsUi(x => $.ui.mount(x))
  expect(await ui.find({ key: 'filterMode' })).toBeDefined()
  expect(await ui.find({ key: 'filterModel' })).toBeUndefined()
  expect(await ui.find({ key: 'filterTimeout' })).toBeUndefined()
  expect(await ui.find({ key: 'filterNotes' })).toBeUndefined()
  await ui.select({ key: 'filterMode', value: 'clean' })
  await ui.unmount()
  await w.clock.advance(500)
  ui = await settingsUi(x => $.ui.mount(x))
  expect(await ui.find({ key: 'filterModel' })).toBeDefined()
  await ui.select({ key: 'filterModel', value: 'sonnet' })
  await ui.select({ key: 'filterTimeout', value: '10000' })
  await ui.input({ key: 'filterNotes', text: ' MyApp латиницею ' })
  await ui.unmount()
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}')).toEqual({
    filterMode: 'clean',
    filterModel: 'sonnet',
    filterTimeoutMs: 10000,
    filterNotes: 'MyApp латиницею',
  })
  w.fs.set(CONTROL, '{}') // типове: both
  await w.clock.advance(500)
  ui = await settingsUi(x => $.ui.mount(x))
  expect(await ui.find({ key: 'filterModel' })).toBeDefined()
  await ui.unmount()
})

const busWith = (extra: Record<string, unknown>) =>
  JSON.stringify({ at: T0, state: 'ready', msg: null, seq: 1, events: [], ...extra })

type Opt = { value: string; label: string }
const optionsOf = async (ui: { find: (q: { key: string }) => Promise<{ props?: Record<string, unknown> } | undefined> }, key: string) =>
  (await ui.find({ key }))?.props?.options as Opt[] | undefined

test('⚙: вибір моделей — пишеться в control.json, відсутні на диску з ⬇, є «типова»', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: busWith({ models: ['small', 'large-v3'], device: 'cuda' }) })
  await $.session.start(START)
  await w.clock.advance(500)
  const ui = await settingsUi(x => $.ui.mount(x))
  const big = (await optionsOf(ui, 'model')) ?? []
  expect(big[0]).toMatchObject({ value: '' })
  expect(big[0]?.label).toMatch(/Типова.*large-v3/)
  expect(big.find(o => o.value === 'medium')?.label).toMatch(/⬇/)
  expect(big.find(o => o.value === 'large-v3')?.label).not.toMatch(/⬇/)
  expect(big.some(o => o.value === 'distil-large-v3' || o.value.endsWith('.en'))).toBe(false) // uk: англійські не показуємо
  const wake = (await optionsOf(ui, 'wakeModel')) ?? []
  expect(wake[0]).toMatchObject({ value: '' })
  expect(wake[0]?.label).toMatch(/Типова.*small/)
  expect(wake.find(o => o.value === 'tiny')?.label).toMatch(/⬇/)

  await ui.select({ key: 'model', value: 'medium' })
  await ui.select({ key: 'wakeModel', value: 'tiny' })
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}')).toMatchObject({ model: 'medium', wakeModel: 'tiny' })
  await ui.select({ key: 'model', value: '' }) // назад до типової
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}').model).toBe('')
  await ui.unmount()
})

test('⚙: на CPU типові моделі інші; англійська показує англійські моделі', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: busWith({ models: [], device: 'cpu' }), [CONTROL]: '{"language":"en"}' })
  await $.session.start(START)
  await w.clock.advance(500)
  const ui = await settingsUi(x => $.ui.mount(x))
  const big = (await optionsOf(ui, 'model')) ?? []
  expect(big[0]?.label).toMatch(/Default.*large-v3-turbo/)
  expect(big.some(o => o.value === 'distil-large-v3')).toBe(true)
  expect((await optionsOf(ui, 'wakeModel'))?.[0]?.label).toMatch(/Default.*base/)
  await ui.unmount()
})

test('⚙: англійська модель при мові uk — примітка про типову, вибір у control.json не чіпаємо', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', {
    [BUS]: busWith({ models: ['small', 'large-v3'], device: 'cuda' }),
    [CONTROL]: '{"model":"distil-large-v3","wakeModel":"base"}',
  })
  await $.session.start(START)
  await w.clock.advance(500)
  const ui = await settingsUi(x => $.ui.mount(x))
  const note = await ui.find({ key: 'note-model' })
  expect(note?.text).toMatch(/українськ/)
  expect(note?.text).toMatch(/large-v3/)
  expect(await ui.find({ key: 'note-wakeModel' })).toBeUndefined() // base — багатомовна
  expect((await ui.find({ key: 'model' }))?.props?.value).toBe('') // у списку — типова
  await ui.unmount()
  expect(JSON.parse(w.fs.get(CONTROL) ?? '{}')).toEqual({ model: 'distil-large-v3', wakeModel: 'base' })

  w.fs.set(CONTROL, '{"model":"distil-large-v3","language":"en"}')
  await w.clock.advance(500)
  const en = await settingsUi(x => $.ui.mount(x))
  expect(await en.find({ key: 'note-model' })).toBeUndefined()
  expect((await en.find({ key: 'model' }))?.props?.value).toBe('distil-large-v3')
  await en.unmount()
})

test('рядок: прогрес завантаження моделі (⬇) видно, поки слухач у стані ready', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, JSON.stringify({ at: T0 + 500, state: 'ready', msg: '⬇ medium.en: 0.6 ГБ', seq: 1, events: [] }))
  await w.clock.advance(500)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /⬇ medium\.en: 0\.6 ГБ/ })).toBeDefined()
  expect(await ui.find({ text: /Слухаю/ })).toBeDefined()
  await ui.unmount()
  // Звичайне повідомлення в стані ready рядка не займає.
  w.fs.set(BUS, JSON.stringify({ at: T0 + 1000, state: 'ready', msg: 'моделі готові', seq: 1, events: [] }))
  await w.clock.advance(500)
  const again = await $.ui.mount(BAND)
  expect(await again.find({ text: /моделі готові/ })).toBeUndefined()
  await again.unmount()
})

test('кнопка ✖: лише коли слухач у режимі команди (armed / transcribing), у ready її нема', { timeoutMs: 15000 }, async ($, on) => {
  let at = T0
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []) })
  await $.session.start(START)
  await w.clock.advance(500)
  at += 500
  let band = await $.ui.mount(BAND)
  expect(await band.find({ key: 'cancel' })).toBeUndefined()
  expect(await band.find({ text: /Скасувати команду/ })).toBeUndefined()
  await band.unmount()

  for (const [state, msg] of [['armed', 'запусти бота'], ['transcribing', null]] as const) {
    w.fs.set(BUS, JSON.stringify({ at: (at += 500), state, msg, seq: 1, events: [] }))
    await w.clock.advance(500)
    band = await $.ui.mount(BAND)
    expect(await band.find({ key: 'cancel' })).toBeDefined()
    expect(await band.find({ text: /Скасувати команду/ })).toBeDefined() // підказка hover-групи
    await band.unmount()
  }

  w.fs.set(BUS, JSON.stringify({ at: (at += 500), state: 'loading', msg: null, seq: 1, events: [] }))
  await w.clock.advance(500)
  band = await $.ui.mount(BAND)
  expect(await band.find({ key: 'cancel' })).toBeUndefined()
  await band.unmount()
})

test('кнопка ✖ англійською: підказка «Cancel the command»', { timeoutMs: 15000 }, async ($, on) => {
  let at = T0
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"language":"en"}' })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, JSON.stringify({ at: (at += 500), state: 'armed', msg: 'start the bot', seq: 1, events: [] }))
  await w.clock.advance(500)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ text: /Cancel the command/ })).toBeDefined()
  await band.unmount()
})

test('кнопка ✖: натиск пише control.json.cancelAt (час), решта полів не міняється', { timeoutMs: 15000 }, async ($, on) => {
  let at = T0
  const w = world(on, 'A', { [BUS]: bus(T0, 1, []), [CONTROL]: '{"muted":false,"beep":"wake"}' })
  await $.session.start(START)
  await w.clock.advance(500)
  w.fs.set(BUS, JSON.stringify({ at: (at += 500), state: 'armed', msg: 'запусти бота', seq: 1, events: [] }))
  await w.clock.advance(500)
  const before = JSON.parse(w.fs.get(CONTROL) ?? '{}')
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'cancel' })
  await band.unmount()
  const after = JSON.parse(w.fs.get(CONTROL) ?? '{}')
  expect(typeof after.cancelAt).toBe('number')
  expect(after.cancelAt).toBeGreaterThanOrEqual(T0 + 1000)
  const { cancelAt: _at, ...rest } = after
  expect(rest).toEqual(before) // злиттям, як restart
  expect(w.submitted).toEqual([]) // у чат нічого не йде
})
