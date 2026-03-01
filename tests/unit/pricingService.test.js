/**
 * PricingService Unit Tests
 *
 * Tests for upstream billing features:
 * - 200K+ long context pricing (above_200k fields + fallback)
 * - Claude cache pricing from multipliers (write5m 1.25×, write1h 2×, read 0.1×)
 * - Fast mode pricing (6× via provider_specific_entry.fast)
 * - context-1m beta header (triggers 200K+ pricing)
 * - Feature detection helpers
 */

const pricingService = require('../../src/services/pricingService')

// Mock pricing data for Claude models
const mockClaudePricing = {
  'claude-sonnet-4-20250514': {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_creation_input_token_cost: 0.00000375,
    cache_read_input_token_cost: 0.0000003,
    cache_creation_input_token_cost_above_1hr: 0.000006,
    input_cost_per_token_above_200k_tokens: 0.000006,
    output_cost_per_token_above_200k_tokens: 0.0000225,
    cache_creation_input_token_cost_above_200k_tokens: 0.0000075,
    cache_read_input_token_cost_above_200k_tokens: 0.0000006,
    mode: 'chat',
    litellm_provider: 'anthropic'
  },
  'claude-opus-4-6': {
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000025,
    cache_creation_input_token_cost: 0.00000625,
    cache_read_input_token_cost: 0.0000005,
    cache_creation_input_token_cost_above_1hr: 0.00001,
    input_cost_per_token_above_200k_tokens: 0.00001,
    output_cost_per_token_above_200k_tokens: 0.0000375,
    cache_creation_input_token_cost_above_200k_tokens: 0.0000125,
    cache_read_input_token_cost_above_200k_tokens: 0.000001,
    mode: 'chat',
    litellm_provider: 'anthropic',
    provider_specific_entry: {
      fast: 6.0
    }
  },
  // A Claude model without above_200k or cache fields (tests fallback)
  'claude-haiku-4-5': {
    input_cost_per_token: 0.0000008,
    output_cost_per_token: 0.000004,
    mode: 'chat',
    litellm_provider: 'anthropic'
  }
}

