const redis = require('../models/redis')
const logger = require('../utils/logger')

const SUPPORTED_SERVICES = ['claude', 'codex', 'gemini', 'droid', 'bedrock', 'azure', 'ccr']
const DEFAULT_BASE_SERVICE = 'claude'
const CACHE_TTL_MS = 60 * 1000

const SERVICE_DISPLAY = {
  claude: { name: 'Claude', icon: 'fa-robot', gradient: 'from-orange-400 to-orange-600' },
  codex: { name: 'Codex (OpenAI)', icon: 'fa-brain', gradient: 'from-emerald-400 to-emerald-600' },
  gemini: { name: 'Gemini', icon: 'fa-gem', gradient: 'from-blue-400 to-blue-600' },
  droid: { name: 'Droid', icon: 'fa-android', gradient: 'from-purple-400 to-purple-600' },
  bedrock: { name: 'AWS Bedrock', icon: 'fa-aws', gradient: 'from-amber-400 to-amber-600' },
  azure: { name: 'Azure OpenAI', icon: 'fa-microsoft', gradient: 'from-cyan-400 to-cyan-600' },
  ccr: { name: 'CCR', icon: 'fa-server', gradient: 'from-slate-400 to-slate-600' }
}

let cache = null

function buildDefaultRates() {
  const rates = {}
  for (const service of SUPPORTED_SERVICES) {
    rates[service] = 1.0
  }
  return rates
}

function buildDefaultConfig() {
  return {
    rates: buildDefaultRates(),
    baseService: DEFAULT_BASE_SERVICE,
    updatedAt: null,
    updatedBy: null
  }
}

function isValidRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function mergeWithDefaults(stored) {
  const config = buildDefaultConfig()
  if (!stored || typeof stored !== 'object') {
    return config
  }
  if (stored.rates && typeof stored.rates === 'object') {
    for (const [service, value] of Object.entries(stored.rates)) {
      if (isValidRate(value)) {
        config.rates[service] = value
      }
    }
  }
  if (typeof stored.baseService === 'string' && SUPPORTED_SERVICES.includes(stored.baseService)) {
    config.baseService = stored.baseService
  }
  if (stored.updatedAt) {
    config.updatedAt = stored.updatedAt
  }
  if (stored.updatedBy) {
    config.updatedBy = stored.updatedBy
  }
  return config
}

function invalidateCache() {
  cache = null
}

async function loadConfigFromRedis() {
  const stored = await redis.getServiceRatesConfig()
  return mergeWithDefaults(stored)
}

async function getRates() {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.config
  }
  try {
    const config = await loadConfigFromRedis()
    cache = { config, expiresAt: Date.now() + CACHE_TTL_MS }
    return config
  } catch (error) {
    logger.warn(
      `⚠️ serviceRatesService: failed to load global rates, falling back to defaults: ${error.message}`
    )
    return buildDefaultConfig()
  }
}

async function getPublicRates() {
  const config = await getRates()
  return {
    rates: { ...config.rates },
    baseService: config.baseService,
    updatedAt: config.updatedAt
  }
}

async function getRate(service) {
  if (!service || !SUPPORTED_SERVICES.includes(service)) {
    return 1.0
  }
  const config = await getRates()
  const value = config.rates[service]
  return isValidRate(value) ? value : 1.0
}

async function saveRates({ rates, baseService, adminUsername }) {
  if (!rates || typeof rates !== 'object') {
    throw new Error('rates must be an object')
  }
  const sanitized = {}
  for (const service of SUPPORTED_SERVICES) {
    if (Object.prototype.hasOwnProperty.call(rates, service)) {
      const value = Number(rates[service])
      if (!isValidRate(value)) {
        throw new Error(`Invalid rate for service "${service}": must be a positive finite number`)
      }
      sanitized[service] = value
    }
  }
  // Pass-through unknown services already in storage (forward compat) but reject in incoming payload
  const incomingKeys = Object.keys(rates)
  const unknown = incomingKeys.filter((k) => !SUPPORTED_SERVICES.includes(k))
  if (unknown.length > 0) {
    throw new Error(`Unknown service id(s): ${unknown.join(', ')}`)
  }

  const finalRates = { ...buildDefaultRates(), ...sanitized }
  let finalBaseService = DEFAULT_BASE_SERVICE
  if (baseService) {
    if (!SUPPORTED_SERVICES.includes(baseService)) {
      throw new Error(`Invalid baseService: ${baseService}`)
    }
    finalBaseService = baseService
  }

  const config = {
    rates: finalRates,
    baseService: finalBaseService,
    updatedAt: new Date().toISOString(),
    updatedBy: adminUsername || null
  }

  await redis.setServiceRatesConfig(config)
  invalidateCache()
  return config
}

