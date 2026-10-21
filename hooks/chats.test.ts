import { expect, test } from 'claude-code/testing'

import { chatPhraseRest, matchChat, parseListing, similar, words } from './chats'

const LISTING = `This session is Привязка до чату та вибір призначення [e4001a] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).

Peer sessions (4):
  Тест [222471]  ·  interactive  ·  idle  ·  Claude Desktop session  ·  started 12h ago
  Запуск бота [b48a00]  ·  interactive  ·  idle  ·  Claude Desktop session  ·  started 12h ago
  Єжі твінів пресети [10ccdd]  ·  interactive  ·  idle  ·  Claude Desktop session  ·  started 12h ago
  Перевірка статусу [4c7133]  ·  interactive  ·  idle  ·  Claude Desktop session  ·  started 12h ago`

const CHATS = [
  { id: 'S', title: 'Привязка до чату та вибір призначення' },
  { id: 'T', title: 'Тест' },
  { id: 'B', title: 'Запуск бота' },
  { id: 'P', title: 'Перевірка статусу' },
]

test('words / similar: без регістру, розділових знаків і апострофів', () => {
  expect(words("Прив'язка, до ЧАТУ!")).toEqual(['привязка', 'до', 'чату'])
  expect(similar('чату', 'чат')).toBe(0.75)
  expect(similar('бота', 'бота')).toBe(1)
})

test('фраза зміни чату — лише на початку команди, з неточним записом', () => {
  expect(chatPhraseRest('Зміна чату, запуск бота. Перезапусти сервер.', 'Зміна чату')).toBe(
    'запуск бота. Перезапусти сервер.',
  )
  expect(chatPhraseRest('зміни чат Тест', 'Зміна чату')).toBe('Тест')
  expect(chatPhraseRest('перезапусти сервер і зміна чату тест', 'Зміна чату')).toBeNull()
  expect(chatPhraseRest('зміст чату тест', 'Зміна чату')).toBeNull() // інше слово
  expect(chatPhraseRest('зміна', 'Зміна чату')).toBeNull()
  expect(chatPhraseRest('перейди в тест', 'Зміна чату, перейди в')).toBe('тест') // свої варіанти через кому
})

test('ListAgents: свій чат і інші з ref', () => {
  const l = parseListing(LISTING)
  expect(l.self).toEqual({ title: 'Привязка до чату та вибір призначення', ref: 'e4001a' })
  expect(l.peers.map(p => p.ref)).toEqual(['222471', 'b48a00', '10ccdd', '4c7133'])
  expect(l.peers[1]?.title).toBe('Запуск бота')
})

test('ListAgents: дужки в самій назві не плутають ref', () => {
  const l = parseListing('This session is Fix [wip] parser [e4001a] — the name.\n\nPeer sessions (1):\n  Bot [v2] [b48a00]  ·  idle')
  expect(l.self).toEqual({ title: 'Fix [wip] parser', ref: 'e4001a' })
  expect(l.peers).toEqual([{ title: 'Bot [v2]', ref: 'b48a00' }])
})

test('назва чату: повна, з командою після неї, початок довгої', () => {
  expect(matchChat('Запуск бота, перезапусти сервер.', CHATS)).toEqual({
    chat: CHATS[2],
    text: 'перезапусти сервер.',
  })
  expect(matchChat('запуск бота', CHATS)).toEqual({ chat: CHATS[2], text: '' })
  expect(matchChat('Прив’язка до чату, глянь тести', CHATS)).toEqual({ chat: CHATS[0], text: 'глянь тести' })
  expect(matchChat('перевірка статусу онови', CHATS)).toEqual({ chat: CHATS[3], text: 'онови' })
  expect(matchChat('запуск ботa', CHATS)).toEqual({ chat: CHATS[2], text: '' }) // латинська «a» — неточний запис
})

test('назва чату: не знайдено чи двозначно — нікуди не відправляємо', () => {
  expect(matchChat('погода в києві', CHATS)).toBeNull()
  expect(matchChat('', CHATS)).toBeNull()
  const twins = [
    { id: 'A', title: 'Тест бота' },
    { id: 'B', title: 'Тест бота' },
  ]
  expect(matchChat('тест бота зроби', twins)).toEqual({ ambiguous: twins })
})
