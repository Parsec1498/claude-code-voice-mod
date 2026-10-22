import { expect, test } from 'claude-code/testing'

import { DEFAULT_VOICE, VOICES, cleanForSpeech, findSpeakBlock, speakLang, speakSection, voiceOf, voiceOptions } from './speak'
import type { VoiceSettings } from '../types'

test('блок — останній рядок з маркером, до кінця відповіді', () => {
  expect(findSpeakBlock('Звіт.\n\n🔊 Озвучити: Готово, тести зелені.')).toBe('Готово, тести зелені.')
  expect(findSpeakBlock('a\n🔊 Озвучити: перше\nb\n**🔊 Озвучити:** друге\nще речення')).toBe('друге\nще речення')
  expect(findSpeakBlock('Озвучити: без емодзі')).toBe('без емодзі')
  expect(findSpeakBlock('🔊 Speak: Done.')).toBe('Done.')
  expect(findSpeakBlock('Звіт без блоку')).toBeNull()
  expect(findSpeakBlock('пишіть «🔊 Озвучити:» у кінці')).toBeNull() // маркер не на початку рядка
  expect(findSpeakBlock('```\n🔊 Озвучити: у коді\n```\nкінець')).toBeNull()
})

test('маркер: регістр слова, порожній рядок маркера, порожній блок', () => {
  expect(findSpeakBlock('🔊 озвучити: тихо')).toBe('тихо')
  expect(findSpeakBlock('🔊 SPEAK: Loud.')).toBe('Loud.')
  expect(findSpeakBlock('Звіт.\n🔊 Озвучити:\nПерший рядок.\nДругий.\n')).toBe('Перший рядок.\nДругий.')
  expect(findSpeakBlock('Звіт.\n🔊 Озвучити:')).toBeNull()
  // маркер у коді не рахується, але справжній після коду — так
  expect(findSpeakBlock('```\n🔊 Озвучити: код\n```\n🔊 Озвучити: справжній')).toBe('справжній')
})

test('чистка: markdown, URL, емодзі, пробіли, межа речення', () => {
  expect(cleanForSpeech('**Готово** — `npm test` [звіт](https://x.y/z) ✅')).toBe('Готово — npm test звіт')
  const long = 'Перше речення. '.repeat(60)
  const out = cleanForSpeech(long)
  expect(out.length).toBeLessThanOrEqual(600)
  expect(out.endsWith('.')).toBe(true)
})

test('чистка: голий URL, заголовки, переноси, короткий текст без змін', () => {
  expect(cleanForSpeech('# Заголовок\nДив. https://example.com/a?b=1 далі')).toBe('Заголовок Див. далі')
  expect(cleanForSpeech('Рядок   один\n\nрядок\tдва')).toBe('Рядок один рядок два')
  expect(cleanForSpeech('Один. Два.', 600)).toBe('Один. Два.')
  expect(cleanForSpeech('Слово слово слово слово', 12)).toBe('Слово слово')
})

test('мова блоку за алфавітом', () => {
  expect(speakLang('Готово, PR відкрито')).toBe('uk')
  expect(speakLang('Done, the PR is open')).toBe('en')
})

test('інструкція містить маркер своєї мови', () => {
  expect(speakSection('uk')).toContain('🔊 Озвучити:')
  expect(speakSection('en')).toContain('🔊 Speak:')
})

test('каталог: лише вільні ліцензії, обидві мови, типові в каталозі', () => {
  expect(VOICES.some(v => /lessac|ryan|hfc_|l2arctic|semaine/.test(v.name))).toBe(false)
  // донавчені з lessac/ryan — виключені (успадковують обмежену ліцензію)
  expect(VOICES.some(v => /joe|mike|kathleen|reza_ibrahim|sam|libritts_r|alba|aru|vctk/.test(v.name))).toBe(false)
  expect(VOICES.every(v => !/CC BY/.test(v.license))).toBe(true)
  expect(VOICES.filter(v => v.lang === 'uk').length).toBe(5)
  expect(VOICES.filter(v => v.lang === 'en').map(v => v.name).sort()).toEqual([
    'en_GB-cori-medium',
    'en_US-bryce-medium',
    'en_US-john-medium',
    'en_US-kristin-medium',
    'en_US-ljspeech-medium',
    'en_US-norman-medium',
  ])
  expect(DEFAULT_VOICE.en).toBe('en_US-ljspeech-medium')
  expect(VOICES.find(v => v.name === DEFAULT_VOICE.uk)?.lang).toBe('uk')
  expect(VOICES.find(v => v.name === DEFAULT_VOICE.en)?.lang).toBe('en')
  expect(new Set(VOICES.map(v => v.name)).size).toBe(VOICES.length)
  expect(VOICES.every(v => v.mb > 0 && v.license !== '')).toBe(true)
})

test('варіанти голосів: ⬇ лише в неустановлених', () => {
  const opts = voiceOptions('uk', new Set([DEFAULT_VOICE.uk]), 'МБ')
  expect(opts.find(o => o.value === DEFAULT_VOICE.uk)?.label).not.toContain('⬇')
  expect(opts.filter(o => o.label.includes('⬇')).length).toBe(4)
  expect(opts.every(o => VOICES.find(v => v.name === o.value)?.lang === 'uk')).toBe(true)
  expect(opts.find(o => o.value === 'uk_UA-lada-x_low')?.label).toBe('uk_UA-lada-x_low · Apache-2.0 ⬇ 21 МБ')
  expect(voiceOptions('uk', new Set(), 'MB')[0]?.label).toContain('⬇ 21 MB')
})

test('голос: вибраний або типовий для мови', () => {
  const set = { speakVoiceUk: '', speakVoiceEn: 'en_GB-cori-medium' } as VoiceSettings
  expect(voiceOf(set, 'uk')).toBe(DEFAULT_VOICE.uk)
  expect(voiceOf(set, 'en')).toBe('en_GB-cori-medium')
})
