const redis = require('../models/redis')
const pricingService = require('../services/pricingService')
const CostCalculator = require('./costCalculator')
const serviceRatesService = require('../services/serviceRatesService')
const logger = require('./logger')

function toNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

async function updateRateLimitCounters(
  rateLimitInfo,
  usageSummary,
  model,
  useBooster = false,
  usageObject = null
) {
  if (!rateLimitInfo) {
    return { totalTokens: 0, totalCost: 0 }
  }

  const client = redis.getClient()
  if (!client) {
    throw new Error('Redis 未连接，无法更新限流计数')
  }

  const inputTokens = toNumber(usageSummary.inputTokens)
  const outputTokens = toNumber(usageSummary.outputTokens)
  const cacheCreateTokens = toNumber(usageSummary.cacheCreateTokens)
  const cacheReadTokens = toNumber(usageSummary.cacheReadTokens)

  const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

  // 使用加油包时，不更新时间窗口的 token 计数
  if (totalTokens > 0 && rateLimitInfo.tokenCountKey && !useBooster) {
    await client.incrby(rateLimitInfo.tokenCountKey, Math.round(totalTokens))
  }

  let totalCost = 0
  // 优先使用完整的 usageObject（含 cache_creation 详情），确保与周限制使用相同的定价
  const usagePayload = usageObject || {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreateTokens,
    cache_read_input_tokens: cacheReadTokens
  }

  try {
    const costInfo = pricingService.calculateCost(usagePayload, model)
    const { totalCost: calculatedCost } = costInfo || {}
    if (typeof calculatedCost === 'number') {
      totalCost = calculatedCost
    }
  } catch (error) {
    // 忽略此处错误，后续使用备用计算
    totalCost = 0
  }

  if (totalCost === 0) {
    try {
      const fallback = CostCalculator.calculateCost(usagePayload, model)
      const { costs } = fallback || {}
      if (costs && typeof costs.total === 'number') {
        totalCost = costs.total
      }
    } catch (error) {
      totalCost = 0
    }
  }

  // 使用加油包时，不更新时间窗口的成本计数
  if (totalCost > 0 && rateLimitInfo.costCountKey && !useBooster) {
    // 从 costCountKey 提取 keyId: rate_limit:cost:{keyId}
    const keyId = rateLimitInfo.costCountKey.split(':')[2]

    // 应用服务倍率 (Service Multiplier)：窗口限制费用与每日/周限制保持一致，使用 ratedCost 计数
    let ratedCost = totalCost
    try {
      if (keyId) {
        const keyData = await redis.getApiKey(keyId)
        const keyOverrides = serviceRatesService.parseKeyOverrides(keyData?.serviceRates)
        const service = serviceRatesService.detectService(null, model)
        ratedCost = await serviceRatesService.computeRatedCost({
          realCost: totalCost,
          service,
          keyOverrides
        })
      }
    } catch (error) {
      // 失败开放：与全局费率读取失败时一致，按 realCost 计数（multiplier=1.0）
      ratedCost = totalCost
      logger.warn(
        `⚠️ rateLimitHelper: failed to apply service multiplier on window cost, falling back to realCost: ${error.message}`
      )
    }

    await client.incrbyfloat(rateLimitInfo.costCountKey, ratedCost)

    // 返回值反映实际写入计数器的金额，便于上层日志一致显示
    totalCost = ratedCost

    // 同时激活周限窗口（确保逻辑一致性）
    if (keyId) {
      const weeklyWindowKey = `usage:cost:weekly:window_start:${keyId}`
      const exists = await client.exists(weeklyWindowKey)

      if (!exists) {
        // 首次使用，创建周限窗口
        const now = Date.now()
        const windowDuration = 7 * 24 * 60 * 60 * 1000 // 7天
        await client.set(weeklyWindowKey, now, 'PX', windowDuration)
        await client.set(`usage:cost:weekly:total:${keyId}`, 0, 'PX', windowDuration)
      }
    }
  }

  return { totalTokens, totalCost }
}

module.exports = {
  updateRateLimitCounters
}
