// Рядки інтерфейсу мода: один словник на дві мови. Чистий модуль (без `$`).
// `Strings` задає ключі для обох мов разом — пропущений ключ в одній з них
// не збирається; нову мову додає ще один запис у `STR`.

import type { Lang } from './models'

/** `en` → 'en', усе інше (нема поля, бите значення) → 'uk'. */
export function langOf(v: unknown): Lang {
  return v === 'en' ? 'en' : 'uk'
}

// Типові слова за мовою: порожнє поле в ⚙ означає саме їх. uk збігається з типовими
// слухача (--wake / --stop), en — з тим, що слухач бере для `language: en`.
export const DEFAULT_WORDS: Record<Lang, { wake: string; stop: string; cancel: string; chat: string }> = {
  uk: { wake: 'Клоде, Клод, Клауд, Claude', stop: 'Роби', cancel: 'Відміна', chat: 'Зміна чату' },
  en: { wake: 'Claude', stop: 'Done', cancel: 'Cancel', chat: 'Switch chat' },
}

// Причини ризику, які повертають safety.ts (шари слів і дій) і мод. Самі причини
// лишаються українськими ключами (їх перевіряють тести safety), а людині показується
// переклад; причина від моделі, якої тут нема, іде як є.
const REASON_KEYS = [
  'вимкнення чи самознищення',
  'видалення',
  'очищення чи скидання',
  'дії з базою чи диском',
  'переписування історії',
  'гроші',
  'надсилання назовні',
  'облікові дані',
  'модель вважає ризиковим',
  'ризикова команда',
  'видалення файлів',
  'незворотна дія git',
  'видалення з бази',
  'зупинка процесів чи системи',
  'форматування диска',
  'видалення файлів у скрипті',
  'зміна системних налаштувань',
  'зміна налаштувань, захисту чи автозапуску',
  'зміна налаштувань, прав чи надсилання назовні',
  'фонова дія поза наглядом',
  'інструмент, що видаляє',
  'дія, що видаляє',
] as const
type ReasonKey = (typeof REASON_KEYS)[number]

const reasonsUk = Object.fromEntries(REASON_KEYS.map(k => [k, k])) as Record<ReasonKey, string>

