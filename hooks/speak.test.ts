import { expect, test } from 'claude-code/testing'

import { cleanForSpeech, findSpeakBlock, speakLang, speakSection } from './speak'

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