function detectService(accountType, model) {
  if (accountType) {
    const t = String(accountType).toLowerCase()
    if (t === 'claude' || t === 'claude-official' || t === 'claude-console') {
      return 'claude'
    }
    if (t === 'ccr') {
      return 'ccr'
    }
    if (t === 'bedrock') {
      return 'bedrock'
    }
    if (t === 'gemini' || t === 'gemini-api') {
      return 'gemini'
    }
    if (t === 'openai' || t === 'openai-responses') {
      return 'codex'
    }
    if (t === 'azure-openai' || t === 'azure') {
      return 'azure'
    }
    if (t === 'droid') {
      return 'droid'
    }
  }
  if (model) {
    const m = String(model).toLowerCase()
    if (
      m.startsWith('claude') ||
      m.includes('opus') ||
      m.includes('sonnet') ||
      m.includes('haiku')
    ) {
      return 'claude'
    }
    if (
      m.startsWith('gpt') ||
      m.startsWith('o1') ||
      m.startsWith('o3') ||
      m.includes('codex') ||
      m.includes('davinci')
    ) {
      return 'codex'
    }
    if (m.startsWith('gemini') || m.includes('palm') || m.includes('bard')) {
      return 'gemini'
    }
    if (m.includes('bedrock') || m.includes('amazon') || m.includes('titan')) {
      return 'bedrock'
    }
    if (m.includes('azure')) {
      return 'azure'
    }
    if (m.includes('droid') || m.includes('factory')) {
      return 'droid'
    }
  }
  return 'claude'
}

function parseKeyOverrides(raw) {
  if (!raw) {
    return {}
  }
  if (typeof raw === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(raw)) {
      const num = Number(v)
      if (SUPPORTED_SERVICES.includes(k) && isValidRate(num)) {
        out[k] = num
      }
    }
    return out
  }
  if (typeof raw !== 'string' || raw.trim() === '' || raw.trim() === 'null') {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logger.warn(
      `⚠️ serviceRatesService: malformed serviceRates JSON, treating as no override: ${error.message}`
    )
    return {}
  }
  if (!parsed || typeof parsed !== 'object') {
    return {}
  }
  const out = {}
  for (const [k, v] of Object.entries(parsed)) {
    const num = Number(v)
    if (SUPPORTED_SERVICES.includes(k) && isValidRate(num)) {
      out[k] = num
    }
  }
  return out
}

async function computeRatedCost({ realCost, service, keyOverrides }) {
  const rc = Number(realCost) || 0
  if (rc <= 0) {
    return 0
  }
  const globalRate = await getRate(service)
  const override =
    keyOverrides && isValidRate(Number(keyOverrides[service])) ? Number(keyOverrides[service]) : 1.0
  return rc * globalRate * override
}

function getServiceList(config) {
  return SUPPORTED_SERVICES.map((id) => ({
    id,
    name: SERVICE_DISPLAY[id].name,
    icon: SERVICE_DISPLAY[id].icon,
    gradient: SERVICE_DISPLAY[id].gradient,
    rate: config.rates[id] ?? 1.0,
    isBase: config.baseService === id
  }))
}

module.exports = {
  SUPPORTED_SERVICES,
  SERVICE_DISPLAY,
  buildDefaultConfig,
  getRates,
  getPublicRates,
  getRate,
  saveRates,
  detectService,
  parseKeyOverrides,
  computeRatedCost,
  getServiceList,
  invalidateCache
}