export type Strings = {
  // стани слухача (короткий підпис у рядку)
  stateOff: string
  stateLoading: string
  stateReady: string
  stateArmed: string
  stateTranscribing: string
  stateMuted: string
  stateError: string
  // рядок стану в застосунку й повідомлення мода про слухача
  statusLine: (state: string) => string
  otherSessionSuffix: (title: string) => string
  lockedSuffix: string
  starting: string
  notResponding: string
  restarting: string
  noPython: (path: string) => string
  // рядок над полем вводу
  ownerMe: string
  ownerOther: (title: string) => string
  ownerNone: string
  otherChat: string
  liveTo: (title: string) => string
  liveNowhere: string
  switchHere: (why: string) => string
  switchThere: (title: string, why: string) => string
  switchNone: string
  sayWake: (word: string) => string
  seconds: string
  hereLabel: string
  hintHere: string
  hintHereLocked: (title: string) => string
  modeAuto: string
  modePinned: string
  hintModeAuto: string
  hintModePinned: string
  toastAuto: string
  toastPinned: string
  hintCancel: string
  hintMuteOn: string
  hintMuteOff: string
  hintSettingsShow: string
  hintSettingsHide: string
  hintHistoryShow: string
  hintHistoryHide: string
  // картка підтвердження
  confirmCommand: string
  confirmAction: string
  yes: string
  no: string
  why: string
  safeCardHint: (wake: string) => string
  voiceCardHint: (wake: string) => string
  // панелі
  historyTitle: string
  settingsTitle: string
  historyEmpty: string
  settingsMobile: string
  // примітки в історії, тости, відповіді людині
  noteSafeOn: string
  noteSafeOff: string
  noteAllowed: (text: string) => string
  noteAllowedAction: (text: string) => string
  noteRejected: (why: string, text: string) => string
  rejectCancelled: string
  rejectLate: string
  noteVoiceNoConfirm: string
  toastSafe: string
  toastConfirm: (text: string) => string
  // зміна чату голосом
  chatUnavailable: string
  chatNoName: string
  chatLost: string
  noteNotOwner: (text: string) => string
  toastCardFresh: string
  chatNotFound: (heard: string) => string
  chatAmbiguous: (titles: string) => string
  noteChatHere: (title: string) => string
  noteChatSwitched: (title: string, text: string) => string
  noteChatArrived: (text: string) => string
  toastBlocked: (why: string) => string
  heardSuffix: (raw: string) => string
  confirmedAction: (text: string) => string
  cancelledAction: (text: string) => string
  // команда, сказана посеред ходу агента: йде з результатом його наступного інструмента
  midTurnCommand: (text: string) => string
  noteMidTurn: (text: string) => string
  toastMidTurn: string
  // тексти, що йдуть агенту
  denyBlocked: (why: string) => string
  denyGuardFailed: string
  dropAnswer: string
  // slash-команди: описи й результати
  cmdPanel: string
  cmdHere: string
  cmdLock: string
  cmdMute: string
  cmdConfirm: string
  cmdCancel: string
  cmdSafe: string
  resPanel: string
  resHere: string
  resLocked: string
  resUnlocked: string
  resLockNotOwner: string
  resNothingConfirm: string
  resConfirmed: string
  resNothingCancel: string
  resCancelled: string
  resSafeOn: string
  resSafeOff: string
  resMicOff: string
  resMicOn: string
  // вікно ⚙
  setLanguage: string
  setLanguageHint: string
  languageNames: Record<Lang, string>
  setSafe: string
  safeOn: string
  safeOff: string
  safeOnHint: string
  safeOffHint: string
  setBeep: string
  beepOff: string
  beepWake: string
  beepEnd: string
  beepBoth: string
  beepHint: string
  setAutoEnd: string
  on: string
  off: string
  autoOnHint: string
  autoOffHint: (stop: string) => string
  setWake: string
  wakeHint: string
  setStop: string
  stopHint: (stop: string) => string
  setCancel: string
  cancelHint: (cancel: string) => string
  cancelledLine: (text: string) => string
  setChat: string
  chatHint: (wake: string, phrase: string) => string
  setPrompt: string
  promptPlaceholder: string
  promptHint: string
  setHotwords: string
  hotwordsPlaceholder: string
  hotwordsHint: string
  setGlossary: string
  glossaryHint: string
  glossaryOpen: string
  glossaryStats: (rules: number, bad: string) => string
  glossarySaved: (rules: number) => string
  glossaryTemplate: string
  glossaryGenerate: string
  genRunningLabel: string
  genAgentName: string
  genRunning: string
  genDone: (rules: number, words: number) => string
  genFailed: (why: string) => string
  genBadReply: string
  genTimeout: string
  genSection: (day: string) => string
  draftNote: string
  draftDiscard: string
  setAutoTerms: string
  autoTermsHint: string
  termsOff: string
  termExists: string
  termAdded: (heard: string, write: string) => string
  noteTermAdded: (heard: string, write: string) => string
  autoNote: (day: string) => string
  save: string
  restartButton: string
  // обробка команди проміжною моделлю
  setFilterMode: string
  filterModeOff: string
  filterModeBoth: string
  filterModeClean: string
  filterModeHint: string
  setFilterModel: string
  filterModelHint: string
  setFilterTimeout: string
  filterTimeoutHint: string
  setFilterNotes: string
  setFilterSystem: string
  filterSystemHint: string
  filterSystemReset: string
  filterSystemDefault: string
  filterSystemCustom: string
  advanced: string
  groupRecognition: string
  groupProcessing: string
  groupSafety: string
  filterNotesPlaceholder: string
  filterNotesHint: string
  // вибір моделей розпізнавання
  setWakeModel: string
  wakeModelHint: string
  setModel: string
  modelHint: string
  modelDefault: (name: string) => string
  modelUnsuitable: (name: string) => string
  // підписи списків моделей (models.ts)
  modelRecommended: string
  modelVram: string
  modelRam: string
  unitGb: string
  unitMb: string
  reasons: Record<ReasonKey, string>
}

