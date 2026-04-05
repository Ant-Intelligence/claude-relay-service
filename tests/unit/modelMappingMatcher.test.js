const {
  findMatchingModelEntry,
  resolveMappedModel
} = require('../../src/utils/modelMappingMatcher')

describe('modelMappingMatcher', () => {
  test('matches exact mappings before wildcard mappings', () => {
    const mapping = {
      'gpt-*': 'gpt-*',
      'gpt-4o': 'gpt-4o-mini'
    }

    expect(findMatchingModelEntry(mapping, 'gpt-4o')).toEqual({
      key: 'gpt-4o',
      value: 'gpt-4o-mini',
      matchType: 'exact'
    })
    expect(resolveMappedModel(mapping, 'gpt-4o')).toBe('gpt-4o-mini')
  })

  test('treats self-mapped wildcard entries as whitelist pass-through rules', () => {
    const mapping = {
      'gpt-*': 'gpt-*'
    }

    expect(findMatchingModelEntry(mapping, 'gpt-5.4')).toEqual({
      key: 'gpt-*',
      value: 'gpt-*',
      prefix: 'gpt-',
      matchType: 'prefix'
    })
    expect(resolveMappedModel(mapping, 'gpt-5.4')).toBe('gpt-5.4')
    expect(resolveMappedModel(mapping, 'gpt-4o-mini')).toBe('gpt-4o-mini')
  })

  test('supports wildcard prefix remapping', () => {
    const mapping = {
      'gpt-*': 'claude-sonnet-4-5-20250929'
    }

    expect(resolveMappedModel(mapping, 'gpt-4.1')).toBe('claude-sonnet-4-5-20250929')
  })

  test('matches wildcard prefixes case-insensitively', () => {
    const mapping = {
      'GPT-*': 'GPT-*'
    }

    expect(resolveMappedModel(mapping, 'gpt-5')).toBe('gpt-5')
    expect(resolveMappedModel(mapping, 'GPT-4O')).toBe('GPT-4O')
  })

  test('prefers the longest wildcard prefix when multiple rules match', () => {
    const mapping = {
      'gpt-*': 'gpt-*',
      'gpt-4*': 'gpt-4o-mini'
    }

    expect(findMatchingModelEntry(mapping, 'gpt-4.1')).toEqual({
      key: 'gpt-4*',
      value: 'gpt-4o-mini',
      prefix: 'gpt-4',
      matchType: 'prefix'
    })
    expect(resolveMappedModel(mapping, 'gpt-4.1')).toBe('gpt-4o-mini')
    expect(resolveMappedModel(mapping, 'gpt-5')).toBe('gpt-5')
  })

  test('returns original model when no rule matches', () => {
    const mapping = {
      'claude-*': 'claude-*'
    }

    expect(findMatchingModelEntry(mapping, 'gpt-5')).toBeNull()
    expect(resolveMappedModel(mapping, 'gpt-5')).toBe('gpt-5')
  })
})
