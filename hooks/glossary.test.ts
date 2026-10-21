import { expect, test } from 'claude-code/testing'

import {
  checkRule,
  generatorPrompt,
  glossaryStats,
  isGeneratorReply,
  knownHeard,
  mergeHotwords,
  parseGenerated,
} from './glossary'

test('словник: правила, коментарі й биті рядки — як їх читає слухач', () => {
  const text = [
    '# коментар',
    'логін | лоґін => Login',
    '',
    'бута => бота  # хвіст-коментар',
    'без стрілки',
    ' => нічого',
    'щось =>',
    'клод код | клауд код => Claude Code',
  ].join('\n')
  expect(glossaryStats(text)).toEqual({ rules: 3, bad: [5, 6, 7] })
  expect(glossaryStats('')).toEqual({ rules: 0, bad: [] })
  expect(glossaryStats('# лише коментар\r\nа => б\r\n')).toEqual({ rules: 1, bad: [] })
})

test('правило від агента: перевірка і причина відмови', () => {
  expect(checkRule([' Логін ', 'лоґін', 'логін'], ' Login ')).toEqual({ heard: ['логін', 'лоґін'], write: 'Login' })
  expect(checkRule('майап', 'MyApp')).toEqual({ heard: ['майап'], write: 'MyApp' })
  expect(typeof checkRule(['бо'], 'бот')).toBe('string') // коротке — псувало б звичайну мову
  expect(typeof checkRule(['login'], 'Login')).toBe('string') // те саме, що write
  expect(typeof checkRule(['а => б'], 'x')).toBe('string')
  expect(typeof checkRule(['логін'], 'Lo|gin')).toBe('string')
  expect(typeof checkRule([], 'Login')).toBe('string')
  expect(typeof checkRule(['логін'], '')).toBe('string')
})

test('словник: відомі варіанти, злиття слів-підказок', () => {
  expect([...knownHeard('# x\nЛогін | лоґін => Login\nбите\n')]).toEqual(['логін', 'лоґін'])
  expect(mergeHotwords('Login, MyApp', ['myapp', 'Bitrix', ' ', 'a,b'])).toEqual({ text: 'Login, MyApp, Bitrix', added: 1 })
  expect(mergeHotwords('', ['Login'])).toEqual({ text: 'Login', added: 1 })
})

test('генератор: відповідь → нові правила без повторів, промпт із контекстом', () => {
  const reply = 'Ось:\n```json\n{"hotwords": ["MyApp", 5], "rules": [' +
    '{"heard": ["логін", "лоґін"], "write": "Login"}, {"heard": ["май ап"], "write": "MyApp"}, {"heard": ["бо"], "write": "бот"}]}\n```'
  expect(parseGenerated(reply, 'логін => Login\n')).toEqual({
    rules: [{ heard: ['лоґін'], write: 'Login' }, { heard: ['май ап'], write: 'MyApp' }],
    hotwords: ['MyApp'],
  })
  expect(parseGenerated('без JSON', '')).toBeNull()
  expect(isGeneratorReply(reply)).toBe(true)
  expect(isGeneratorReply('Готово. {"files": 3}')).toBe(false)
  expect(isGeneratorReply('Готово.')).toBe(false)
  const prompt = generatorPrompt({
    lang: 'uk', root: 'D:\\Dev\\app', glossary: '', hotwords: 'Login',
    heard: ['запусти логін'], messages: ['онови бота'], chats: ['Запуск бота'],
  })
  for (const part of ['D:\\Dev\\app', 'Ukrainian', 'запусти логін', 'онови бота', 'Запуск бота', '"rules"']) {
    expect(prompt.includes(part)).toBe(true)
  }
})