const uk: Strings = {
  stateOff: 'Вимкнено',
  stateLoading: 'Завантаження',
  stateReady: 'Слухаю',
  stateArmed: 'Слухаю команду',
  stateTranscribing: 'Розпізнаю',
  stateMuted: 'Mic off',
  stateError: 'Помилка',
  statusLine: state => `Голос: ${state}`,
  otherSessionSuffix: title => ` → «${title}»`,
  lockedSuffix: ' 🔒',
  starting: 'запускаю…',
  notResponding: 'слухач не відповідає — перезапускаю',
  restarting: 'перезапуск…',
  noPython: path => `нема ${path}`,
  ownerMe: 'Голос тут',
  ownerOther: title => `Голос → «${title}»`,
  ownerNone: 'Голос ні в якому чаті',
  otherChat: 'інший чат',
  liveTo: title => `→ «${title}»: `,
  liveNowhere: '(нікуди не піде — натисніть 🎧) ',
  switchHere: why =>
    `Голос тепер тут — ${{ typed: 'ви написали в цьому чаті', button: 'перемкнуто кнопкою', voice: 'голосова команда', first: 'перший чат' }[why] ?? 'перемкнуто'}`,
  switchThere: (title, why) =>
    `Голос → «${title}» — ${{ typed: 'ви написали там', button: 'перемкнуто кнопкою', voice: 'голосова команда', first: 'перший чат' }[why] ?? 'перемкнуто'}`,
  switchNone: 'Голос ні в якому чаті: чат, що слухав, закрито — напишіть у потрібному чи натисніть 🎧',
  sayWake: word => `Скажіть «${word}, …»`,
  seconds: 'с',
  hereLabel: '🎧 Сюди',
  hintHere: 'Сюди: голос слухатиме цей чат',
  hintHereLocked: title => `Сюди: голос слухатиме цей чат (закріплення з «${title}» зніметься)`,
  modeAuto: '🔓 Авто',
  modePinned: '🔒 Закріплено',
  hintModeAuto: 'Авто: голос іде за чатом, де ви пишете. Натисніть — закріпити тут',
  hintModePinned: 'Закріплено: голос тут, хоч би де ви писали; перемкнути — 🎧 в іншому чаті чи голосом. Натисніть — Авто',
  toastAuto: 'Авто: голос іде за чатом, де ви пишете',
  toastPinned: 'Голос закріплено за цим чатом',
  hintCancel: 'Скасувати команду',
  hintMuteOn: 'Увімкнути мікрофон',
  hintMuteOff: 'Вимкнути мікрофон',
  hintSettingsShow: 'Налаштування',
  hintSettingsHide: 'Сховати налаштування',
  hintHistoryShow: 'Історія: що чув розпізнавач',
  hintHistoryHide: 'Сховати історію',
  confirmCommand: 'Підтвердіть команду',
  confirmAction: 'Підтвердіть дію',
  yes: 'Так',
  no: 'Ні',
  why: 'Чому',
  safeCardHint: wake =>
    `Безпечний режим: підтвердження — кнопкою, «так» у чаті чи /voice-confirm; голосом лише «${wake}, ні».`,
  voiceCardHint: wake => `Скажіть «${wake}, так» або «${wake}, ні».`,
  historyTitle: 'Голос: історія',
  settingsTitle: 'Голос: налаштування',
  historyEmpty: 'Поки нічого не чув.',
  settingsMobile: 'Налаштування голосу — у застосунку на ПК.',
  noteSafeOn: '🔒 безпечний режим увімкнено',
  noteSafeOff: '🔓 безпечний режим вимкнено',
  noteAllowed: text => `✓ дозволено: ${text}`,
  noteAllowedAction: text => `✓ дозволено дію: ${text}`,
  noteRejected: (why, text) => `✗ ${why}: ${text}`,
  rejectCancelled: 'скасовано',
  rejectLate: 'не підтверджено вчасно',
  noteVoiceNoConfirm: '🔒 голосом не підтверджується: кнопка, «так» у чаті чи /voice-confirm',
  toastSafe: 'Безпечний режим: підтвердіть кнопкою або текстом',
  toastConfirm: text => `Голос: потрібне підтвердження — ${text}`,
  chatUnavailable: 'Зміна чату: список чатів недоступний (ListAgents не дозволено без питання)',
  chatNoName: 'Зміна чату: назвіть чат одразу після фрази',
  chatLost: 'Зміна чату: голос тим часом перейшов в інший чат — нічого не передано',
  noteNotOwner: text => `Не відправлено: «${text}» — голос уже в іншому чаті`,
  toastCardFresh: 'Картка щойно змінилась — перевірте, що підтверджуєте, і натисніть ще раз',
  chatNotFound: heard => `Зміна чату: не знайшов чат «${heard}» — команду нікуди не відправлено`,
  chatAmbiguous: titles => `Зміна чату: схожі кілька — ${titles}; скажіть точніше`,
  noteChatHere: title => `→ чат «${title}» — це він і є`,
  noteChatSwitched: (title, text) => `→ голос у чаті «${title}»${text ? `: ${text}` : ''}`,
  noteChatArrived: text => `← голос передано сюди${text ? `: ${text}` : ''}`,
  toastBlocked: why => `Голос: зупинено «${why}» — потрібне підтвердження`,
  heardSuffix: raw => `(розпізнано: «${raw}»)`,
  confirmedAction: text => `Підтверджую дію: ${text}. Повтори рівно той самий виклик.`,
  cancelledAction: text => `Скасовано: дію «${text}» НЕ виконуй.`,
  midTurnCommand: text =>
    'Голосова команда людини, сказана під час твоєї роботи (не частина результату інструмента) — ' +
    `врахуй її зараз: «${text}»`,
  noteMidTurn: text => `↪ відправлено під час роботи агента: ${text}`,
  toastMidTurn: 'Голос: відправлено під час роботи агента',
  denyBlocked: why =>
    `Голосова команда: руйнівну дію (${why}) зупинено до підтвердження людини. ` +
    'Коротко скажи людині, що саме збираєшся зробити і навіщо, і зупинись. ' +
    'Людина підтвердить голосом («Клоде, так») або кнопкою на панелі «Голос» — тоді прийде ' +
    'повідомлення, і ти повториш РІВНО той самий виклик. Не обходь це іншою командою.',
  denyGuardFailed: 'Голосовий гвард дав збій — дію зупинено. Спитай людину.',
  dropAnswer: 'відповідь на картку підтвердження голосового мода',
  cmdPanel: 'Голосові команди: історія почутого',
  cmdHere: 'Голосові команди: слухати в цій сесії',
  cmdLock: 'Голосові команди: режим «Закріплено» / «Авто»',
  cmdMute: 'Голосові команди: вимкнути / увімкнути мікрофон',
  cmdConfirm: 'Голосові команди: підтвердити, що чекає на картці',
  cmdCancel: 'Голосові команди: скасувати, що чекає на картці',
  cmdSafe: 'Голосові команди: безпечний режим (підтвердження лише мишкою чи текстом)',
  resPanel: 'Історію голосу відкрито.',
  resHere: 'Голосові команди тепер ідуть у цю сесію.',
  resLocked: 'Голос закріплено за цим чатом: повідомлення в інших чатах його не перехоплять.',
  resUnlocked: 'Закріплення знято: голос іде за чатом, де писали востаннє.',
  resLockNotOwner: 'Голос зараз в іншому чаті — спершу /voice-here, потім закріпити.',
  resNothingConfirm: 'Нема чого підтверджувати.',
  resConfirmed: 'Підтверджено.',
  resNothingCancel: 'Нема чого скасовувати.',
  resCancelled: 'Скасовано.',
  resSafeOn: 'Безпечний режим увімкнено: небезпечне — лише кнопкою чи текстом.',
  resSafeOff: 'Безпечний режим вимкнено: небезпечне можна підтвердити й голосом.',
  resMicOff: 'Мікрофон вимкнено.',
  resMicOn: 'Мікрофон увімкнено.',
  setLanguage: 'Мова',
  setLanguageHint: 'Мова інтерфейсу й розпізнавання.',
  languageNames: { uk: 'Українська', en: 'English' },
  setSafe: 'Безпечний режим',
  safeOn: '🔒 Увімкнено',
  safeOff: '🔓 Вимкнено',
  safeOnHint: 'Небезпечне підтверджується лише кнопкою чи текстом, не голосом.',
  safeOffHint: '«Так» голосом теж підтверджує небезпечну дію.',
  setBeep: 'Звуковий сигнал',
  beepOff: 'Вимкнено',
  beepWake: 'Одразу після активатора',
  beepEnd: 'Після команди',
  beepBoth: 'Обидва',
  beepHint:
    'Після активатора — щойно почуто «Клоде», ще під час фрази; після команди — щойно почуто стоп-слово чи команда закінчилась; обидва — і те, і те.',
  setAutoEnd: 'Автозавершення',
  on: 'Увімкнено',
  off: 'Вимкнено',
  autoOnHint: 'Команда закінчується паузою в мові.',
  autoOffHint: stop => `Запис триває навіть у тиші, доки не скажете «${stop}» (до 5 хв).`,
  setWake: 'Слово-активатор',
  wakeHint: 'Кілька варіантів — через кому; порожньо — типове для мови.',
  setCancel: 'Слово скасування',
  setStop: 'Стоп-слово',
  stopHint: stop =>
    `Відправляє команду, коли автозавершення вимкнено: скажіть «${stop}». Порожньо — типове для мови.`,
  cancelHint: cancel =>
    `Скасовує команду: скажіть «${cancel}» в її кінці — і нічого не піде в чат (діє в обох режимах). Кілька слів — через кому. Порожньо — типове для мови.`,
  cancelledLine: text => (text ? `✗ скасовано: ${text}` : '✗ скасовано'),
  setChat: 'Зміна чату (експериментально)',
  chatHint: (wake, phrase) =>
    `«${wake}, ${phrase} <назва чату>, <команда>» — команда піде в той чат (назва як у бічній панелі; довгу можна почати). ` +
    `Діє лише одразу після «${wake}», посеред команди — звичайний текст. Без команди — голос просто переходить у той чат. ` +
    'Кілька варіантів — через кому; порожньо — типове.',
  setPrompt: 'Підказка розпізнавачу',
  promptPlaceholder: 'загальна',
  promptHint: 'Зразок фрази зі словами вашого проєкту: whisper пише їх охочіше. Порожньо — загальна.',
  setHotwords: 'Слова-підказки',
  hotwordsPlaceholder: 'немає',
  hotwordsHint: 'Назви й терміни через кому, які розпізнавач має чути саме так.',
  setGlossary: 'Словник виправлень',
  glossaryHint:
    'Що розпізнавач пише неправильно => як писати: «логін | лоґін => Login». Варіанти через «|», ' +
    '# — коментар. Enter зберігає, Shift+Enter — новий рядок; діє з наступної фрази. ' +
    'Файл — %USERPROFILE%\\.claude\\voice-mod\\glossary.txt; «Відкрити» — у вашому редакторі.',
  glossaryOpen: 'Відкрити',
  glossaryStats: (rules, bad) =>
    `Правил: ${rules}` + (bad ? ` · рядки ${bad} без «=>» — не діють` : ''),
  glossarySaved: rules => `Словник збережено: правил — ${rules}`,
  glossaryTemplate:
    '# Особистий словник: що чує розпізнавач => як писати.\n' +
    '# Варіанти через «|», регістр не важить, межі — цілі слова. # — коментар.\n' +
    '# Приклад:  май ап | майап => MyApp\n',
  glossaryGenerate: 'Згенерувати',
  genRunningLabel: 'Генерую…',
  genAgentName: 'Термінологія для голосу',
  genRunning: 'Агент Opus читає проєкт і чати — це кілька хвилин; можна закрити ⚙.',
  genDone: (rules, words) =>
    `Згенеровано: правил — ${rules}, слів-підказок — ${words}. Перегляньте поля й збережіть Enter.`,
  genFailed: why => `Не вдалося запустити агента: ${why}`,
  genBadReply: 'Агент не повернув JSON зі словником — спробуйте ще раз.',
  genTimeout: 'Агент не відповів за 10 хв — спробуйте ще раз.',
  genSection: day => `# Згенеровано ${day} — перегляньте`,
  draftNote: 'Чернетка — ще не збережено',
  draftDiscard: 'Відкинути',
  setAutoTerms: 'Агенти доповнюють словник',
  autoTermsHint:
    'Агент, побачивши, що розпізнавач спотворив термін проєкту, сам додає правило в словник ' +
    '(позначка «# авто» з датою) і коротко про це каже. Вимкнено — інструмент ховається від агентів.',
  termsOff: 'Самодоповнення словника вимкнено людиною в налаштуваннях голосу — не викликай цей інструмент.',
  termExists: 'Ці варіанти словник уже виправляє — нічого не додано.',
  termAdded: (heard, write) => `Додано в словник: «${heard}» => ${write}. Діє з наступної фрази.`,
  noteTermAdded: (heard, write) => `📖 словник: «${heard}» => ${write}`,
  autoNote: day => `авто ${day}`,
  save: 'зберегти',
  restartButton: '↻ Перезапустити слухача',
  setFilterMode: 'Обробка команди',
  filterModeOff: 'Сирий текст',
  filterModeBoth: 'Очищене + сире',
  filterModeClean: 'Лише очищене',
  filterModeHint:
    'Що мод робить із розпізнаним текстом перед відправкою агенту. Сирий текст — як почуто, модель не кличеться (ризик — лише за локальним списком); Очищене + сире — модель виправляє текст, поруч іде «розпізнано»; Лише очищене — без «розпізнано».',
  setFilterModel: 'Модель обробки',
  filterModelHint: 'Яка модель чистить команду й оцінює ризик: haiku — швидша, sonnet — точніша, але повільніша.',
  setFilterTimeout: 'Тайм-аут',
  filterTimeoutHint: 'Скільки чекати на модель обробки. Минув час — іде сирий текст з локальною оцінкою ризику.',
  setFilterNotes: 'Доповнення до інструкції',
  setFilterSystem: 'Інструкція моделі',
  filterSystemHint:
    'Системна інструкція моделі обробки. Модель отримує лише її, слова-підказки (як писати терміни), ' +
    'доповнення нижче і текст команди в тегах <command> — уже виправлений словником. ' +
    'Enter зберігає, Shift+Enter — новий рядок; «Типова» ' +
    'повертає вбудовану. Відповідь мусить лишитись JSON {"clean", "risk", "reason"}: інакше йде сирий текст ' +
    'і лише локальна перевірка ризику.',
  filterSystemReset: 'Типова',
  filterSystemDefault: 'Типова інструкція — оновлюється з модом і мовою.',
  filterSystemCustom: 'Своя інструкція — оновлення мода й зміна мови її не чіпають.',
  advanced: 'Розширені',
  groupRecognition: 'Розпізнавання',
  groupProcessing: 'Обробка команди',
  groupSafety: 'Безпека й чати',
  filterNotesPlaceholder: 'немає',
  filterNotesHint:
    'Короткі свої правила, що дописуються в кінець інструкції (і своєї, і типової). Наприклад: «MyApp і Login пиши латиницею».',
  setWakeModel: 'Мала модель (активатор)',
  wakeModelHint:
    "Швидка модель: ловить активатор і веде чернетку. ★ — якість, ~ГБ — пам'ять на цьому пристрої, ⬇ — ще не завантажена: вибір такої і є згодою на завантаження. Порожньо — типова.",
  setModel: 'Велика модель (команда)',
  modelHint:
    "Точна модель: розпізнає саму команду після активатора. ★ — якість, ~ГБ — пам'ять на цьому пристрої, ⬇ — ще не завантажена: вибір такої і є згодою на завантаження. Підміна займає 10–30 с без голосу.",
  modelDefault: name => `Типова (${name})`,
  modelUnsuitable: name => `Для української вибрано типову (${name}): ця модель розуміє лише англійську.`,
  modelRecommended: '★ рекомендовано · ',
  modelVram: "відеопам'яті",
  modelRam: 'ОЗП',
  unitGb: 'ГБ',
  unitMb: 'МБ',
  reasons: reasonsUk,
}

