// Зміна чату голосом (експериментально): «Клоде, зміна чату <назва>, <команда>».
// Назви чатів — як у бічній панелі застосунку: їх дає інструмент ListAgents
// (рядок «This session is <назва> [ref]» про себе і по рядку на кожен інший чат).
// Тут — лише чисті функції; хто що кому передає — у register.tsx.

/** Чат-кандидат: сесія мода й назва, під якою її знає ListAgents. */
export type Chat = { id: string; title: string }

export type Listing = {
  self: { title: string; ref: string } | null
  peers: { title: string; ref: string }[]
}

const WORD = /[\p{L}\p{N}]+/gu

/** Слова для порівняння: нижній регістр, без розділових знаків і апострофів. */
export function words(text: string): string[] {
  return (text.toLowerCase().replace(/['’ʼ`]/g, '').match(WORD) ?? [])
}

/** Схожість 0..1 за відстанню Левенштейна (1 — однакові). */
export function similar(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return 1 - (prev[b.length] ?? 0) / Math.max(a.length, b.length)
}

// Слово фрази допускає неточний запис («зміни чат» ≈ «зміна чату»), але перші дві
// літери — ті самі: інакше «змінна» чи «чай» теж відкривали б зміну чату.
const PHRASE_RATIO = 0.7

function sameWord(heard: string, want: string): boolean {
  return heard.slice(0, 2) === want.slice(0, 2) && similar(heard, want) >= PHRASE_RATIO
}

/** Токени тексту з позицією кінця кожного слова в оригіналі (щоб віддати решту як є). */
function tokens(text: string): { word: string; end: number }[] {
  const out: { word: string; end: number }[] = []
  for (const m of text.matchAll(/\S+/g)) {
    const w = words(m[0]).join('')
    if (w) out.push({ word: w, end: (m.index ?? 0) + m[0].length })
  }
  return out
}

/** Решта оригіналу після `count` слів, без розділових знаків на початку. */
function after(text: string, toks: { end: number }[], count: number): string {
  if (count === 0) return text.trim()
  const end = toks[count - 1]?.end ?? text.length
  return text.slice(end).replace(/^[\s,.:;!?—–-]+/, '').trim()
}

/**
 * Команда починається фразою зміни чату (одна з фраз через кому)? → решта тексту
 * (назва чату й команда), інакше null. Лише ПОЧАТОК: фраза посеред команди — звичайний текст.
 */
export function chatPhraseRest(text: string, phrases: string): string | null {
  const toks = tokens(text)
  for (const phrase of phrases.split(',')) {
    const want = words(phrase)
    if (!want.length || toks.length < want.length) continue
    if (want.every((w, i) => sameWord(toks[i]?.word ?? '', w))) return after(text, toks, want.length)
  }
  return null
}

/**
 * Вивід ListAgents → назва й ref цього чату та інших (рядки «<назва> [ref]  ·  …»).
 * Назва жадібна: в ній самій бувають дужки («Fix [wip] parser [e4001a]»), а ref —
 * останні дужки перед « — » чи « · ».
 */
export function parseListing(listing: string): Listing {
  const selfM = /This session is (.+) \[([0-9a-z]+)\](?:\s+[—·-]|\s*$)/im.exec(listing)
  const peers: { title: string; ref: string }[] = []
  for (const line of listing.split(/\r?\n/)) {
    const m = /^\s+(.+) \[([0-9a-z]+)\](?:\s+·|\s*$)/i.exec(line)
    if (m?.[1] && m[2]) peers.push({ title: m[1].trim(), ref: m[2] })
  }
  return { self: selfM?.[1] && selfM[2] ? { title: selfM[1].trim(), ref: selfM[2] } : null, peers }
}

const MATCH_RATIO = 0.75 // нижче — назву не впізнано
const PREFIX_PENALTY = 0.05 // початок довгої назви — трохи гірше за повну
const AMBIGUOUS_GAP = 0.05 // два чати майже однаково схожі — не вгадуємо

export type ChatMatch = { chat: Chat; text: string } | { ambiguous: Chat[] } | null

/**
 * Назва чату на початку `rest` → чат і команда після назви. Порівнює перші k слів із
 * повною назвою чату або з її початком (від двох слів): довгі автоназви кажуть скорочено.
 */
export function matchChat(rest: string, chats: readonly Chat[]): ChatMatch {
  const toks = tokens(rest)
  const scored: { chat: Chat; score: number; count: number }[] = []
  for (const chat of chats) {
    const title = words(chat.title)
    if (!title.length) continue
    const variants: { text: string; penalty: number; n: number }[] = [{ text: title.join(' '), penalty: 0, n: title.length }]
    for (let n = 2; n < title.length; n++) variants.push({ text: title.slice(0, n).join(' '), penalty: PREFIX_PENALTY, n })
    let best = { score: 0, count: 0 }
    for (const v of variants) {
      for (let k = Math.max(1, v.n - 1); k <= Math.min(toks.length, v.n + 1); k++) {
        const heard = toks.slice(0, k).map(t => t.word).join(' ')
        const score = similar(heard, v.text) - v.penalty
        // Нарівні — довший шматок: «привязка до чату» не має лишати «чату» в команді.
        if (score > best.score || (score === best.score && k > best.count)) best = { score, count: k }
      }
    }
    if (best.score >= MATCH_RATIO) scored.push({ chat, ...best })
  }
  scored.sort((a, b) => b.score - a.score)
  const [top, second] = scored
  if (!top) return null
  if (second && top.score - second.score < AMBIGUOUS_GAP) {
    return { ambiguous: scored.filter(s => top.score - s.score < AMBIGUOUS_GAP).map(s => s.chat) }
  }
  return { chat: top.chat, text: after(rest, toks, top.count) }
}
