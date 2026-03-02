/**
 * buildEphemeral1hPricing Unit Tests
 *
 * Tests for dynamic ephemeral 1h pricing map construction from model_pricing.json data
 */

const pricingService = require('../../src/services/pricingService')

describe('buildEphemeral1hPricing', () => {
  let originalPricingData

  beforeEach(() => {
    originalPricingData = pricingService.pricingData
  })

  afterEach(() => {
    pricingService.pricingData = originalPricingData
    pricingService.ephemeral1hPricing = {}
  })

  test('extracts claude models with cache_creation_input_token_cost_above_1hr', () => {
    pricingService.pricingData = {
      'claude-opus-4-6': {
        input_cost_per_token: 0.000005,
        cache_creation_input_token_cost_above_1hr: 0.00001
      },
      'claude-sonnet-4': {
        input_cost_per_token: 0.000003,
        cache_creation_input_token_cost_above_1hr: 0.000006
      }
    }

    pricingService.buildEphemeral1hPricing()

    expect(pricingService.ephemeral1hPricing['claude-opus-4-6']).toBe(0.00001)
    expect(pricingService.ephemeral1hPricing['claude-sonnet-4']).toBe(0.000006)
    expect(Object.keys(pricingService.ephemeral1hPricing)).toHaveLength(2)
  })

  test('ignores models without cache_creation_input_token_cost_above_1hr', () => {
    pricingService.pricingData = {
      'claude-opus-4-6': {
        input_cost_per_token: 0.000005,
        cache_creation_input_token_cost_above_1hr: 0.00001
      },
      'claude-haiku-3': {
        input_cost_per_token: 0.0000001
        // no cache_creation_input_token_cost_above_1hr
      }
    }

    pricingService.buildEphemeral1hPricing()

    expect(pricingService.ephemeral1hPricing['claude-opus-4-6']).toBe(0.00001)
    expect(pricingService.ephemeral1hPricing['claude-haiku-3']).toBeUndefined()
    expect(Object.keys(pricingService.ephemeral1hPricing)).toHaveLength(1)
  })

  test('ignores non-claude models (gpt, gemini, etc)', () => {
    pricingService.pricingData = {
      'claude-opus-4-6': {
        cache_creation_input_token_cost_above_1hr: 0.00001
      },
      'gpt-4o': {
        cache_creation_input_token_cost_above_1hr: 0.0000025
      },
      'gemini-2.5-pro': {
        cache_creation_input_token_cost_above_1hr: 0.000003
      }
    }

    pricingService.buildEphemeral1hPricing()

    expect(pricingService.ephemeral1hPricing['claude-opus-4-6']).toBe(0.00001)
    expect(pricingService.ephemeral1hPricing['gpt-4o']).toBeUndefined()
    expect(pricingService.ephemeral1hPricing['gemini-2.5-pro']).toBeUndefined()
    expect(Object.keys(pricingService.ephemeral1hPricing)).toHaveLength(1)
  })

  test('ignores channel/provider prefixed models (with / or .)', () => {
    pricingService.pricingData = {
      'claude-opus-4-6': {
        cache_creation_input_token_cost_above_1hr: 0.00001
      },
      'anthropic.claude-opus-4-6': {
        cache_creation_input_token_cost_above_1hr: 0.00001
      },
      'azure_ai/claude-sonnet-4': {
        cache_creation_input_token_cost_above_1hr: 0.000006
      },
      'vertex_ai/claude-sonnet-4': {
        cache_creation_input_token_cost_above_1hr: 0.000006
      }
    }

    pricingService.buildEphemeral1hPricing()

    expect(pricingService.ephemeral1hPricing['claude-opus-4-6']).toBe(0.00001)
    expect(pricingService.ephemeral1hPricing['anthropic.claude-opus-4-6']).toBeUndefined()
    expect(pricingService.ephemeral1hPricing['azure_ai/claude-sonnet-4']).toBeUndefined()
    expect(pricingService.ephemeral1hPricing['vertex_ai/claude-sonnet-4']).toBeUndefined()
    expect(Object.keys(pricingService.ephemeral1hPricing)).toHaveLength(2)
  })

  test('does nothing when pricingData is null', () => {
    pricingService.pricingData = null
    pricingService.ephemeral1hPricing = { existing: 0.001 }

    pricingService.buildEphemeral1hPricing()

    // Should not overwrite existing map
    expect(pricingService.ephemeral1hPricing).toEqual({ existing: 0.001 })
  })

  test('produces empty map when no models have 1h pricing', () => {
    pricingService.pricingData = {
      'claude-opus-4-6': {
        input_cost_per_token: 0.000005
      },
      'claude-sonnet-4': {
        input_cost_per_token: 0.000003
      }
    }

    pricingService.buildEphemeral1hPricing()

    expect(Object.keys(pricingService.ephemeral1hPricing)).toHaveLength(0)
  })

  test('works with real model_pricing.json data', () => {
    const fs = require('fs')
    const path = require('path')
    const pricingFile = path.join(process.cwd(), 'data', 'model_pricing.json')

    if (!fs.existsSync(pricingFile)) {
      // Skip if no local pricing data
      return
    }

    pricingService.pricingData = JSON.parse(fs.readFileSync(pricingFile, 'utf8'))
    pricingService.buildEphemeral1hPricing()

    const map = pricingService.ephemeral1hPricing

    // Should have some models
    expect(Object.keys(map).length).toBeGreaterThan(0)

    // All keys should start with claude-
    for (const key of Object.keys(map)) {
      expect(key).toMatch(/^claude-/)
      expect(key).not.toContain('/')
      expect(key).not.toContain('.')
    }

    // All values should be positive numbers
    for (const value of Object.values(map)) {
      expect(typeof value).toBe('number')
      expect(value).toBeGreaterThan(0)
    }

    // Specific model checks (if present)
    if (map['claude-opus-4-6']) {
      expect(map['claude-opus-4-6']).toBe(0.00001) // $10/MTok
    }
    if (map['claude-opus-4-1']) {
      expect(map['claude-opus-4-1']).toBe(0.00003) // $30/MTok
    }
    if (map['claude-sonnet-4']) {
      expect(map['claude-sonnet-4']).toBe(0.000006) // $6/MTok
    }
  })
})