const en: Strings = {
  stateOff: 'Off',
  stateLoading: 'Loading',
  stateReady: 'Listening',
  stateArmed: 'Listening for a command',
  stateTranscribing: 'Transcribing',
  stateMuted: 'Mic off',
  stateError: 'Error',
  statusLine: state => `Voice: ${state}`,
  otherSessionSuffix: title => ` → «${title}»`,
  lockedSuffix: ' 🔒',
  starting: 'starting…',
  notResponding: 'listener not responding — restarting',
  restarting: 'restarting…',
  noPython: path => `not found: ${path}`,
  ownerMe: 'Voice here',
  ownerOther: title => `Voice → «${title}»`,
  ownerNone: 'Voice in no chat',
  otherChat: 'another chat',
  liveTo: title => `→ «${title}»: `,
  liveNowhere: '(goes nowhere — press 🎧) ',
  switchHere: why =>
    `Voice is here now — ${{ typed: 'you wrote in this chat', button: 'switched by button', voice: 'voice command', first: 'first chat' }[why] ?? 'switched'}`,
  switchThere: (title, why) =>
    `Voice → «${title}» — ${{ typed: 'you wrote there', button: 'switched by button', voice: 'voice command', first: 'first chat' }[why] ?? 'switched'}`,
  switchNone: 'Voice is in no chat: the listening chat was closed — write in the one you need or press 🎧',
  sayWake: word => `Say «${word}, …»`,
  seconds: 's',
  hereLabel: '🎧 Here',
  hintHere: 'Here: voice will listen to this chat',
  hintHereLocked: title => `Here: voice will listen to this chat (unpins it from «${title}»)`,
  modeAuto: '🔓 Auto',
  modePinned: '🔒 Pinned',
  hintModeAuto: 'Auto: voice follows the chat you write in. Press to pin it here',
  hintModePinned: 'Pinned: voice stays here wherever you write; switch with 🎧 in another chat or by voice. Press for Auto',
  toastAuto: 'Auto: voice follows the chat you write in',
  toastPinned: 'Voice pinned to this chat',
  hintCancel: 'Cancel the command',
  hintMuteOn: 'Unmute the microphone',
  hintMuteOff: 'Mute the microphone',
  hintSettingsShow: 'Settings',
  hintSettingsHide: 'Hide settings',
  hintHistoryShow: 'History: what the recognizer heard',
  hintHistoryHide: 'Hide history',
  confirmCommand: 'Confirm the command',
  confirmAction: 'Confirm the action',
  yes: 'Yes',
  no: 'No',
  why: 'Why',
  safeCardHint: wake =>
    `Safe mode: confirm with the button, "yes" in the chat or /voice-confirm; by voice only «${wake}, no».`,
  voiceCardHint: wake => `Say «${wake}, yes» or «${wake}, no».`,
  historyTitle: 'Voice: history',
  settingsTitle: 'Voice: settings',
  historyEmpty: 'Nothing heard yet.',
  settingsMobile: 'Voice settings are in the desktop app.',
  noteSafeOn: '🔒 safe mode on',
  noteSafeOff: '🔓 safe mode off',
  noteAllowed: text => `✓ allowed: ${text}`,
  noteAllowedAction: text => `✓ allowed the action: ${text}`,
  noteRejected: (why, text) => `✗ ${why}: ${text}`,
  rejectCancelled: 'cancelled',
  rejectLate: 'not confirmed in time',
  noteVoiceNoConfirm: '🔒 not confirmable by voice: use the button, "yes" in the chat or /voice-confirm',
  toastSafe: 'Safe mode: confirm with the button or by typing',
  toastConfirm: text => `Voice: confirmation needed — ${text}`,
  chatUnavailable: 'Switch chat: the chat list is unavailable (ListAgents is not allowed without asking)',
  chatNoName: 'Switch chat: name the chat right after the phrase',
  chatLost: 'Switch chat: voice moved to another chat meanwhile — nothing handed over',
  noteNotOwner: text => `Not sent: «${text}» — voice is already in another chat`,
  toastCardFresh: 'The card just changed — check what you are confirming and press again',
  chatNotFound: heard => `Switch chat: no chat «${heard}» found — the command went nowhere`,
  chatAmbiguous: titles => `Switch chat: several match — ${titles}; be more specific`,
  noteChatHere: title => `→ chat «${title}» — already here`,
  noteChatSwitched: (title, text) => `→ voice in chat «${title}»${text ? `: ${text}` : ''}`,
  noteChatArrived: text => `← voice handed over here${text ? `: ${text}` : ''}`,
  toastBlocked: why => `Voice: stopped "${why}" — confirmation needed`,
  heardSuffix: raw => `(heard: «${raw}»)`,
  confirmedAction: text => `I confirm the action: ${text}. Repeat exactly the same call.`,
  cancelledAction: text => `Cancelled: do NOT run the action "${text}".`,
  midTurnCommand: text =>
    'A voice command from the human, spoken while you were working (not part of the tool result) — ' +
    `take it into account now: «${text}»`,
  noteMidTurn: text => `↪ sent while the agent was working: ${text}`,
  toastMidTurn: 'Voice: sent while the agent was working',
  denyBlocked: why =>
    `Voice command: a destructive action (${why}) was stopped until the human confirms. ` +
    'Briefly tell the human what exactly you are about to do and why, then stop. ' +
    'The human will confirm by voice ("Claude, yes") or with the button on the Voice panel, and then a ' +
    'message will arrive and you repeat EXACTLY the same call. Do not work around this with another command.',
  denyGuardFailed: 'The voice guard failed — the action was stopped. Ask the human.',
  dropAnswer: "an answer to the voice mod's confirmation card",
  cmdPanel: 'Voice commands: history of what was heard',
  cmdHere: 'Voice commands: listen in this session',
  cmdLock: 'Voice commands: "Pinned" / "Auto" mode',
  cmdMute: 'Voice commands: mute / unmute the microphone',
  cmdConfirm: 'Voice commands: confirm what the card is waiting for',
  cmdCancel: 'Voice commands: cancel what the card is waiting for',
  cmdSafe: 'Voice commands: safe mode (confirm only with the mouse or by typing)',
  resPanel: 'Voice history opened.',
  resHere: 'Voice commands now go to this session.',
  resLocked: 'Voice pinned to this chat: messages in other chats will not take it.',
  resUnlocked: 'Unpinned: voice follows the chat you last wrote in.',
  resLockNotOwner: 'Voice is in another chat — /voice-here first, then pin.',
  resNothingConfirm: 'Nothing to confirm.',
  resConfirmed: 'Confirmed.',
  resNothingCancel: 'Nothing to cancel.',
  resCancelled: 'Cancelled.',
  resSafeOn: 'Safe mode on: dangerous actions only by button or text.',
  resSafeOff: 'Safe mode off: dangerous actions can be confirmed by voice too.',
  resMicOff: 'Microphone muted.',
  resMicOn: 'Microphone unmuted.',
  setLanguage: 'Language',
  setLanguageHint: 'Language of the interface and of recognition.',
  languageNames: { uk: 'Українська', en: 'English' },
  setSafe: 'Safe mode',
  safeOn: '🔒 On',
  safeOff: '🔓 Off',
  safeOnHint: 'Dangerous actions are confirmed only with the button or by typing, not by voice.',
  safeOffHint: '"Yes" by voice also confirms a dangerous action.',
  setBeep: 'Beep',
  beepOff: 'Off',
  beepWake: 'Right after the wake word',
  beepEnd: 'After the command',
  beepBoth: 'Both',
  beepHint:
    'After the wake word — as soon as «Claude» is heard, mid-phrase; after the command — as soon as the stop word is heard or the command ends; both — each of them.',
  setAutoEnd: 'Auto-end',
  on: 'On',
  off: 'Off',
  autoOnHint: 'The command ends with a pause in speech.',
  autoOffHint: stop => `Recording goes on even in silence until you say «${stop}» (up to 5 min).`,
  setWake: 'Wake word',
  wakeHint: 'Several variants, comma-separated; empty — the default for the language.',
  setCancel: 'Cancel word',
  setStop: 'Stop word',
  stopHint: stop =>
    `Sends the command when auto-end is off: say «${stop}». Empty — the default for the language.`,
  cancelHint: cancel =>
    `Cancels the command: say «${cancel}» at its end and nothing goes to the chat (works in both modes). Several words — separated by commas. Empty — the default for the language.`,
  cancelledLine: text => (text ? `✗ cancelled: ${text}` : '✗ cancelled'),
  setChat: 'Switch chat (experimental)',
  chatHint: (wake, phrase) =>
    `«${wake}, ${phrase} <chat name>, <command>» — the command goes to that chat (name as in the sidebar; a long one can be started). ` +
    `Works only right after «${wake}»; mid-command it is plain text. Without a command, voice just moves to that chat. ` +
    'Several variants, comma-separated; empty — the default.',
  setPrompt: 'Recognizer prompt',
  promptPlaceholder: 'general',
  promptHint: 'A sample phrase with your project\'s words: whisper writes them more readily. Empty — general.',
  setHotwords: 'Hotwords',
  hotwordsPlaceholder: 'none',
  hotwordsHint: 'Names and terms, comma-separated, that the recognizer should hear exactly like this.',
  setGlossary: 'Corrections glossary',
  glossaryHint:
    'What the recognizer writes wrong => how to write it: «my app | myap => MyApp». Variants separated by «|», ' +
    '# starts a comment. Enter saves, Shift+Enter adds a line; works from the next phrase. ' +
    'File: %USERPROFILE%\\.claude\\voice-mod\\glossary.txt; «Open» opens it in your editor.',
  glossaryOpen: 'Open',
  glossaryStats: (rules, bad) =>
    `Rules: ${rules}` + (bad ? ` · lines ${bad} have no «=>» — ignored` : ''),
  glossarySaved: rules => `Glossary saved: ${rules} rules`,
  glossaryTemplate:
    '# Personal glossary: what the recognizer hears => how to write it.\n' +
    '# Variants separated by «|», case-insensitive, whole words only. # starts a comment.\n' +
    '# Example:  my app | myap => MyApp\n',
  glossaryGenerate: 'Generate',
  genRunningLabel: 'Generating…',
  genAgentName: 'Voice terminology',
  genRunning: 'An Opus agent is reading the project and chats — a few minutes; you can close ⚙.',
  genDone: (rules, words) => `Generated: ${rules} rules, ${words} hotwords. Review the fields and save with Enter.`,
  genFailed: why => `Could not start the agent: ${why}`,
  genBadReply: 'The agent did not return glossary JSON — try again.',
  genTimeout: 'The agent did not answer in 10 min — try again.',
  genSection: day => `# Generated ${day} — review`,
  draftNote: 'Draft — not saved yet',
  draftDiscard: 'Discard',
  setAutoTerms: 'Agents extend the glossary',
  autoTermsHint:
    'When an agent sees the recognizer garbled a project term, it adds a rule to the glossary itself ' +
    '(marked «# auto» with the date) and says so briefly. Off — the tool is hidden from agents.',
  termsOff: 'Glossary self-extension is turned off by the user in the voice settings — do not call this tool.',
  termExists: 'The glossary already corrects these forms — nothing added.',
  termAdded: (heard, write) => `Added to the glossary: «${heard}» => ${write}. Works from the next phrase.`,
  noteTermAdded: (heard, write) => `📖 glossary: «${heard}» => ${write}`,
  autoNote: day => `auto ${day}`,
  save: 'save',
  restartButton: '↻ Restart the listener',
  setFilterMode: 'Command processing',
  filterModeOff: 'Raw text',
  filterModeBoth: 'Cleaned + raw',
  filterModeClean: 'Cleaned only',
  filterModeHint:
    'What the mod does with the recognized text before sending it to the agent. Raw text — as heard, no model call (risk — from the local list only); Cleaned + raw — a model fixes the text and «heard» follows it; Cleaned only — without «heard».',
  setFilterModel: 'Processing model',
  filterModelHint: 'Which model cleans the command and rates its risk: haiku is faster, sonnet is more accurate but slower.',
  setFilterTimeout: 'Timeout',
  filterTimeoutHint: 'How long to wait for the processing model. When it runs out, the raw text goes on with the local risk check.',
  setFilterNotes: 'Instruction additions',
  setFilterSystem: 'Model instruction',
  filterSystemHint:
    'The processing model\'s system instruction. The model gets only this, the hotwords (how to spell terms), ' +
    'the additions below and the command text in <command> tags — already corrected by the glossary. ' +
    'Enter saves, Shift+Enter adds a line; «Default» ' +
    'restores the built-in one. The reply must stay JSON {"clean", "risk", "reason"}: otherwise the raw text goes ' +
    'with only the local risk check.',
  filterSystemReset: 'Default',
  filterSystemDefault: 'Default instruction — updates with the mod and the language.',
  filterSystemCustom: 'Custom instruction — mod updates and language changes leave it as is.',
  advanced: 'Advanced',
  groupRecognition: 'Recognition',
  groupProcessing: 'Command processing',
  groupSafety: 'Safety and chats',
  filterNotesPlaceholder: 'none',
  filterNotesHint:
    'Short rules of your own, appended to the end of the instruction (custom or default). For example: "Write MyApp and Login in Latin letters".',
  setWakeModel: 'Small model (wake word)',
  wakeModelHint:
    'The fast model: catches the wake word and drafts the phrase. ★ — quality, ~GB — memory on this device, ⬇ — not downloaded yet: choosing it is your consent to download. Empty — the default.',
  setModel: 'Large model (command)',
  modelHint:
    'The accurate model: transcribes the command itself after the wake word. ★ — quality, ~GB — memory on this device, ⬇ — not downloaded yet: choosing it is your consent to download. Swapping takes 10–30 s without voice.',
  modelDefault: name => `Default (${name})`,
  modelUnsuitable: name => `This model does not fit the language; the default (${name}) is used.`,
  modelRecommended: '★ recommended · ',
  modelVram: 'VRAM',
  modelRam: 'RAM',
  unitGb: 'GB',
  unitMb: 'MB',
  reasons: {
    'вимкнення чи самознищення': 'shutdown or self-destruction',
    'видалення': 'deletion',
    'очищення чи скидання': 'clearing or resetting',
    'дії з базою чи диском': 'database or disk operation',
    'переписування історії': 'rewriting history',
    'гроші': 'money',
    'надсилання назовні': 'sending outside',
    'облікові дані': 'credentials',
    'модель вважає ризиковим': 'the model considers it risky',
    'ризикова команда': 'risky command',
    'видалення файлів': 'file deletion',
    'незворотна дія git': 'irreversible git action',
    'видалення з бази': 'database deletion',
    'зупинка процесів чи системи': 'stopping processes or the system',
    'форматування диска': 'disk formatting',
    'видалення файлів у скрипті': 'file deletion in a script',
    'зміна системних налаштувань': 'system settings change',
    'зміна налаштувань, захисту чи автозапуску': 'change to settings, protection or autostart',
    'зміна налаштувань, прав чи надсилання назовні': 'change to settings or permissions, or sending outside',
    'фонова дія поза наглядом': 'background action outside supervision',
    'інструмент, що видаляє': 'a tool that deletes',
    'дія, що видаляє': 'an action that deletes',
  },
}

export const STR: Record<Lang, Strings> = { uk, en }

/** Причина ризику мовою інтерфейсу; невідома (від моделі) лишається як є. */
export function reasonText(t: Strings, reason: string): string {
  return (t.reasons as Record<string, string>)[reason] ?? reason
}