describe('PricingService - Upstream Billing Features', () => {
  let originalPricingData
  let originalGetModelPricing

  beforeAll(() => {
    originalPricingData = pricingService.pricingData
    originalGetModelPricing = pricingService.getModelPricing.bind(pricingService)
  })

  beforeEach(() => {
    pricingService.pricingData = { ...mockClaudePricing }
  })

  afterAll(() => {
    pricingService.pricingData = originalPricingData
    pricingService.getModelPricing = originalGetModelPricing
  })

  // ========== Helper Method Tests ==========

  describe('extractBetaFeatures', () => {
    test('parses comma-separated anthropic-beta header into Set', () => {
      const features = pricingService.extractBetaFeatures({
        request_anthropic_beta: 'context-1m-2025-08-07,fast-mode-2026-02-01'
      })
      expect(features.has('context-1m-2025-08-07')).toBe(true)
      expect(features.has('fast-mode-2026-02-01')).toBe(true)
      expect(features.size).toBe(2)
    })

    test('returns empty Set when no beta header', () => {
      expect(pricingService.extractBetaFeatures({}).size).toBe(0)
      expect(pricingService.extractBetaFeatures(null).size).toBe(0)
    })

    test('trims whitespace around feature names', () => {
      const features = pricingService.extractBetaFeatures({
        request_anthropic_beta: ' context-1m-2025-08-07 , fast-mode-2026-02-01 '
      })
      expect(features.has('context-1m-2025-08-07')).toBe(true)
      expect(features.has('fast-mode-2026-02-01')).toBe(true)
    })
  })

  describe('extractSpeedSignal', () => {
    test('prefers speed over request_speed', () => {
      expect(pricingService.extractSpeedSignal({ speed: 'fast', request_speed: 'normal' })).toBe(
        'fast'
      )
    })

    test('falls back to request_speed', () => {
      expect(pricingService.extractSpeedSignal({ request_speed: 'fast' })).toBe('fast')
    })

    test('returns null when absent', () => {
      expect(pricingService.extractSpeedSignal({})).toBe(null)
    })
  })

  describe('stripLongContextSuffix', () => {
    test('removes [1m] suffix', () => {
      expect(pricingService.stripLongContextSuffix('claude-sonnet-4-20250514[1m]')).toBe(
        'claude-sonnet-4-20250514'
      )
    })

    test('returns unchanged if no suffix', () => {
      expect(pricingService.stripLongContextSuffix('claude-sonnet-4-20250514')).toBe(
        'claude-sonnet-4-20250514'
      )
    })

    test('handles null/undefined', () => {
      expect(pricingService.stripLongContextSuffix(null)).toBe(null)
      expect(pricingService.stripLongContextSuffix(undefined)).toBe(undefined)
    })
  })

  // ========== calculateCost Tests ==========

  describe('calculateCost - standard pricing', () => {
    test('calculates basic input/output cost', () => {
      const result = pricingService.calculateCost(
        { input_tokens: 1000, output_tokens: 500 },
        'claude-sonnet-4-20250514'
      )
      expect(result.hasPricing).toBe(true)
      expect(result.inputCost).toBeCloseTo(1000 * 0.000003, 10)
      expect(result.outputCost).toBeCloseTo(500 * 0.000015, 10)
      expect(result.isFastMode).toBe(false)
      expect(result.isLongContextRequest).toBe(false)
    })

    test('returns zero costs for unknown model', () => {
      const result = pricingService.calculateCost(
        { input_tokens: 1000, output_tokens: 500 },
        'unknown-model-xyz'
      )
      expect(result.hasPricing).toBe(false)
      expect(result.totalCost).toBe(0)
    })
  })

  describe('calculateCost - 200K+ pricing', () => {
    test('uses above_200k fields when [1m] model exceeds 200k tokens', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 150000,
          output_tokens: 5000,
          cache_creation_input_tokens: 60000,
          cache_read_input_tokens: 0
        },
        'claude-sonnet-4-20250514[1m]'
      )
      expect(result.isLongContextRequest).toBe(true)
      // Should use above_200k pricing
      expect(result.pricing.input).toBe(0.000006)
      expect(result.pricing.output).toBe(0.0000225)
      expect(result.inputCost).toBeCloseTo(150000 * 0.000006, 10)
      expect(result.outputCost).toBeCloseTo(5000 * 0.0000225, 10)
    })

    test('uses normal pricing when [1m] model is under 200k tokens', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 100000,
          output_tokens: 5000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        },
        'claude-sonnet-4-20250514[1m]'
      )
      expect(result.isLongContextRequest).toBe(false)
      expect(result.pricing.input).toBe(0.000003)
    })

    test('context-1m beta triggers 200K+ pricing without [1m] suffix', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 250000,
          output_tokens: 5000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          request_anthropic_beta: 'context-1m-2025-08-07'
        },
        'claude-sonnet-4-20250514'
      )
      expect(result.isLongContextRequest).toBe(true)
      expect(result.pricing.input).toBe(0.000006)
    })

    test('200K+ fallback uses 2× input for Claude models missing above_200k fields', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 250000,
          output_tokens: 5000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          request_anthropic_beta: 'context-1m-2025-08-07'
        },
        'claude-haiku-4-5'
      )
      expect(result.isLongContextRequest).toBe(true)
      // haiku-4-5 has no above_200k fields → fallback to 2× input
      expect(result.pricing.input).toBeCloseTo(0.0000008 * 2, 10)
      // output stays the same (no above_200k_tokens field, no fallback for output)
      expect(result.pricing.output).toBe(0.000004)
    })

    test('200K+ also upgrades cache pricing if above_200k cache fields exist', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 150000,
          output_tokens: 5000,
          cache_creation_input_tokens: 60000,
          cache_read_input_tokens: 10000
        },
        'claude-sonnet-4-20250514[1m]'
      )
      expect(result.isLongContextRequest).toBe(true)
      expect(result.pricing.cacheCreate).toBe(0.0000075)
      expect(result.pricing.cacheRead).toBe(0.0000006)
    })
  })

  describe('calculateCost - Claude cache multiplier derivation', () => {
    test('derives cache pricing from input × multipliers when cache fields missing', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 3000
        },
        'claude-haiku-4-5'
      )
      expect(result.hasPricing).toBe(true)
      // haiku-4-5 has no cache fields → derived from input (0.0000008)
      expect(result.pricing.cacheCreate).toBeCloseTo(0.0000008 * 1.25, 10)
      expect(result.pricing.cacheRead).toBeCloseTo(0.0000008 * 0.1, 10)
      expect(result.cacheCreateCost).toBeCloseTo(2000 * 0.0000008 * 1.25, 10)
      expect(result.cacheReadCost).toBeCloseTo(3000 * 0.0000008 * 0.1, 10)
    })

    test('uses explicit cache fields when they exist', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 3000
        },
        'claude-sonnet-4-20250514'
      )
      // sonnet has explicit cache fields
      expect(result.pricing.cacheCreate).toBe(0.00000375)
      expect(result.pricing.cacheRead).toBe(0.0000003)
    })
  })

  describe('calculateCost - fast mode', () => {
    test('applies fast mode when both beta header AND speed signal present', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 1000,
          output_tokens: 500,
          speed: 'fast',
          request_anthropic_beta: 'fast-mode-2026-02-01'
        },
        'claude-opus-4-6'
      )
      expect(result.isFastMode).toBe(true)
      // 6× multiplier from provider_specific_entry.fast
      expect(result.pricing.input).toBeCloseTo(0.000005 * 6, 10)
      expect(result.pricing.output).toBeCloseTo(0.000025 * 6, 10)
      expect(result.inputCost).toBeCloseTo(1000 * 0.000005 * 6, 10)
      expect(result.outputCost).toBeCloseTo(500 * 0.000025 * 6, 10)
    })

    test('fast mode also multiplies cache prices', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 3000,
          speed: 'fast',
          request_anthropic_beta: 'fast-mode-2026-02-01'
        },
        'claude-opus-4-6'
      )
      expect(result.isFastMode).toBe(true)
      expect(result.pricing.cacheCreate).toBeCloseTo(0.00000625 * 6, 10)
      expect(result.pricing.cacheRead).toBeCloseTo(0.0000005 * 6, 10)
    })

    test('does NOT activate with only beta header (no speed signal)', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 1000,
          output_tokens: 500,
          request_anthropic_beta: 'fast-mode-2026-02-01'
        },
        'claude-opus-4-6'
      )
      expect(result.isFastMode).toBe(false)
      expect(result.pricing.input).toBe(0.000005)
    })

    test('does NOT activate with only speed signal (no beta header)', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 1000,
          output_tokens: 500,
          speed: 'fast'
        },
        'claude-opus-4-6'
      )
      expect(result.isFastMode).toBe(false)
      expect(result.pricing.input).toBe(0.000005)
    })

    test('does NOT activate for models without provider_specific_entry.fast', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 1000,
          output_tokens: 500,
          speed: 'fast',
          request_anthropic_beta: 'fast-mode-2026-02-01'
        },
        'claude-sonnet-4-20250514'
      )
      // sonnet has no provider_specific_entry.fast → no multiplier
      expect(result.isFastMode).toBe(false)
      expect(result.pricing.input).toBe(0.000003)
    })

    test('fast mode via request_speed field (with beta header)', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 1000,
          output_tokens: 500,
          request_speed: 'fast',
          request_anthropic_beta: 'fast-mode-2026-02-01'
        },
        'claude-opus-4-6'
      )
      expect(result.isFastMode).toBe(true)
      expect(result.pricing.input).toBeCloseTo(0.000005 * 6, 10)
    })
  })

  describe('calculateCost - cache_creation detail object', () => {
    test('handles ephemeral_5m and ephemeral_1h breakdown', () => {
      const result = pricingService.calculateCost(
        {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 3000,
            ephemeral_1h_input_tokens: 2000
          }
        },
        'claude-sonnet-4-20250514'
      )
      const cacheWritePrice = 0.00000375
      expect(result.ephemeral5mCost).toBeCloseTo(3000 * cacheWritePrice, 10)
      expect(result.ephemeral1hCost).toBeCloseTo(2000 * cacheWritePrice, 10)
      expect(result.cacheCreateCost).toBeCloseTo(5000 * cacheWritePrice, 10)
    })
  })

  describe('calculateCost - media fields preserved', () => {
    test('returns zero media costs for non-media models', () => {
      const result = pricingService.calculateCost(
        { input_tokens: 1000, output_tokens: 500 },
        'claude-sonnet-4-20250514'
      )
      expect(result.imageInputCost).toBe(0)
      expect(result.imageOutputCost).toBe(0)
      expect(result.imageTotalCost).toBe(0)
      expect(result.videoOutputCost).toBe(0)
      expect(result.mediaTotalCost).toBe(0)
      expect(result.isImageModel).toBe(false)
      expect(result.isVideoModel).toBe(false)
      expect(result.isMediaModel).toBe(false)
    })
  })

  describe('getEphemeral1hPricing - with pricing parameter', () => {
    test('uses pricing.cache_creation_input_token_cost_above_1hr when provided', () => {
      const result = pricingService.getEphemeral1hPricing('claude-sonnet-4-20250514', {
        cache_creation_input_token_cost_above_1hr: 0.00042
      })
      expect(result).toBe(0.00042)
    })

    test('falls back to ephemeral1hPricing map when pricing param has no field', () => {
      pricingService.buildEphemeral1hPricing()
      const result = pricingService.getEphemeral1hPricing('claude-sonnet-4-20250514', {})
      expect(result).toBe(
        mockClaudePricing['claude-sonnet-4-20250514'].cache_creation_input_token_cost_above_1hr
      )
    })
  })
})
