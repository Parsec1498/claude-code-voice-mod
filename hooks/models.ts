// Каталог моделей розпізнавання: якість, пам'ять, слоти. Чистий модуль (без `$`) —
// його імпортує register.tsx для списків вибору в ⚙.

import { STR } from './i18n'

export type Lang = 'uk' | 'en'
export type Slot = 'wake' | 'big'
export type ModelInfo = {
  name: string // назва faster-whisper
  langs: 'multi' | 'en'
  slots: readonly Slot[]
  stars: { uk: number | null; en: number } // 1–5, null — мова не підтримується
  vramMb: number // виміряно, CUDA int8_float16
  ramMb: number // виміряно, CPU int8
  diskMb: number
}

const WAKE = ['wake'] as const
const BOTH = ['wake', 'big'] as const
const BIG = ['big'] as const

// vramMb/ramMb/diskMb — dev/measure_models.py на машині власника (RTX, 8 ГБ):
// різниця nvidia-smi / робочого набору до і після завантаження + 1 с тиші. vramMb
// включає контекст CUDA (~150 МБ), тож у парі мала+велика сума трохи завищена.
// stars — ОРІЄНТОВНІ, з опублікованих WER (стаття Whisper, картки faster-whisper і
// distil-whisper); uk: large-v3 = 5, turbo нижче (зациклення на підказці, CLAUDE.md).
export const MODELS: readonly ModelInfo[] = [
  { name: 'tiny', langs: 'multi', slots: WAKE, stars: { uk: 1, en: 1 }, vramMb: 207, ramMb: 142, diskMb: 75 },
  { name: 'tiny.en', langs: 'en', slots: WAKE, stars: { uk: null, en: 2 }, vramMb: 207, ramMb: 146, diskMb: 74 },
  { name: 'base', langs: 'multi', slots: WAKE, stars: { uk: 2, en: 2 }, vramMb: 271, ramMb: 184, diskMb: 141 },
  { name: 'base.en', langs: 'en', slots: WAKE, stars: { uk: null, en: 3 }, vramMb: 271, ramMb: 183, diskMb: 141 },
  { name: 'small', langs: 'multi', slots: BOTH, stars: { uk: 3, en: 3 }, vramMb: 495, ramMb: 380, diskMb: 464 },
  { name: 'small.en', langs: 'en', slots: BOTH, stars: { uk: null, en: 4 }, vramMb: 495, ramMb: 381, diskMb: 464 },
  { name: 'medium', langs: 'multi', slots: BIG, stars: { uk: 4, en: 4 }, vramMb: 1167, ramMb: 884, diskMb: 1460 },
  { name: 'medium.en', langs: 'en', slots: BIG, stars: { uk: null, en: 4 }, vramMb: 1167, ramMb: 881, diskMb: 1460 },
  { name: 'large-v3-turbo', langs: 'multi', slots: BIG, stars: { uk: 4, en: 5 }, vramMb: 1231, ramMb: 960, diskMb: 1547 },
  { name: 'distil-large-v3', langs: 'en', slots: BIG, stars: { uk: null, en: 5 }, vramMb: 1167, ramMb: 908, diskMb: 1446 },
  { name: 'large-v3', langs: 'multi', slots: BIG, stars: { uk: 5, en: 5 }, vramMb: 2095, ramMb: 1676, diskMb: 2948 },
]

// Збігається з типовими у слухачі (default_models).
export const DEFAULT_MODEL: Record<'cuda' | 'cpu', Record<Slot, string>> = {
  cuda: { wake: 'small', big: 'large-v3' },
  cpu: { wake: 'base', big: 'large-v3-turbo' },
}

const RECOMMENDED: Record<Lang, Record<Slot, string>> = {
  uk: { wake: 'small', big: 'large-v3' },
  en: { wake: 'small.en', big: 'distil-large-v3' },
}

function gb(mb: number): string {
  return (mb / 1024).toFixed(1)
}

function diskLabel(mb: number, lang: Lang): string {
  const t = STR[lang]
  return mb >= 1000 ? `${gb(mb)} ${t.unitGb}` : `${mb} ${t.unitMb}`
}

// Рекомендовані — першими, решта — від легшої до важчої (за пам'яттю на цьому пристрої).
export function modelOptions(
  slot: Slot,
  lang: Lang,
  device: 'cuda' | 'cpu',
  installed: ReadonlySet<string>,
): { value: string; label: string; recommended: boolean }[] {
  const t = STR[lang]
  const mem = (m: ModelInfo) => (device === 'cuda' ? m.vramMb : m.ramMb)
  const rows = MODELS.filter(m => m.slots.includes(slot) && m.stars[lang] !== null)
    .map(m => {
      const recommended = m.name === RECOMMENDED[lang][slot]
      const stars = '★'.repeat(m.stars[lang] ?? 0)
      const where = device === 'cuda' ? t.modelVram : t.modelRam
      const label =
        `${recommended ? t.modelRecommended : ''}${m.name} · ${stars} · ~${gb(mem(m))} ${t.unitGb} ${where}` +
        (installed.has(m.name) ? '' : ` · ⬇ ${diskLabel(m.diskMb, lang)}`)
      return { m, option: { value: m.name, label, recommended } }
    })
    .sort((a, b) => Number(b.option.recommended) - Number(a.option.recommended) || mem(a.m) - mem(b.m))
  return rows.map(r => r.option)
}

/** Англійські моделі (`*.en`, `distil-*`) не розуміють української — слухач бере типову. */
export function isUnsuitable(name: string, lang: Lang): boolean {
  return lang === 'uk' && (name.endsWith('.en') || name.startsWith('distil-'))
}
