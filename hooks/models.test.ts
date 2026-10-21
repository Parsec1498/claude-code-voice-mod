import { expect, test } from 'claude-code/testing'

import { DEFAULT_MODEL, MODELS, isUnsuitable, modelOptions } from './models'

const none = new Set<string>()

test('для української — лише багатомовні, рекомендовані large-v3 і small', () => {
  const uk = modelOptions('big', 'uk', 'cuda', none)
  expect(uk.some(o => /\.en$|^distil/.test(o.value))).toBe(false)
  expect(uk.find(o => o.recommended)?.value).toBe('large-v3')
  expect(modelOptions('wake', 'uk', 'cuda', none).find(o => o.recommended)?.value).toBe('small')
})

test('для англійської рекомендовані — першими, англомовні', () => {
  const en = modelOptions('big', 'en', 'cuda', none)
  expect(en[0]?.recommended).toBe(true)
  expect(en.find(o => o.recommended)?.value).toMatch(/\.en$|^distil/)
  expect(modelOptions('wake', 'en', 'cuda', none).find(o => o.recommended)?.value).toBe('small.en')
  expect(en.find(o => o.recommended)?.value).toBe('distil-large-v3')
})

test('у межах нерекомендованих — від легшої до важчої', () => {
  const uk = modelOptions('big', 'uk', 'cuda', none)
  const rest = uk.filter(o => !o.recommended).map(o => MODELS.find(m => m.name === o.value)!.vramMb)
  expect([...rest].sort((a, b) => a - b)).toEqual(rest)
  const cpu = modelOptions('big', 'uk', 'cpu', none)
  const ram = cpu.filter(o => !o.recommended).map(o => MODELS.find(m => m.name === o.value)!.ramMb)
  expect([...ram].sort((a, b) => a - b)).toEqual(ram)
})

test('слоти: мала — tiny/base/small, велика — від small і вище', () => {
  const wake = modelOptions('wake', 'uk', 'cuda', none).map(o => o.value)
  for (const n of ['tiny', 'base', 'small']) expect(wake.includes(n)).toBe(true)
  expect(wake.includes('large-v3')).toBe(false)
  const big = modelOptions('big', 'en', 'cuda', none).map(o => o.value)
  for (const n of ['small.en', 'medium.en', 'distil-large-v3', 'large-v3-turbo', 'large-v3']) expect(big.includes(n)).toBe(true)
  expect(big.includes('tiny.en')).toBe(false)
})

test('мітка: ⬇ лише для відсутніх на диску, пам’ять — відео або ОЗП', () => {
  expect(modelOptions('big', 'uk', 'cuda', new Set(['large-v3'])).find(o => o.value === 'large-v3')?.label).not.toMatch(/⬇/)
  expect(modelOptions('big', 'uk', 'cuda', none).find(o => o.value === 'medium')?.label).toMatch(/⬇/)
  expect(modelOptions('big', 'uk', 'cpu', none).find(o => o.value === 'medium')?.label).toMatch(/RAM|ОЗП/)
  expect(modelOptions('big', 'uk', 'cuda', none).find(o => o.value === 'medium')?.label).toMatch(/відеопам/)
})

test('типові моделі — у каталозі й відповідають слотам', () => {
  for (const dev of ['cuda', 'cpu'] as const)
    for (const slot of ['wake', 'big'] as const) {
      const m = MODELS.find(x => x.name === DEFAULT_MODEL[dev][slot])
      expect(m?.slots.includes(slot)).toBe(true)
    }
  expect(DEFAULT_MODEL.cuda).toEqual({ wake: 'small', big: 'large-v3' })
  expect(DEFAULT_MODEL.cpu).toEqual({ wake: 'base', big: 'large-v3-turbo' })
})

test('мітки мовою інтерфейсу: англійською — VRAM/RAM, GB/MB, recommended', () => {
  const big = modelOptions('big', 'en', 'cuda', none)
  expect(big[0]?.label).toMatch(/^★ recommended · distil-large-v3 · ★+ · ~[\d.]+ GB VRAM · ⬇ [\d.]+ GB$/)
  expect(modelOptions('wake', 'en', 'cpu', none).find(o => o.value === 'tiny')?.label).toMatch(/RAM · ⬇ \d+ MB$/)
  expect(big.some(o => /[А-Яа-я]/.test(o.label))).toBe(false)
})

test('isUnsuitable: англійські моделі непридатні лише для української', () => {
  for (const m of ['small.en', 'medium.en', 'distil-large-v3']) {
    expect(isUnsuitable(m, 'uk')).toBe(true)
    expect(isUnsuitable(m, 'en')).toBe(false)
  }
  for (const m of ['small', 'large-v3', 'large-v3-turbo', '']) expect(isUnsuitable(m, 'uk')).toBe(false)
})
