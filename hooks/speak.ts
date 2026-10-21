// Озвучення відповідей: чисті функції блоку «🔊 Озвучити:» — пошук у відповіді агента,
// чистка під синтез мовлення, мова блоку й текст інструкції агенту. Без `$` — тестується окремо.

export type SpeakLang = 'uk' | 'en'

// Маркер на початку рядка: необов'язкові `*`/`_`, необов'язковий 🔊, слово, двокрапка
// (`**🔊 Озвучити:** текст` і `**🔊 Озвучити**: текст` — обидва).
const MARKER = /^\s*[*_]*\s*(?:🔊\s*)?(?:Озвучити|Speak)\s*[*_]*\s*:\s*[*_]*\s*(.*)$/iu
const FENCE = /^\s*```/

// Текст після маркера ОСТАННЬОГО блоку до кінця відповіді (без маркера) або null.
// Рядки всередині ``` … ``` пропускаються — приклад у коді не є блоком.
export function findSpeakBlock(answer: string): string | null {
  const lines = answer.split(/\r?\n/)
  let inFence = false
  let start = -1
  let first = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = MARKER.exec(line)
    if (m) {
      start = i
      first = m[1]!
    }
  }
  if (start < 0) return null
  const text = [first, ...lines.slice(start + 1)].join('\n').trim()
  return text === '' ? null : text
}

// Мова блоку за алфавітом: частка кирилиці серед літер ≥ 0.5 → uk, інакше en.
export function speakLang(text: string): SpeakLang {
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  if (letters === 0) return 'en'
  const cyr = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0
  return cyr / letters >= 0.5 ? 'uk' : 'en'
}

// Те, що агент міг дописати попри інструкцію: markdown, посилання, URL, емодзі. Довге — до
// `max` знаків, по межі речення (немає межі — по пробілу).
export function cleanForSpeech(text: string, max = 600): string {
  let t = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [текст](url) і ![alt](url) → текст
    .replace(/https?:\/\/\S+/g, '') // голі URL
    .replace(/```/g, ' ')
    .replace(/`/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // заголовки
    .replace(/^\s*[-*+]\s+/gm, '') // маркери списків
    .replace(/\*+/g, '')
    // `_` — лише як курсив/жирний на межі слова; усередині ідентифікатора лишається
    .replace(/(^|[\s(«"])_+/g, '$1')
    .replace(/_+(?=$|[\s.,;:!?)»"])/g, '')
    .replace(/[\p{Extended_Pictographic}︎️‍]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length <= max) return t
  t = t.slice(0, max)
  const end = Math.max(t.lastIndexOf('.'), t.lastIndexOf('!'), t.lastIndexOf('?'), t.lastIndexOf('…'))
  if (end > 0) return t.slice(0, end + 1).trim()
  const sp = t.lastIndexOf(' ')
  return (sp > 0 ? t.slice(0, sp) : t).trim()
}

// Розділ системного промпту (додається, поки озвучення ввімкнено). Мова — `language` мода.
export function speakSection(lang: SpeakLang): string {
  if (lang === 'en') {
    return [
      'Spoken summary. The user can have your answers read aloud by a local voice engine.',
      'Rules for the spoken block:',
      '- Write it only in the FINAL answer of a turn, when the work is done or you need something from the user. Never in intermediate messages. Subagents never write it.',
      '- Put it in a separate paragraph at the very end of the answer; the line starts with `🔊 Speak:`.',
      '- One to three short sentences, up to about 300 characters, conversational, as you would tell a colleague out loud.',
      '- Content: what was done or found and what is needed from the user (a decision, a check), if anything.',
      '- Plain text only: no markdown, code, file paths, URLs, identifiers or emoji (except the marker). Spell out numbers, units and abbreviations the way they are pronounced.',
      '- Write the block in the language the user speaks in this chat (by default English). The block is single-language: do not mix in words of another language.',
    ].join('\n')
  }
  return [
    'Голосове резюме. Людина може слухати твої відповіді вголос: їх читає локальний голосовий рушій.',
    'Правила голосового блоку:',
    '- Пиши його лише в ОСТАННІЙ відповіді ходу, коли роботу закінчено або від людини щось потрібно. Ніколи в проміжних повідомленнях. Субагенти блок не пишуть.',
    '- Окремим абзацом у самому кінці відповіді; рядок починається з `🔊 Озвучити:`.',
    '- Одне-три короткі речення, до приблизно трьохсот знаків, розмовно, як сказати колезі вголос.',
    '- Зміст: що зроблено чи знайдено і що потрібно від людини (рішення, перевірка), якщо потрібно.',
    '- Простий текст: без markdown, коду, шляхів, URL, ідентифікаторів, емодзі (крім маркера). Числа, одиниці й скорочення пиши словами так, як їх вимовляють.',
    '- Мова блоку — та, якою людина говорить у цьому чаті (типово українська). Блок одномовний: англійські терміни в українському блоці пиши українськими словами чи транслітом, бо український голос латиницю читає погано; якщо терміна не передати, пропусти його.',
  ].join('\n')
}
