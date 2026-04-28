const Redis = require('ioredis')
const config = require('../../config/config')
const logger = require('../utils/logger')

// 时区辅助函数
// 注意：这个函数的目的是获取某个时间点在目标时区的"本地"表示
// 例如：UTC时间 2025-07-30 01:00:00 在 UTC+8 时区表示为 2025-07-30 09:00:00
function getDateInTimezone(date = new Date()) {
  const offset = config.system.timezoneOffset || 8 // 默认UTC+8

  // 方法：创建一个偏移后的Date对象，使其getUTCXXX方法返回目标时区的值
  // 这样我们可以用getUTCFullYear()等方法获取目标时区的年月日时分秒
  const offsetMs = offset * 3600000 // 时区偏移的毫秒数
  const adjustedTime = new Date(date.getTime() + offsetMs)

  return adjustedTime
}

// 获取配置时区的日期字符串 (YYYY-MM-DD)
function getDateStringInTimezone(date = new Date()) {
  const tzDate = getDateInTimezone(date)
  // 使用UTC方法获取偏移后的日期部分
  return `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}-${String(
    tzDate.getUTCDate()
  ).padStart(2, '0')}`
}

// 获取配置时区的小时 (0-23)
function getHourInTimezone(date = new Date()) {
  const tzDate = getDateInTimezone(date)
  return tzDate.getUTCHours()
}

// 获取配置时区的 ISO 周（YYYY-Wxx 格式，周一到周日）
function getWeekStringInTimezone(date = new Date()) {
  const tzDate = getDateInTimezone(date)

  // 获取年份
  const year = tzDate.getUTCFullYear()

  // 计算 ISO 周数（周一为第一天）
  const dateObj = new Date(tzDate)
  const dayOfWeek = dateObj.getUTCDay() || 7 // 将周日(0)转换为7
  const firstThursday = new Date(dateObj)
  firstThursday.setUTCDate(dateObj.getUTCDate() + 4 - dayOfWeek) // 找到这周的周四

  const yearStart = new Date(firstThursday.getUTCFullYear(), 0, 1)
  const weekNumber = Math.ceil(((firstThursday - yearStart) / 86400000 + 1) / 7)

  return `${year}-W${String(weekNumber).padStart(2, '0')}`
}

// 获取配置时区的月份字符串 (YYYY-MM)
function getMonthStringInTimezone(date = new Date()) {
  const tzDate = getDateInTimezone(date)
  return `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`
}

class RedisClient {
  constructor() {
    this.client = null
    this.isConnected = false

    // 🚀 性能优化：账户每日费用缓存（避免频繁 SCAN）
    // 缓存 TTL 30 秒，在高并发场景下大幅减少 Redis SCAN 操作
    this._accountDailyCostCache = new Map()
    this._accountDailyCostCacheTTL = 30000 // 30秒
  }

  async connect() {
    try {
      this.client = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.db,
        retryDelayOnFailover: config.redis.retryDelayOnFailover,
        maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
        lazyConnect: config.redis.lazyConnect,
        tls: config.redis.enableTLS ? {} : false
      })

      this.client.on('connect', () => {
        this.isConnected = true
        logger.info('🔗 Redis connected successfully')
      })

      this.client.on('error', (err) => {
        this.isConnected = false
        logger.error('❌ Redis connection error:', err)
      })

      this.client.on('close', () => {
        this.isConnected = false
        logger.warn('⚠️  Redis connection closed')
      })

      await this.client.connect()
      return this.client
    } catch (error) {
      logger.error('💥 Failed to connect to Redis:', error)
      throw error
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.quit()
      this.isConnected = false
      logger.info('👋 Redis disconnected')
    }
  }

  getClient() {
    if (!this.client || !this.isConnected) {
      logger.warn('⚠️ Redis client is not connected')
      return null
    }
    return this.client
  }

  // 安全获取客户端（用于关键操作）
  getClientSafe() {
    if (!this.client || !this.isConnected) {
      throw new Error('Redis client is not connected')
    }
    return this.client
  }

  /**
   * 使用 SCAN 替代 KEYS 命令（兼容 AWS Valkey）
   * KEYS 命令在 AWS Valkey 中被禁用，SCAN 是官方推荐的替代方案
   * @param {string} pattern - 匹配模式，如 'apikey:*'
   * @param {number} count - 每次扫描的数量，默认 1000（增大以减少网络往返）
   * @returns {Promise<string[]>} - 匹配的 key 数组
   */
  async scanKeys(pattern, count = 1000) {
    const client = this.getClientSafe()
    const keys = []
    let cursor = '0'

    do {
      const [nextCursor, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', count)
      cursor = nextCursor
      keys.push(...batch)
    } while (cursor !== '0')

    return keys
  }

  // 🔑 API Key 相关操作
  async setApiKey(keyId, keyData, hashedKey = null) {
    const key = `apikey:${keyId}`
    const client = this.getClientSafe()

    // 维护哈希映射表（用于快速查找）
    // hashedKey参数是实际的哈希值，用于建立映射
    if (hashedKey) {
      await client.hset('apikey:hash_map', hashedKey, keyId)
    }

    await client.hset(key, keyData)
    await client.expire(key, 86400 * 365) // 1年过期

    // 同步更新索引（用于分页查询优化）
    await this.updateApiKeyIndex(keyId, keyData)
  }

  async getApiKey(keyId) {
    const key = `apikey:${keyId}`
    return await this.client.hgetall(key)
  }

  async deleteApiKey(keyId) {
    const key = `apikey:${keyId}`

    // 获取要删除的API Key哈希值，以便从映射表中移除
    const keyData = await this.client.hgetall(key)
    if (keyData && keyData.apiKey) {
      // keyData.apiKey现在存储的是哈希值，直接从映射表删除
      await this.client.hdel('apikey:hash_map', keyData.apiKey)
    }

    // 同步删除索引
    await this.deleteApiKeyIndex(keyId)

    return await this.client.del(key)
  }

  async getAllApiKeys() {
    const keys = await this.scanKeys('apikey:*')
    const apiKeys = []
    for (const key of keys) {
      // 过滤掉hash_map和index，它们不是真正的API Key
      if (key === 'apikey:hash_map' || key === 'apikey:index') {
        continue
      }

      const keyData = await this.client.hgetall(key)
      if (keyData && Object.keys(keyData).length > 0) {
        apiKeys.push({ id: key.replace('apikey:', ''), ...keyData })
      }
    }
    return apiKeys
  }

  // 📇 API Key 索引相关操作（性能优化）
  // 索引字段列表：用于分页查询的基本信息和排序字段
  static INDEX_FIELDS = [
    'name',
    'description',
    'isActive',
    'createdAt',
    'expiresAt',
    'permissions',
    'isDeleted',
    'tags',
    'userId',
    'createdBy',
    // 排序字段
    'lastUsedAt',
    'tokenLimit',
    'concurrencyLimit',
    // 账户绑定字段（用于按所属账号搜索）
    'claudeAccountId',
    'claudeConsoleAccountId',
    'geminiAccountId',
    'openaiAccountId',
    'azureOpenaiAccountId',
    'bedrockAccountId',
    'droidAccountId'
  ]

  // 更新 API Key 索引
  async updateApiKeyIndex(keyId, keyData) {
    const indexData = {}
    for (const field of RedisClient.INDEX_FIELDS) {
      if (keyData[field] !== undefined) {
        indexData[field] = keyData[field]
      }
    }
    await this.client.hset('apikey:index', keyId, JSON.stringify(indexData))
  }

  // 删除 API Key 索引
  async deleteApiKeyIndex(keyId) {
    await this.client.hdel('apikey:index', keyId)
  }

  // 从索引获取所有 API Keys（O(1) 性能）
  async getAllApiKeysFromIndex() {
    const indexData = await this.client.hgetall('apikey:index')

    // 降级：如果索引为空，回退到原有方式
    if (!indexData || Object.keys(indexData).length === 0) {
      logger.warn('⚠️ API Key 索引为空，回退到 scanKeys 方式')
      return this.getAllApiKeys()
    }

    return Object.entries(indexData)
      .map(([id, json]) => {
        try {
          return { id, ...JSON.parse(json) }
        } catch {
          // JSON 解析失败，跳过该条目
          return null
        }
      })
      .filter(Boolean)
  }

  // 重建所有 API Key 索引
  async rebuildApiKeyIndex() {
    // 先清理旧索引，避免残留脏数据
    await this.client.del('apikey:index')

    const keys = await this.scanKeys('apikey:*')
    let count = 0

    for (const key of keys) {
      if (key === 'apikey:hash_map' || key === 'apikey:index') {
        continue
      }

      const keyData = await this.client.hgetall(key)
      if (keyData && Object.keys(keyData).length > 0) {
        const keyId = key.replace('apikey:', '')
        await this.updateApiKeyIndex(keyId, keyData)
        count++
      }
    }

    return count
  }

  // 🔍 通过哈希值查找API Key（性能优化）
  async findApiKeyByHash(hashedKey) {
    // 使用反向映射表：hash -> keyId
    const keyId = await this.client.hget('apikey:hash_map', hashedKey)
    if (!keyId) {
      return null
    }

    const keyData = await this.client.hgetall(`apikey:${keyId}`)
    if (keyData && Object.keys(keyData).length > 0) {
      return { id: keyId, ...keyData }
    }

    // 如果数据不存在，清理映射表
    await this.client.hdel('apikey:hash_map', hashedKey)
    return null
  }

  // 📊 使用统计相关操作（支持缓存token统计和模型信息）
  // 标准化模型名称，用于统计聚合
  _normalizeModelName(model) {
    if (!model || model === 'unknown') {
      return model
    }

    // 对于Bedrock模型，去掉区域前缀进行统一
    if (model.includes('.anthropic.') || model.includes('.claude')) {
      // 匹配所有AWS区域格式：region.anthropic.model-name-v1:0 -> claude-model-name
      // 支持所有AWS区域格式，如：us-east-1, eu-west-1, ap-southeast-1, ca-central-1等
      let normalized = model.replace(/^[a-z0-9-]+\./, '') // 去掉任何区域前缀（更通用）
      normalized = normalized.replace('anthropic.', '') // 去掉anthropic前缀
      normalized = normalized.replace(/-v\d+:\d+$/, '') // 去掉版本后缀（如-v1:0, -v2:1等）
      return normalized
    }

    // 对于其他模型，去掉常见的版本后缀
    return model.replace(/-v\d+:\d+$|:latest$/, '')
  }

  async incrementTokenUsage(
    keyId,
    tokens,
    inputTokens = 0,
    outputTokens = 0,
    cacheCreateTokens = 0,
    cacheReadTokens = 0,
    model = 'unknown',
    ephemeral5mTokens = 0, // 新增：5分钟缓存 tokens
    ephemeral1hTokens = 0, // 新增：1小时缓存 tokens
    isLongContextRequest = false, // 新增：是否为 1M 上下文请求（超过200k）
    cost = 0 // 实际计算的费用（含200K+溢价），0表示未知
  ) {
    const key = `usage:${keyId}`
    const now = new Date()
    const today = getDateStringInTimezone(now)
    const tzDate = getDateInTimezone(now)
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(
      2,
      '0'
    )}`
    const daily = `usage:daily:${keyId}:${today}`
    const monthly = `usage:monthly:${keyId}:${currentMonth}`

    // 标准化模型名用于统计聚合
    const normalizedModel = this._normalizeModelName(model)

    // 按模型统计的键
    const modelDaily = `usage:model:daily:${normalizedModel}:${today}`
    const modelMonthly = `usage:model:monthly:${normalizedModel}:${currentMonth}`

    // API Key级别的模型统计
    const keyModelDaily = `usage:${keyId}:model:daily:${normalizedModel}:${today}`
    const keyModelMonthly = `usage:${keyId}:model:monthly:${normalizedModel}:${currentMonth}`

    // 模型索引键（用于快速查找该 API Key 使用过哪些模型，避免 SCAN）
    const keyModelsIndex = `usage:${keyId}:models`
    const keyModelsMonthlyIndex = `usage:${keyId}:models:${currentMonth}`

    // 新增：系统级分钟统计
    const minuteTimestamp = Math.floor(now.getTime() / 60000)
    const systemMinuteKey = `system:metrics:minute:${minuteTimestamp}`

    // 智能处理输入输出token分配
    const finalInputTokens = inputTokens || 0
    const finalOutputTokens = outputTokens || (finalInputTokens > 0 ? 0 : tokens)
    const finalCacheCreateTokens = cacheCreateTokens || 0
    const finalCacheReadTokens = cacheReadTokens || 0

    // 重新计算真实的总token数（包括缓存token）
    const totalTokens =
      finalInputTokens + finalOutputTokens + finalCacheCreateTokens + finalCacheReadTokens
    // 核心token（不包括缓存）- 用于与历史数据兼容
    const coreTokens = finalInputTokens + finalOutputTokens

    // 使用Pipeline优化性能
    const pipeline = this.client.pipeline()

    // 现有的统计保持不变
    // 核心token统计（保持向后兼容）
    pipeline.hincrby(key, 'totalTokens', coreTokens)
    pipeline.hincrby(key, 'totalInputTokens', finalInputTokens)
    pipeline.hincrby(key, 'totalOutputTokens', finalOutputTokens)
    // 缓存token统计（新增）
    pipeline.hincrby(key, 'totalCacheCreateTokens', finalCacheCreateTokens)
    pipeline.hincrby(key, 'totalCacheReadTokens', finalCacheReadTokens)
    pipeline.hincrby(key, 'totalAllTokens', totalTokens) // 包含所有类型的总token
    // 详细缓存类型统计（新增）
    pipeline.hincrby(key, 'totalEphemeral5mTokens', ephemeral5mTokens)
    pipeline.hincrby(key, 'totalEphemeral1hTokens', ephemeral1hTokens)
    // 1M 上下文请求统计（新增）
    if (isLongContextRequest) {
      pipeline.hincrby(key, 'totalLongContextInputTokens', finalInputTokens)
      pipeline.hincrby(key, 'totalLongContextOutputTokens', finalOutputTokens)
      pipeline.hincrby(key, 'totalLongContextRequests', 1)
    }
    // 请求计数
    pipeline.hincrby(key, 'totalRequests', 1)

    // 每日统计
    pipeline.hincrby(daily, 'tokens', coreTokens)
    pipeline.hincrby(daily, 'inputTokens', finalInputTokens)
    pipeline.hincrby(daily, 'outputTokens', finalOutputTokens)
    pipeline.hincrby(daily, 'cacheCreateTokens', finalCacheCreateTokens)
    pipeline.hincrby(daily, 'cacheReadTokens', finalCacheReadTokens)
    pipeline.hincrby(daily, 'allTokens', totalTokens)
    pipeline.hincrby(daily, 'requests', 1)
    // 详细缓存类型统计
    pipeline.hincrby(daily, 'ephemeral5mTokens', ephemeral5mTokens)
    pipeline.hincrby(daily, 'ephemeral1hTokens', ephemeral1hTokens)
    // 1M 上下文请求统计
    if (isLongContextRequest) {
      pipeline.hincrby(daily, 'longContextInputTokens', finalInputTokens)
      pipeline.hincrby(daily, 'longContextOutputTokens', finalOutputTokens)
      pipeline.hincrby(daily, 'longContextRequests', 1)
    }

    // 每月统计
    pipeline.hincrby(monthly, 'tokens', coreTokens)
    pipeline.hincrby(monthly, 'inputTokens', finalInputTokens)
    pipeline.hincrby(monthly, 'outputTokens', finalOutputTokens)
    pipeline.hincrby(monthly, 'cacheCreateTokens', finalCacheCreateTokens)
    pipeline.hincrby(monthly, 'cacheReadTokens', finalCacheReadTokens)
    pipeline.hincrby(monthly, 'allTokens', totalTokens)
    pipeline.hincrby(monthly, 'requests', 1)
    // 详细缓存类型统计
    pipeline.hincrby(monthly, 'ephemeral5mTokens', ephemeral5mTokens)
    pipeline.hincrby(monthly, 'ephemeral1hTokens', ephemeral1hTokens)

    // 按模型统计 - 每日
    pipeline.hincrby(modelDaily, 'inputTokens', finalInputTokens)
    pipeline.hincrby(modelDaily, 'outputTokens', finalOutputTokens)
    pipeline.hincrby(modelDaily, 'cacheCreateTokens', finalCacheCreateTokens)
    pipeline.hincrby(modelDaily, 'cacheReadTokens', finalCacheReadTokens)
    pipeline.hincrby(modelDaily, 'allTokens', totalTokens)
    pipeline.hincrby(modelDaily, 'requests', 1)
    // 详细缓存类型统计
    pipeline.hincrby(modelDaily, 'ephemeral5mTokens', ephemeral5mTokens)
    pipeline.hincrby(modelDaily, 'ephemeral1hTokens', ephemeral1hTokens)

    // 按模型统计 - 每月
    pipeline.hincrby(modelMonthly, 'inputTokens', finalInputTokens)
    pipeline.hincrby(modelMonthly, 'outputTokens', finalOutputTokens)
    pipeline.hincrby(modelMonthly, 'cacheCreateTokens', finalCacheCreateTokens)
    pipeline.hincrby(modelMonthly, 'cacheReadTokens', finalCacheReadTokens)
    pipeline.hincrby(modelMonthly, 'allTokens', totalTokens)
    pipeline.hincrby(modelMonthly, 'requests', 1)
    // 详细缓存类型统计
    pipeline.hincrby(modelMonthly, 'ephemeral5mTokens', ephemeral5mTokens)
    pipeline.hincrby(modelMonthly, 'ephemeral1hTokens', ephemeral1hTokens)

    // API Key级别的模型统计 - 每日
    pipeline.hincrby(keyModelDaily, 'inputTokens', finalInputTokens)
    pipeline.hincrby(keyModelDaily, 'outputTokens', finalOutputTokens)
    pipeline.hincrby(keyModelDaily, 'cacheCreateTokens', finalCacheCreateTokens)
    pipeline.hincrby(keyModelDaily, 'cacheReadTokens', finalCacheReadTokens)
    pipeline.hincrby(keyModelDaily, 'allTokens', totalTokens)
    pipeline.hincrby(keyModelDaily, 'requests', 1)
    // 详细缓存类型统计
    pipeline.hincrby(keyModelDaily, 'ephemeral5mTokens', ephemeral5mTokens)
    pipeline.hincrby(keyModelDaily, 'ephemeral1hTokens', ephemeral1hTokens)

    // API Key级别的模型统计 - 每月
    pipeline.hincrby(keyModelMonthly, 'inputTokens', finalInputTokens)
    pipeline.hincrby(keyModelMonthly, 'outputTokens', finalOutputTokens)
    pipeline.hincrby(keyModelMonthly, 'cacheCreateTokens', finalCacheCreateTokens)
    pipeline.hincrby(keyModelMonthly, 'cacheReadTokens', finalCacheReadTokens)
    pipeline.hincrby(keyModelMonthly, 'allTokens', totalTokens)
    pipeline.hincrby(keyModelMonthly, 'requests', 1)
    // 详细缓存类型统计
    pipeline.hincrby(keyModelMonthly, 'ephemeral5mTokens', ephemeral5mTokens)
    pipeline.hincrby(keyModelMonthly, 'ephemeral1hTokens', ephemeral1hTokens)

    // 存储实际费用（含200K+溢价），用于模型分布费用准确性
    if (cost > 0) {
      pipeline.hincrbyfloat(modelDaily, 'cost', cost)
      pipeline.hincrbyfloat(modelMonthly, 'cost', cost)
      pipeline.hincrbyfloat(keyModelDaily, 'cost', cost)
      pipeline.hincrbyfloat(keyModelMonthly, 'cost', cost)
    }

    // 维护模型索引（用于快速查找，避免 SCAN）
    pipeline.sadd(keyModelsIndex, normalizedModel)
    pipeline.sadd(keyModelsMonthlyIndex, normalizedModel)

    // 新增：系统级分钟统计
    pipeline.hincrby(systemMinuteKey, 'requests', 1)
    pipeline.hincrby(systemMinuteKey, 'totalTokens', totalTokens)
    pipeline.hincrby(systemMinuteKey, 'inputTokens', finalInputTokens)
    pipeline.hincrby(systemMinuteKey, 'outputTokens', finalOutputTokens)
    pipeline.hincrby(systemMinuteKey, 'cacheCreateTokens', finalCacheCreateTokens)
    pipeline.hincrby(systemMinuteKey, 'cacheReadTokens', finalCacheReadTokens)

    // 设置过期时间
    pipeline.expire(daily, 86400 * 32) // 32天过期
    pipeline.expire(monthly, 86400 * 365) // 1年过期
    pipeline.expire(modelDaily, 86400 * 32) // 模型每日统计32天过期
    pipeline.expire(modelMonthly, 86400 * 365) // 模型每月统计1年过期
    pipeline.expire(keyModelDaily, 86400 * 32) // API Key模型每日统计32天过期
    pipeline.expire(keyModelMonthly, 86400 * 365) // API Key模型每月统计1年过期
    // 模型索引过期时间
    pipeline.expire(keyModelsIndex, 86400 * 365) // 总模型索引1年过期
    pipeline.expire(keyModelsMonthlyIndex, 86400 * 365) // 月度模型索引1年过期

    // 系统级分钟统计的过期时间（窗口时间的2倍）
    const configLocal = require('../../config/config')
    const metricsWindow = configLocal.system.metricsWindow || 5
    pipeline.expire(systemMinuteKey, metricsWindow * 60 * 2)

    // 执行Pipeline
    await pipeline.exec()
  }

  /**
   * 获取 API Key 使用过的模型列表（使用索引，避免 SCAN）
   * @param {string} keyId - API Key ID
   * @param {string} month - 可选，指定月份（格式：YYYY-MM），不指定则返回所有使用过的模型
   * @returns {Promise<string[]>} - 模型名称数组
   */
  async getApiKeyModels(keyId, month = null) {
    const client = this.getClientSafe()
    const indexKey = month ? `usage:${keyId}:models:${month}` : `usage:${keyId}:models`

    // 优先使用索引
    let models = await client.smembers(indexKey)

    // 如果索引为空，回退到 SCAN 并重建索引（兼容旧数据）
    if (!models || models.length === 0) {
      const pattern = month
        ? `usage:${keyId}:model:monthly:*:${month}`
        : `usage:${keyId}:model:monthly:*:*`
      const keys = await this.scanKeys(pattern)

      models = keys
        .map((k) => {
          const match = k.match(/usage:.+:model:monthly:(.+):\d{4}-\d{2}$/)
          return match ? match[1] : null
        })
        .filter((m) => m !== null)

      // 去重
      models = [...new Set(models)]

      // 重建索引
      if (models.length > 0) {
        await client.sadd(indexKey, ...models)
        await client.expire(indexKey, 86400 * 365) // 1年过期
      }
    }

    return models
  }

  /**
   * 批量获取 API Key 的模型使用统计（使用索引优化）
   * @param {string} keyId - API Key ID
   * @param {string} period - 统计周期：'daily' | 'monthly' | 'all'
   * @param {string} timeKey - 时间键（daily 为日期，monthly 为月份）
   * @returns {Promise<Map>} - 模型统计数据 Map
   */
  async getApiKeyModelStats(keyId, period = 'monthly', timeKey = null) {
    const client = this.getClientSafe()

    // 获取当前时间信息
    const now = new Date()
    const tzDate = getDateInTimezone(now)
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`

    // 确定使用哪个索引获取模型列表
    const monthForIndex = period === 'monthly' && timeKey ? timeKey : null
    const models = await this.getApiKeyModels(keyId, monthForIndex)

    if (models.length === 0) {
      return new Map()
    }

    // 批量获取模型统计数据
    const pipeline = client.pipeline()
    const modelStatsMap = new Map()

    if (period === 'all') {
      // 获取所有月份的数据
      // 先获取所有月份的索引
      const monthsKeys = await this.scanKeys(`usage:${keyId}:models:*`)
      const months = monthsKeys
        .map((k) => k.replace(`usage:${keyId}:models:`, ''))
        .filter((m) => /^\d{4}-\d{2}$/.test(m))

      // 添加当前月份确保不遗漏
      if (!months.includes(currentMonth)) {
        months.push(currentMonth)
      }

      // 为每个模型和月份组合构建键
      for (const model of models) {
        for (const month of months) {
          pipeline.hgetall(`usage:${keyId}:model:monthly:${model}:${month}`)
        }
      }

      const results = await pipeline.exec()
      let resultIndex = 0

      for (const model of models) {
        for (let i = 0; i < months.length; i++) {
          const [err, data] = results[resultIndex++]
          if (!err && data && Object.keys(data).length > 0) {
            if (!modelStatsMap.has(model)) {
              modelStatsMap.set(model, {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreateTokens: 0,
                cacheReadTokens: 0,
                requests: 0
              })
            }
            const stats = modelStatsMap.get(model)
            stats.inputTokens += parseInt(data.inputTokens || data.totalInputTokens) || 0
            stats.outputTokens += parseInt(data.outputTokens || data.totalOutputTokens) || 0
            stats.cacheCreateTokens +=
              parseInt(data.cacheCreateTokens || data.totalCacheCreateTokens) || 0
            stats.cacheReadTokens +=
              parseInt(data.cacheReadTokens || data.totalCacheReadTokens) || 0
            stats.requests += parseInt(data.requests) || 0
          }
        }
      }
    } else {
      // 单个时间周期
      const keyTime = timeKey || (period === 'daily' ? getDateStringInTimezone(now) : currentMonth)

      for (const model of models) {
        pipeline.hgetall(`usage:${keyId}:model:${period}:${model}:${keyTime}`)
      }

      const results = await pipeline.exec()

      for (let i = 0; i < models.length; i++) {
        const [err, data] = results[i]
        if (!err && data && Object.keys(data).length > 0) {
          modelStatsMap.set(models[i], {
            inputTokens: parseInt(data.inputTokens || data.totalInputTokens) || 0,
            outputTokens: parseInt(data.outputTokens || data.totalOutputTokens) || 0,
            cacheCreateTokens: parseInt(data.cacheCreateTokens || data.totalCacheCreateTokens) || 0,
            cacheReadTokens: parseInt(data.cacheReadTokens || data.totalCacheReadTokens) || 0,
            requests: parseInt(data.requests) || 0
          })
        }
      }
    }

    return modelStatsMap
  }

  // 🖼️ 记录媒体使用统计（图片、视频）
  async incrementMediaUsage(
    keyId,
    inputImages = 0,
    outputImages = 0,
    outputDurationSeconds = 0,
    model = 'unknown'
  ) {
    // Skip if no media usage
    if (inputImages === 0 && outputImages === 0 && outputDurationSeconds === 0) {
      return
    }

    const now = new Date()
    const today = getDateStringInTimezone(now)
    const tzDate = getDateInTimezone(now)
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(
      2,
      '0'
    )}`

    const key = `usage:${keyId}`
    const daily = `usage:daily:${keyId}:${today}`
    const monthly = `usage:monthly:${keyId}:${currentMonth}`

    // 标准化模型名用于统计聚合
    const normalizedModel = this._normalizeModelName(model)

    // 按模型统计的键
    const modelDaily = `usage:model:daily:${normalizedModel}:${today}`
    const modelMonthly = `usage:model:monthly:${normalizedModel}:${currentMonth}`

    // API Key级别的模型统计
    const keyModelDaily = `usage:${keyId}:model:daily:${normalizedModel}:${today}`
    const keyModelMonthly = `usage:${keyId}:model:monthly:${normalizedModel}:${currentMonth}`

    // 使用Pipeline优化性能
    const pipeline = this.client.pipeline()

    // API Key总体媒体统计
    if (inputImages > 0) {
      pipeline.hincrby(key, 'totalInputImages', inputImages)
    }
    if (outputImages > 0) {
      pipeline.hincrby(key, 'totalOutputImages', outputImages)
    }
    if (outputDurationSeconds > 0) {
      // 使用 incrbyfloat 支持小数秒
      pipeline.hincrbyfloat(key, 'totalOutputDurationSeconds', outputDurationSeconds)
    }

    // 每日媒体统计
    if (inputImages > 0) {
      pipeline.hincrby(daily, 'inputImages', inputImages)
    }
    if (outputImages > 0) {
      pipeline.hincrby(daily, 'outputImages', outputImages)
    }
    if (outputDurationSeconds > 0) {
      pipeline.hincrbyfloat(daily, 'outputDurationSeconds', outputDurationSeconds)
    }

    // 每月媒体统计
    if (inputImages > 0) {
      pipeline.hincrby(monthly, 'inputImages', inputImages)
    }
    if (outputImages > 0) {
      pipeline.hincrby(monthly, 'outputImages', outputImages)
    }
    if (outputDurationSeconds > 0) {
      pipeline.hincrbyfloat(monthly, 'outputDurationSeconds', outputDurationSeconds)
    }

    // 按模型统计 - 每日
    if (inputImages > 0) {
      pipeline.hincrby(modelDaily, 'inputImages', inputImages)
    }
    if (outputImages > 0) {
      pipeline.hincrby(modelDaily, 'outputImages', outputImages)
    }
    if (outputDurationSeconds > 0) {
      pipeline.hincrbyfloat(modelDaily, 'outputDurationSeconds', outputDurationSeconds)
    }

    // 按模型统计 - 每月
    if (inputImages > 0) {
      pipeline.hincrby(modelMonthly, 'inputImages', inputImages)
    }
    if (outputImages > 0) {
      pipeline.hincrby(modelMonthly, 'outputImages', outputImages)
    }
    if (outputDurationSeconds > 0) {
      pipeline.hincrbyfloat(modelMonthly, 'outputDurationSeconds', outputDurationSeconds)
    }

    // API Key级别的模型统计 - 每日
    if (inputImages > 0) {
      pipeline.hincrby(keyModelDaily, 'inputImages', inputImages)
    }
    if (outputImages > 0) {
      pipeline.hincrby(keyModelDaily, 'outputImages', outputImages)
    }
    if (outputDurationSeconds > 0) {
      pipeline.hincrbyfloat(keyModelDaily, 'outputDurationSeconds', outputDurationSeconds)
    }

    // API Key级别的模型统计 - 每月
    if (inputImages > 0) {
      pipeline.hincrby(keyModelMonthly, 'inputImages', inputImages)
    }
    if (outputImages > 0) {
      pipeline.hincrby(keyModelMonthly, 'outputImages', outputImages)
    }
    if (outputDurationSeconds > 0) {
      pipeline.hincrbyfloat(keyModelMonthly, 'outputDurationSeconds', outputDurationSeconds)
    }

    // 设置过期时间（与 incrementTokenUsage 保持一致）
    pipeline.expire(daily, 86400 * 32) // 32天过期
    pipeline.expire(monthly, 86400 * 365) // 1年过期
    pipeline.expire(modelDaily, 86400 * 32)
    pipeline.expire(modelMonthly, 86400 * 365)
    pipeline.expire(keyModelDaily, 86400 * 32)
    pipeline.expire(keyModelMonthly, 86400 * 365)

    // 执行Pipeline
    await pipeline.exec()

    logger.debug(
      `🖼️ Recorded media usage for ${keyId}: inputImages=${inputImages}, outputImages=${outputImages}, videoDuration=${outputDurationSeconds}s, model=${model}`
    )
  }

  // 📊 记录账户级别的使用统计
  async incrementAccountUsage(
    accountId,
    totalTokens,
    inputTokens = 0,
    outputTokens = 0,
    cacheCreateTokens = 0,
    cacheReadTokens = 0,
    model = 'unknown',
    isLongContextRequest = false,
    // 媒体使用字段
    inputImages = 0,
    outputImages = 0,
    outputDurationSeconds = 0
  ) {
    const now = new Date()
    const today = getDateStringInTimezone(now)
    const tzDate = getDateInTimezone(now)
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(
      2,
      '0'
    )}`
    const currentHour = `${today}:${String(getHourInTimezone(now)).padStart(2, '0')}`

    // 账户级别统计的键
    const accountKey = `account_usage:${accountId}`
    const accountDaily = `account_usage:daily:${accountId}:${today}`
    const accountMonthly = `account_usage:monthly:${accountId}:${currentMonth}`
    const accountHourly = `account_usage:hourly:${accountId}:${currentHour}`

    // 标准化模型名用于统计聚合
    const normalizedModel = this._normalizeModelName(model)

    // 账户按模型统计的键
    const accountModelDaily = `account_usage:model:daily:${accountId}:${normalizedModel}:${today}`
    const accountModelMonthly = `account_usage:model:monthly:${accountId}:${normalizedModel}:${currentMonth}`

    // 处理token分配
    const finalInputTokens = inputTokens || 0
    const finalOutputTokens = outputTokens || 0
    const finalCacheCreateTokens = cacheCreateTokens || 0
    const finalCacheReadTokens = cacheReadTokens || 0
    const actualTotalTokens =
      finalInputTokens + finalOutputTokens + finalCacheCreateTokens + finalCacheReadTokens
    const coreTokens = finalInputTokens + finalOutputTokens

    // 构建统计操作数组
    const operations = [
      // 账户总体统计
      this.client.hincrby(accountKey, 'totalTokens', coreTokens),
      this.client.hincrby(accountKey, 'totalInputTokens', finalInputTokens),
      this.client.hincrby(accountKey, 'totalOutputTokens', finalOutputTokens),
      this.client.hincrby(accountKey, 'totalCacheCreateTokens', finalCacheCreateTokens),
      this.client.hincrby(accountKey, 'totalCacheReadTokens', finalCacheReadTokens),
      this.client.hincrby(accountKey, 'totalAllTokens', actualTotalTokens),
      this.client.hincrby(accountKey, 'totalRequests', 1),

      // 账户每日统计
      this.client.hincrby(accountDaily, 'tokens', coreTokens),
      this.client.hincrby(accountDaily, 'inputTokens', finalInputTokens),
      this.client.hincrby(accountDaily, 'outputTokens', finalOutputTokens),
      this.client.hincrby(accountDaily, 'cacheCreateTokens', finalCacheCreateTokens),
      this.client.hincrby(accountDaily, 'cacheReadTokens', finalCacheReadTokens),
      this.client.hincrby(accountDaily, 'allTokens', actualTotalTokens),
      this.client.hincrby(accountDaily, 'requests', 1),

      // 账户每月统计
      this.client.hincrby(accountMonthly, 'tokens', coreTokens),
      this.client.hincrby(accountMonthly, 'inputTokens', finalInputTokens),
      this.client.hincrby(accountMonthly, 'outputTokens', finalOutputTokens),
      this.client.hincrby(accountMonthly, 'cacheCreateTokens', finalCacheCreateTokens),
      this.client.hincrby(accountMonthly, 'cacheReadTokens', finalCacheReadTokens),
      this.client.hincrby(accountMonthly, 'allTokens', actualTotalTokens),
      this.client.hincrby(accountMonthly, 'requests', 1),

      // 账户每小时统计
      this.client.hincrby(accountHourly, 'tokens', coreTokens),
      this.client.hincrby(accountHourly, 'inputTokens', finalInputTokens),
      this.client.hincrby(accountHourly, 'outputTokens', finalOutputTokens),
      this.client.hincrby(accountHourly, 'cacheCreateTokens', finalCacheCreateTokens),
      this.client.hincrby(accountHourly, 'cacheReadTokens', finalCacheReadTokens),
      this.client.hincrby(accountHourly, 'allTokens', actualTotalTokens),
      this.client.hincrby(accountHourly, 'requests', 1),

      // 添加模型级别的数据到hourly键中，以支持会话窗口的统计
      this.client.hincrby(accountHourly, `model:${normalizedModel}:inputTokens`, finalInputTokens),
      this.client.hincrby(
        accountHourly,
        `model:${normalizedModel}:outputTokens`,
        finalOutputTokens
      ),
      this.client.hincrby(
        accountHourly,
        `model:${normalizedModel}:cacheCreateTokens`,
        finalCacheCreateTokens
      ),
      this.client.hincrby(
        accountHourly,
        `model:${normalizedModel}:cacheReadTokens`,
        finalCacheReadTokens
      ),
      this.client.hincrby(accountHourly, `model:${normalizedModel}:allTokens`, actualTotalTokens),
      this.client.hincrby(accountHourly, `model:${normalizedModel}:requests`, 1),

      // 账户按模型统计 - 每日
      this.client.hincrby(accountModelDaily, 'inputTokens', finalInputTokens),
      this.client.hincrby(accountModelDaily, 'outputTokens', finalOutputTokens),
      this.client.hincrby(accountModelDaily, 'cacheCreateTokens', finalCacheCreateTokens),
      this.client.hincrby(accountModelDaily, 'cacheReadTokens', finalCacheReadTokens),
      this.client.hincrby(accountModelDaily, 'allTokens', actualTotalTokens),
      this.client.hincrby(accountModelDaily, 'requests', 1),
      // 媒体使用字段 - 每日 (只在有值时写入，避免写入0)
      ...(inputImages > 0
        ? [this.client.hincrbyfloat(accountModelDaily, 'inputImages', inputImages)]
        : []),
      ...(outputImages > 0
        ? [this.client.hincrbyfloat(accountModelDaily, 'outputImages', outputImages)]
        : []),
      ...(outputDurationSeconds > 0
        ? [
            this.client.hincrbyfloat(
              accountModelDaily,
              'outputDurationSeconds',
              outputDurationSeconds
            )
          ]
        : []),

      // 账户按模型统计 - 每月
      this.client.hincrby(accountModelMonthly, 'inputTokens', finalInputTokens),
      this.client.hincrby(accountModelMonthly, 'outputTokens', finalOutputTokens),
      this.client.hincrby(accountModelMonthly, 'cacheCreateTokens', finalCacheCreateTokens),
      this.client.hincrby(accountModelMonthly, 'cacheReadTokens', finalCacheReadTokens),
      this.client.hincrby(accountModelMonthly, 'allTokens', actualTotalTokens),
      this.client.hincrby(accountModelMonthly, 'requests', 1),
      // 媒体使用字段 - 每月 (只在有值时写入，避免写入0)
      ...(inputImages > 0
        ? [this.client.hincrbyfloat(accountModelMonthly, 'inputImages', inputImages)]
        : []),
      ...(outputImages > 0
        ? [this.client.hincrbyfloat(accountModelMonthly, 'outputImages', outputImages)]
        : []),
      ...(outputDurationSeconds > 0
        ? [
            this.client.hincrbyfloat(
              accountModelMonthly,
              'outputDurationSeconds',
              outputDurationSeconds
            )
          ]
        : []),

      // 设置过期时间
      this.client.expire(accountDaily, 86400 * 32), // 32天过期
      this.client.expire(accountMonthly, 86400 * 365), // 1年过期
      this.client.expire(accountHourly, 86400 * 7), // 7天过期
      this.client.expire(accountModelDaily, 86400 * 32), // 32天过期
      this.client.expire(accountModelMonthly, 86400 * 365) // 1年过期
    ]

    // 如果是 1M 上下文请求，添加额外的统计
    if (isLongContextRequest) {
      operations.push(
        this.client.hincrby(accountKey, 'totalLongContextInputTokens', finalInputTokens),
        this.client.hincrby(accountKey, 'totalLongContextOutputTokens', finalOutputTokens),
        this.client.hincrby(accountKey, 'totalLongContextRequests', 1),
        this.client.hincrby(accountDaily, 'longContextInputTokens', finalInputTokens),
        this.client.hincrby(accountDaily, 'longContextOutputTokens', finalOutputTokens),
        this.client.hincrby(accountDaily, 'longContextRequests', 1)
      )
    }

    await Promise.all(operations)
  }

  async getUsageStats(keyId) {
    const totalKey = `usage:${keyId}`
    const today = getDateStringInTimezone()
    const dailyKey = `usage:daily:${keyId}:${today}`
    const tzDate = getDateInTimezone()
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(
      2,
      '0'
    )}`
    const monthlyKey = `usage:monthly:${keyId}:${currentMonth}`

    const [total, daily, monthly] = await Promise.all([
      this.client.hgetall(totalKey),
      this.client.hgetall(dailyKey),
      this.client.hgetall(monthlyKey)
    ])

    // 获取API Key的创建时间来计算平均值
    const keyData = await this.client.hgetall(`apikey:${keyId}`)
    const createdAt = keyData.createdAt ? new Date(keyData.createdAt) : new Date()
    const now = new Date()
    const daysSinceCreated = Math.max(1, Math.ceil((now - createdAt) / (1000 * 60 * 60 * 24)))

    const totalTokens = parseInt(total.totalTokens) || 0
    const totalRequests = parseInt(total.totalRequests) || 0

    // 计算平均RPM (requests per minute) 和 TPM (tokens per minute)
    const totalMinutes = Math.max(1, daysSinceCreated * 24 * 60)
    const avgRPM = totalRequests / totalMinutes
    const avgTPM = totalTokens / totalMinutes

    // 处理旧数据兼容性（支持缓存token）
    const handleLegacyData = (data) => {
      // 优先使用total*字段（存储时使用的字段）
      const tokens = parseInt(data.totalTokens) || parseInt(data.tokens) || 0
      const inputTokens = parseInt(data.totalInputTokens) || parseInt(data.inputTokens) || 0
      const outputTokens = parseInt(data.totalOutputTokens) || parseInt(data.outputTokens) || 0
      const requests = parseInt(data.totalRequests) || parseInt(data.requests) || 0

      // 新增缓存token字段
      const cacheCreateTokens =
        parseInt(data.totalCacheCreateTokens) || parseInt(data.cacheCreateTokens) || 0
      const cacheReadTokens =
        parseInt(data.totalCacheReadTokens) || parseInt(data.cacheReadTokens) || 0
      const allTokens = parseInt(data.totalAllTokens) || parseInt(data.allTokens) || 0

      const totalFromSeparate = inputTokens + outputTokens
      // 计算实际的总tokens（包含所有类型）
      const actualAllTokens =
        allTokens || inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

      if (totalFromSeparate === 0 && tokens > 0) {
        // 旧数据：没有输入输出分离
        return {
          tokens, // 保持兼容性，但统一使用allTokens
          inputTokens: Math.round(tokens * 0.3), // 假设30%为输入
          outputTokens: Math.round(tokens * 0.7), // 假设70%为输出
          cacheCreateTokens: 0, // 旧数据没有缓存token
          cacheReadTokens: 0,
          allTokens: tokens, // 对于旧数据，allTokens等于tokens
          requests
        }
      } else {
        // 新数据或无数据 - 统一使用allTokens作为tokens的值
        return {
          tokens: actualAllTokens, // 统一使用allTokens作为总数
          inputTokens,
          outputTokens,
          cacheCreateTokens,
          cacheReadTokens,
          allTokens: actualAllTokens,
          requests
        }
      }
    }

    const totalData = handleLegacyData(total)
    const dailyData = handleLegacyData(daily)
    const monthlyData = handleLegacyData(monthly)

    return {
      total: totalData,
      daily: dailyData,
      monthly: monthlyData,
      averages: {
        rpm: Math.round(avgRPM * 100) / 100, // 保留2位小数
        tpm: Math.round(avgTPM * 100) / 100,
        dailyRequests: Math.round((totalRequests / daysSinceCreated) * 100) / 100,
        dailyTokens: Math.round((totalTokens / daysSinceCreated) * 100) / 100
      }
    }
  }

  /**
   * 📊 获取API Key的历史使用统计数据（按小时、天或月）
   * @param {string} keyId - API Key ID
   * @param {'hourly'|'daily'|'monthly'} granularity - 时间粒度
   * @param {number} limit - 要查询的时间段数量 (1-100)
   * @returns {Promise<Array<Object>>} 历史统计数据数组
   */
  async getHistoricalUsageStats(keyId, granularity, limit) {
    // 参数验证
    if (!limit || limit < 1 || limit > 100) {
      throw new Error('Invalid limit. Must be between 1 and 100.')
    }

    const client = this.getClientSafe()
    const now = new Date()
    const dataPoints = []
    const pipeline = client.pipeline()
    const keysToFetch = []

    for (let i = 0; i < limit; i++) {
      let date
      let key = ''
      let timestamp = ''

      // 根据粒度计算日期和构建key
      // 使用毫秒偏移确保与配置时区的 key 字符串一致
      switch (granularity) {
        case 'hourly':
          // 每小时 3600000 毫秒
          date = new Date(now.getTime() - i * 3600000)
          timestamp = `${getDateStringInTimezone(date)}:${String(getHourInTimezone(date)).padStart(2, '0')}`
          key = `usage:hourly:${keyId}:${timestamp}`
          break
        case 'daily':
          // 每天 86400000 毫秒
          date = new Date(now.getTime() - i * 86400000)
          timestamp = getDateStringInTimezone(date)
          key = `usage:daily:${keyId}:${timestamp}`
          break
        case 'monthly':
          // 月份计算需要特殊处理，避免边界问题
          // 先获取当前配置时区的年月，再进行月份偏移
          date = new Date(now)
          // 先设置日期为1号，避免月份溢出问题（如3月31日减1个月）
          date.setUTCDate(1)
          date.setUTCMonth(date.getUTCMonth() - i)
          timestamp = getMonthStringInTimezone(date)
          key = `usage:monthly:${keyId}:${timestamp}`
          break
        default:
          throw new Error('Invalid granularity. Must be "hourly", "daily", or "monthly".')
      }

      keysToFetch.push({ key, timestamp: date.getTime() }) // 存储原始时间戳以便排序
      pipeline.hgetall(key)
    }

    const results = await pipeline.exec()

    // 假设results的顺序与keysToFetch的顺序一致
    for (let i = 0; i < keysToFetch.length; i++) {
      const { key, timestamp } = keysToFetch[i]
      const [error, data] = results[i]

      if (error) {
        logger.error(`❌ Failed to fetch historical data for key ${key}:`, error)
        continue
      }

      // 处理数据，确保所有字段都是数字，并提供默认值
      const requests = parseInt(data?.requests || '0')
      const inputTokens = parseInt(data?.inputTokens || '0')
      const outputTokens = parseInt(data?.outputTokens || '0')
      const cacheCreateTokens = parseInt(data?.cacheCreateTokens || '0')
      const cacheReadTokens = parseInt(data?.cacheReadTokens || '0')
      const allTokens = parseInt(data?.allTokens || '0')

      dataPoints.push({
        timestamp, // 返回时间戳，前端可以格式化
        requests,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        allTokens
      })
    }

    // 确保数据点按时间升序排列，方便前端展示
    return dataPoints.sort((a, b) => a.timestamp - b.timestamp)
  }

  async addUsageRecord(keyId, record, maxRecords = 2000) {
    const listKey = `usage:records:${keyId}`
    const client = this.getClientSafe()

    try {
      await client
        .multi()
        .lpush(listKey, JSON.stringify(record))
        .ltrim(listKey, 0, Math.max(0, maxRecords - 1))
        .expire(listKey, 86400 * 30) // 默认保留30天
        .exec()
    } catch (error) {
      logger.error(`❌ Failed to append usage record for key ${keyId}:`, error)
    }
  }

  async getUsageRecords(keyId, limit = 50) {
    const listKey = `usage:records:${keyId}`
    const client = this.getClient()

    if (!client) {
      return []
    }

    try {
      const rawRecords = await client.lrange(listKey, 0, Math.max(0, limit - 1))
      return rawRecords
        .map((entry) => {
          try {
            return JSON.parse(entry)
          } catch (error) {
            logger.warn('⚠️ Failed to parse usage record entry:', error)
            return null
          }
        })
        .filter(Boolean)
    } catch (error) {
      logger.error(`❌ Failed to load usage records for key ${keyId}:`, error)
      return []
    }
  }

  // 💰 获取当日费用
  async getDailyCost(keyId) {
    const today = getDateStringInTimezone()
    const costKey = `usage:cost:daily:${keyId}:${today}`
    const cost = await this.client.get(costKey)
    const result = parseFloat(cost || 0)
    logger.debug(
      `💰 Getting daily cost for ${keyId}, date: ${today}, key: ${costKey}, value: ${cost}, result: ${result}`
    )
    return result
  }

  // 💰 增加当日费用
  async incrementDailyCost(keyId, amount) {
    const today = getDateStringInTimezone()
    const tzDate = getDateInTimezone()
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(
      2,
      '0'
    )}`
    const dailyKey = `usage:cost:daily:${keyId}:${today}`
    const monthlyKey = `usage:cost:monthly:${keyId}:${currentMonth}`
    const totalKey = `usage:cost:total:${keyId}` // 总费用键 - 永不过期，持续累加

    logger.debug(
      `💰 Incrementing cost for ${keyId}, amount: $${amount}, date: ${today}, dailyKey: ${dailyKey}`
    )

    const results = await Promise.all([
      this.client.incrbyfloat(dailyKey, amount),
      this.client.incrbyfloat(monthlyKey, amount),
      this.client.incrbyfloat(totalKey, amount), // ✅ 累加到总费用（永不过期）
      // 设置过期时间（注意：totalKey 不设置过期时间，保持永久累计）
      this.client.expire(dailyKey, 86400 * 30), // 30天
      this.client.expire(monthlyKey, 86400 * 90) // 90天
    ])

    logger.debug(`💰 Cost incremented successfully, new daily total: $${results[0]}`)
  }

  // 💰 获取费用统计
  async getCostStats(keyId) {
    const today = getDateStringInTimezone()
    const tzDate = getDateInTimezone()
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(
      2,
      '0'
    )}`
    const [daily, monthly, total] = await Promise.all([
      this.client.get(`usage:cost:daily:${keyId}:${today}`),
      this.client.get(`usage:cost:monthly:${keyId}:${currentMonth}`),
      this.client.get(`usage:cost:total:${keyId}`)
    ])

    return {
      daily: parseFloat(daily || 0),
      monthly: parseFloat(monthly || 0),
      hourly: 0, // hourly 统计已关闭，保留字段兼容前端
      total: parseFloat(total || 0)
    }
  }

  // 💰 获取本周 Opus 费用
  async getWeeklyOpusCost(keyId) {
    const currentWeek = getWeekStringInTimezone()
    const costKey = `usage:opus:weekly:${keyId}:${currentWeek}`
    const cost = await this.client.get(costKey)
    const result = parseFloat(cost || 0)
    logger.debug(
      `💰 Getting weekly Opus cost for ${keyId}, week: ${currentWeek}, key: ${costKey}, value: ${cost}, result: ${result}`
    )
    return result
  }

  // 💰 增加本周 Opus 费用
  async incrementWeeklyOpusCost(keyId, amount) {
    const currentWeek = getWeekStringInTimezone()
    const weeklyKey = `usage:opus:weekly:${keyId}:${currentWeek}`
    const totalKey = `usage:opus:total:${keyId}`

    logger.debug(
      `💰 Incrementing weekly Opus cost for ${keyId}, week: ${currentWeek}, amount: $${amount}`
    )

    // 使用 pipeline 批量执行，提高性能
    const pipeline = this.client.pipeline()
    pipeline.incrbyfloat(weeklyKey, amount)
    pipeline.incrbyfloat(totalKey, amount)
    // 设置周费用键的过期时间为 2 周
    pipeline.expire(weeklyKey, 14 * 24 * 3600)

    const results = await pipeline.exec()
    logger.debug(`💰 Opus cost incremented successfully, new weekly total: $${results[0][1]}`)
  }

  // 💰 增加周总成本（固定7天周期窗口，所有模型）
  async incrementWeeklyCost(keyId, amount) {
    const windowStartKey = `usage:cost:weekly:window_start:${keyId}`
    const totalCostKey = `usage:cost:weekly:total:${keyId}`
    const now = Date.now()
    const windowDuration = 7 * 24 * 60 * 60 * 1000 // 7天（毫秒）

    logger.debug(`💰 Incrementing weekly cost for ${keyId}, amount: ${amount}, timestamp: ${now}`)

    // 获取窗口开始时间
    let windowStart = await this.client.get(windowStartKey)

    if (!windowStart) {
      // 第一次请求，设置窗口开始时间
      await this.client.set(windowStartKey, now, 'PX', windowDuration)
      await this.client.set(totalCostKey, 0, 'PX', windowDuration)
      windowStart = now
      logger.debug(`💰 Started new weekly cycle for ${keyId} at ${new Date(now).toISOString()}`)
    } else {
      windowStart = parseInt(windowStart)

      // 检查窗口是否已过期
      if (now - windowStart >= windowDuration) {
        // 窗口已过期，重置
        await this.client.set(windowStartKey, now, 'PX', windowDuration)
        await this.client.set(totalCostKey, 0, 'PX', windowDuration)
        windowStart = now
        logger.debug(
          `💰 Weekly cycle expired for ${keyId}, started new cycle at ${new Date(now).toISOString()}`
        )
      }
    }

    // 增加本次费用
    await this.client.incrbyfloat(totalCostKey, amount)
    logger.debug(`💰 Weekly cost incremented successfully for ${keyId}, added $${amount}`)
  }

  // 💰 获取周总成本（固定7天周期窗口）
  async getWeeklyCost(keyId) {
    const totalCostKey = `usage:cost:weekly:total:${keyId}`

    // 直接读取当前周期的总费用
    const cost = await this.client.get(totalCostKey)
    const totalCost = parseFloat(cost || 0)

    logger.debug(`💰 Weekly cost for ${keyId}: $${totalCost.toFixed(6)}`)
    return totalCost
  }

  // 💰 获取周成本重置时间（周期起点 + 7天）
  async getWeeklyCostResetTime(keyId) {
    const windowStartKey = `usage:cost:weekly:window_start:${keyId}`
    const windowDuration = 7 * 24 * 60 * 60 * 1000 // 7天（毫秒）

    // 获取周期起点时间
    const windowStart = await this.client.get(windowStartKey)

    if (!windowStart) {
      // 如果没有周期记录，返回当前时间 + 7天（默认值）
      logger.debug(`💰 No active weekly cycle for ${keyId}, using default reset time`)
      return new Date(Date.now() + windowDuration)
    }

    // 重置时间 = 周期起点 + 7天
    const resetTime = new Date(parseInt(windowStart) + windowDuration)

    logger.debug(
      `💰 Weekly cost reset time for ${keyId}: ${resetTime.toISOString()} (cycle started at ${new Date(parseInt(windowStart)).toISOString()})`
    )

    return resetTime
  }

  // 检查周限是否已激活（是否有过使用记录）
  async isWeeklyCostActive(keyId) {
    const windowStartKey = `usage:cost:weekly:window_start:${keyId}`
    const exists = await this.client.exists(windowStartKey)
    return exists === 1
  }

  // 💰 获取周成本开始时间（周期起点时间）
  async getWeeklyCostStartTime(keyId) {
    const windowStartKey = `usage:cost:weekly:window_start:${keyId}`

    // 获取周期起点时间
    const windowStart = await this.client.get(windowStartKey)

    if (!windowStart) {
      // 如果没有周期记录，返回 null
      logger.debug(`💰 No active weekly cycle for ${keyId}, no start time`)
      return null
    }

    // 返回周期起点时间
    const startTime = new Date(parseInt(windowStart))

    logger.debug(`💰 Weekly cost start time for ${keyId}: ${startTime.toISOString()}`)

    return startTime
  }

  // 💰 重置周成本记录（清除周期数据，下次请求时会自动创建新周期）
  async resetWeeklyCost(keyId) {
    const windowStartKey = `usage:cost:weekly:window_start:${keyId}`
    const totalCostKey = `usage:cost:weekly:total:${keyId}`

    logger.debug(`💰 Resetting weekly cost for ${keyId}`)

    // 删除周期开始时间和总成本
    await Promise.all([this.client.del(windowStartKey), this.client.del(totalCostKey)])

    logger.debug(`💰 Weekly cost reset successfully for ${keyId}`)
  }

  // 🚀 加油包相关方法

  // 🚀 获取加油包已使用金额
  async getBoosterPackUsed(keyId) {
    const usedKey = `usage:booster:used:${keyId}`
    const used = await this.client.get(usedKey)
    const result = parseFloat(used || 0)
    logger.debug(`🚀 Getting booster pack used for ${keyId}: $${result}`)
    return result
  }

  // 🚀 增加加油包已使用金额
  async incrementBoosterPackUsed(keyId, amount) {
    const usedKey = `usage:booster:used:${keyId}`

    // Round to 6 decimal places to prevent floating point drift
    const roundedAmount = Math.round(amount * 1000000) / 1000000

    logger.debug(
      `🚀 Incrementing booster pack used for ${keyId}, amount: $${roundedAmount.toFixed(6)}`
    )

    const newTotal = await this.client.incrbyfloat(usedKey, roundedAmount)
    // Round the result to prevent accumulated errors
    const roundedTotal = Math.round(parseFloat(newTotal) * 1000000) / 1000000

    logger.debug(
      `🚀 Booster pack used incremented successfully, new total: $${roundedTotal.toFixed(6)}`
    )

    return roundedTotal
  }

  // 🚀 添加加油包使用记录（Sorted Set存储）
  async addBoosterPackRecord(keyId, record) {
    const recordsKey = `usage:booster:records:${keyId}`
    const { timestamp, amount, model, accountType } = record

    logger.debug(
      `🚀 Adding booster pack record for ${keyId}: timestamp=${timestamp}, amount=$${amount}, model=${model}`
    )

    // 使用 Sorted Set 存储，score 为时间戳，value 为 JSON 字符串
    const value = JSON.stringify({
      timestamp,
      amount,
      model,
      accountType: accountType || 'unknown'
    })

    const pipeline = this.client.pipeline()
    pipeline.zadd(recordsKey, timestamp, value)
    // 设置过期时间为 90 天（保留历史记录）
    pipeline.expire(recordsKey, 90 * 24 * 3600)

    await pipeline.exec()
    logger.debug(`🚀 Booster pack record added successfully for ${keyId}`)
  }

  // 🚀 获取加油包使用记录（时间范围查询）
  async getBoosterPackRecords(keyId, startTime = 0, endTime = Date.now()) {
    const recordsKey = `usage:booster:records:${keyId}`

    logger.debug(
      `🚀 Getting booster pack records for ${keyId}, range: ${new Date(startTime).toISOString()} - ${new Date(endTime).toISOString()}`
    )

    // 获取时间范围内的所有记录
    const records = await this.client.zrangebyscore(recordsKey, startTime, endTime)

    if (!records || records.length === 0) {
      logger.debug(`🚀 No booster pack records found for ${keyId}`)
      return []
    }

    // 解析 JSON 字符串
    const parsedRecords = records
      .map((record) => {
        try {
          return JSON.parse(record)
        } catch (error) {
          logger.error(`Failed to parse booster pack record: ${record}`, error)
          return null
        }
      })
      .filter((r) => r !== null)

    logger.debug(`🚀 Found ${parsedRecords.length} booster pack records for ${keyId}`)
    return parsedRecords
  }

  // 🚀 获取加油包使用统计（按时间聚合）
  async getBoosterPackStats(keyId, groupBy = 'day') {
    const now = Date.now()

    // 根据 groupBy 确定时间范围
    let startTime
    switch (groupBy) {
      case 'hour':
        startTime = now - 24 * 60 * 60 * 1000 // 过去24小时
        break
      case 'day':
        startTime = now - 30 * 24 * 60 * 60 * 1000 // 过去30天
        break
      case 'week':
        startTime = now - 12 * 7 * 24 * 60 * 60 * 1000 // 过去12周
        break
      default:
        startTime = 0 // 全部历史
    }

    const records = await this.getBoosterPackRecords(keyId, startTime, now)

    if (records.length === 0) {
      return {
        totalAmount: 0,
        recordCount: 0,
        byPeriod: {},
        byModel: {}
      }
    }

    // 按时间段和模型聚合
    const byPeriod = {}
    const byModel = {}
    let totalAmount = 0

    for (const record of records) {
      totalAmount += record.amount

      // 按时间段聚合
      const date = new Date(record.timestamp)
      let periodKey
      switch (groupBy) {
        case 'hour':
          periodKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')} ${String(date.getUTCHours()).padStart(2, '0')}:00`
          break
        case 'day':
          periodKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
          break
        case 'week': {
          // ISO 8601 week calculation
          const weekStart = new Date(date)
          weekStart.setUTCDate(date.getUTCDate() - date.getUTCDay())
          weekStart.setUTCHours(0, 0, 0, 0)

          // Get ISO week number
          const yearStart = new Date(Date.UTC(weekStart.getUTCFullYear(), 0, 1))
          const weekNo = Math.ceil((weekStart - yearStart) / (7 * 24 * 60 * 60 * 1000) + 1)

          periodKey = `${weekStart.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
          break
        }
        default:
          periodKey = 'all'
      }

      byPeriod[periodKey] = (byPeriod[periodKey] || 0) + record.amount

      // 按模型聚合
      const modelKey = record.model || 'unknown'
      byModel[modelKey] = (byModel[modelKey] || 0) + record.amount
    }

    return {
      totalAmount,
      recordCount: records.length,
      byPeriod,
      byModel
    }
  }

  // 🚀 重置加油包使用记录
  async resetBoosterPackUsed(keyId) {
    const usedKey = `usage:booster:used:${keyId}`
    const recordsKey = `usage:booster:records:${keyId}`

    logger.debug(`🚀 Resetting booster pack for ${keyId}`)

    // 删除已使用金额和使用记录
    await Promise.all([this.client.del(usedKey), this.client.del(recordsKey)])

    logger.debug(`🚀 Booster pack reset successfully for ${keyId}`)
  }

  // 💰 计算账户的每日费用（基于模型使用）
  // 🚀 性能优化：添加 30 秒内存缓存，避免频繁 SCAN 操作
  async getAccountDailyCost(accountId) {
    const today = getDateStringInTimezone()
    const cacheKey = `${accountId}:${today}`

    // 🚀 检查缓存
    const cached = this._accountDailyCostCache.get(cacheKey)
    if (cached && Date.now() - cached.time < this._accountDailyCostCacheTTL) {
      return cached.cost
    }

    const CostCalculator = require('../utils/costCalculator')

    // 获取账户今日所有模型的使用数据
    const pattern = `account_usage:model:daily:${accountId}:*:${today}`
    const modelKeys = await this.scanKeys(pattern)

    if (!modelKeys || modelKeys.length === 0) {
      // 🚀 缓存空结果
      this._accountDailyCostCache.set(cacheKey, { cost: 0, time: Date.now() })
      return 0
    }

    let totalCost = 0

    // 🚀 批量获取所有模型数据（减少 Redis 往返）
    const getPromises = modelKeys.map((key) => this.client.hgetall(key))
    const results = await Promise.all(getPromises)

    for (let i = 0; i < modelKeys.length; i++) {
      const key = modelKeys[i]
      const modelUsage = results[i]

      // 从key中解析模型名称
      // 格式：account_usage:model:daily:{accountId}:{model}:{date}
      const parts = key.split(':')
      const model = parts[4] // 模型名在第5个位置（索引4）

      if (
        modelUsage &&
        (modelUsage.inputTokens || modelUsage.outputTokens || modelUsage.outputImages)
      ) {
        const usage = {
          input_tokens: parseInt(modelUsage.inputTokens || 0),
          output_tokens: parseInt(modelUsage.outputTokens || 0),
          cache_creation_input_tokens: parseInt(modelUsage.cacheCreateTokens || 0),
          cache_read_input_tokens: parseInt(modelUsage.cacheReadTokens || 0),
          // 媒体使用字段
          output_images: parseInt(modelUsage.outputImages || 0),
          output_duration_seconds: parseFloat(modelUsage.outputDurationSeconds || 0)
        }

        // 使用CostCalculator计算费用
        const costResult = CostCalculator.calculateCost(usage, model)
        totalCost += costResult.costs.total

        logger.debug(
          `💰 Account ${accountId} daily cost for model ${model}: $${costResult.costs.total}, outputImages: ${usage.output_images}`
        )
      }
    }

    // 🚀 缓存结果
    this._accountDailyCostCache.set(cacheKey, { cost: totalCost, time: Date.now() })

    // 🧹 清理过期缓存项（防止内存泄漏）
    if (this._accountDailyCostCache.size > 1000) {
      const now = Date.now()
      for (const [k, v] of this._accountDailyCostCache) {
        if (now - v.time > this._accountDailyCostCacheTTL) {
          this._accountDailyCostCache.delete(k)
        }
      }
    }

    logger.debug(`💰 Account ${accountId} total daily cost: $${totalCost}`)
    return totalCost
  }

  // 📊 获取账户使用统计
  async getAccountUsageStats(accountId, accountType = null) {
    const accountKey = `account_usage:${accountId}`
    const today = getDateStringInTimezone()
    const accountDailyKey = `account_usage:daily:${accountId}:${today}`
    const tzDate = getDateInTimezone()
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(
      2,
      '0'
    )}`
    const accountMonthlyKey = `account_usage:monthly:${accountId}:${currentMonth}`

    const [total, daily, monthly] = await Promise.all([
      this.client.hgetall(accountKey),
      this.client.hgetall(accountDailyKey),
      this.client.hgetall(accountMonthlyKey)
    ])

    // 获取账户创建时间来计算平均值 - 支持不同类型的账号
    let accountData = {}
    if (accountType === 'droid') {
      accountData = await this.client.hgetall(`droid:account:${accountId}`)
    } else if (accountType === 'openai') {
      accountData = await this.client.hgetall(`openai:account:${accountId}`)
    } else if (accountType === 'openai-responses') {
      accountData = await this.client.hgetall(`openai_responses_account:${accountId}`)
    } else {
      // 尝试多个前缀
      accountData = await this.client.hgetall(`claude_account:${accountId}`)
      if (!accountData.createdAt) {
        accountData = await this.client.hgetall(`openai:account:${accountId}`)
      }
      if (!accountData.createdAt) {
        accountData = await this.client.hgetall(`openai_responses_account:${accountId}`)
      }
      if (!accountData.createdAt) {
        accountData = await this.client.hgetall(`openai_account:${accountId}`)
      }
      if (!accountData.createdAt) {
        accountData = await this.client.hgetall(`droid:account:${accountId}`)
      }
    }
    const createdAt = accountData.createdAt ? new Date(accountData.createdAt) : new Date()
    const now = new Date()
    const daysSinceCreated = Math.max(1, Math.ceil((now - createdAt) / (1000 * 60 * 60 * 24)))

    const totalTokens = parseInt(total.totalTokens) || 0
    const totalRequests = parseInt(total.totalRequests) || 0

    // 计算平均RPM和TPM
    const totalMinutes = Math.max(1, daysSinceCreated * 24 * 60)
    const avgRPM = totalRequests / totalMinutes
    const avgTPM = totalTokens / totalMinutes

    // 处理账户统计数据
    const handleAccountData = (data) => {
      const tokens = parseInt(data.totalTokens) || parseInt(data.tokens) || 0
      const inputTokens = parseInt(data.totalInputTokens) || parseInt(data.inputTokens) || 0
      const outputTokens = parseInt(data.totalOutputTokens) || parseInt(data.outputTokens) || 0
      const requests = parseInt(data.totalRequests) || parseInt(data.requests) || 0
      const cacheCreateTokens =
        parseInt(data.totalCacheCreateTokens) || parseInt(data.cacheCreateTokens) || 0
      const cacheReadTokens =
        parseInt(data.totalCacheReadTokens) || parseInt(data.cacheReadTokens) || 0
      const allTokens = parseInt(data.totalAllTokens) || parseInt(data.allTokens) || 0

      const actualAllTokens =
        allTokens || inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

      return {
        tokens,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        allTokens: actualAllTokens,
        requests
      }
    }

    const totalData = handleAccountData(total)
    const dailyData = handleAccountData(daily)
    const monthlyData = handleAccountData(monthly)

    // 获取每日费用（基于模型使用）
    const dailyCost = await this.getAccountDailyCost(accountId)

    return {
      accountId,
      total: totalData,
      daily: {
        ...dailyData,
        cost: dailyCost
      },
      monthly: monthlyData,
      averages: {
        rpm: Math.round(avgRPM * 100) / 100,
        tpm: Math.round(avgTPM * 100) / 100,
        dailyRequests: Math.round((totalRequests / daysSinceCreated) * 100) / 100,
        dailyTokens: Math.round((totalTokens / daysSinceCreated) * 100) / 100
      }
    }
  }

  // 📈 获取所有账户的使用统计
  async getAllAccountsUsageStats() {
    try {
      // 获取所有Claude账户
      const accountKeys = await this.scanKeys('claude_account:*')
      const accountStats = []

      for (const accountKey of accountKeys) {
        const accountId = accountKey.replace('claude_account:', '')
        const accountData = await this.client.hgetall(accountKey)

        if (accountData.name) {
          const stats = await this.getAccountUsageStats(accountId)
          accountStats.push({
            id: accountId,
            name: accountData.name,
            email: accountData.email || '',
            status: accountData.status || 'unknown',
            isActive: accountData.isActive === 'true',
            ...stats
          })
        }
      }

      // 按当日token使用量排序
      accountStats.sort((a, b) => (b.daily.allTokens || 0) - (a.daily.allTokens || 0))

      return accountStats
    } catch (error) {
      logger.error('❌ Failed to get all accounts usage stats:', error)
      return []
    }
  }

  // 🧹 清空所有API Key的使用统计数据
  async resetAllUsageStats() {
    const client = this.getClientSafe()
    const stats = {
      deletedKeys: 0,
      deletedDailyKeys: 0,
      deletedMonthlyKeys: 0,
      resetApiKeys: 0
    }

    try {
      // 获取所有API Key ID
      const apiKeyIds = []
      const apiKeyKeys = await this.scanKeys('apikey:*')

      for (const key of apiKeyKeys) {
        if (key === 'apikey:hash_map') {
          continue
        } // 跳过哈希映射表
        const keyId = key.replace('apikey:', '')
        apiKeyIds.push(keyId)
      }

      // 清空每个API Key的使用统计
      for (const keyId of apiKeyIds) {
        // 删除总体使用统计
        const usageKey = `usage:${keyId}`
        const deleted = await client.del(usageKey)
        if (deleted > 0) {
          stats.deletedKeys++
        }

        // 删除该API Key的每日统计（使用精确的keyId匹配）
        const dailyKeys = await this.scanKeys(`usage:daily:${keyId}:*`)
        if (dailyKeys.length > 0) {
          await client.del(...dailyKeys)
          stats.deletedDailyKeys += dailyKeys.length
        }

        // 删除该API Key的每月统计（使用精确的keyId匹配）
        const monthlyKeys = await this.scanKeys(`usage:monthly:${keyId}:*`)
        if (monthlyKeys.length > 0) {
          await client.del(...monthlyKeys)
          stats.deletedMonthlyKeys += monthlyKeys.length
        }

        // 重置API Key的lastUsedAt字段
        const keyData = await client.hgetall(`apikey:${keyId}`)
        if (keyData && Object.keys(keyData).length > 0) {
          keyData.lastUsedAt = ''
          await client.hset(`apikey:${keyId}`, keyData)
          stats.resetApiKeys++
        }
      }

      // 额外清理：删除所有可能遗漏的usage相关键
      const allUsageKeys = await this.scanKeys('usage:*')
      if (allUsageKeys.length > 0) {
        await client.del(...allUsageKeys)
        stats.deletedKeys += allUsageKeys.length
      }

      return stats
    } catch (error) {
      throw new Error(`Failed to reset usage stats: ${error.message}`)
    }
  }

  // 🏢 Claude 账户管理
  // 索引 Set 键名
  static CLAUDE_ACCOUNT_INDEX = 'claude:account:_index'

  async setClaudeAccount(accountId, accountData) {
    const key = `claude:account:${accountId}`
    const client = this.getClientSafe()
    // 使用 pipeline 原子性更新账户数据和索引
    const pipeline = client.pipeline()
    pipeline.hset(key, accountData)
    pipeline.sadd(RedisClient.CLAUDE_ACCOUNT_INDEX, accountId)
    await pipeline.exec()
  }

  async getClaudeAccount(accountId) {
    const key = `claude:account:${accountId}`
    return await this.client.hgetall(key)
  }

  async getAllClaudeAccounts() {
    const client = this.getClientSafe()

    // 优先使用索引 Set（O(1) 获取所有账户 ID）
    let accountIds = await client.smembers(RedisClient.CLAUDE_ACCOUNT_INDEX)

    // 如果索引为空，回退到 SCAN 并重建索引
    if (!accountIds || accountIds.length === 0) {
      const keys = await this.scanKeys('claude:account:*')
      accountIds = keys
        .filter((k) => k !== RedisClient.CLAUDE_ACCOUNT_INDEX)
        .map((k) => k.replace('claude:account:', ''))

      // 重建索引（如果有账户的话）
      if (accountIds.length > 0) {
        await client.sadd(RedisClient.CLAUDE_ACCOUNT_INDEX, ...accountIds)
      }
    }

    // 批量获取账户数据
    const accounts = []
    if (accountIds.length > 0) {
      const pipeline = client.pipeline()
      for (const id of accountIds) {
        pipeline.hgetall(`claude:account:${id}`)
      }
      const results = await pipeline.exec()

      for (let i = 0; i < accountIds.length; i++) {
        const [err, accountData] = results[i]
        if (!err && accountData && Object.keys(accountData).length > 0) {
          accounts.push({ id: accountIds[i], ...accountData })
        }
      }
    }

    return accounts
  }

  async deleteClaudeAccount(accountId) {
    const key = `claude:account:${accountId}`
    const client = this.getClientSafe()
    // 使用 pipeline 原子性删除账户数据和索引
    const pipeline = client.pipeline()
    pipeline.del(key)
    pipeline.srem(RedisClient.CLAUDE_ACCOUNT_INDEX, accountId)
    await pipeline.exec()
  }

  /**
   * 清理账号相关的所有使用统计数据
   * 在删除账号时调用，防止产生孤立数据
   * @param {string} accountId - 账号 ID
   */
  async cleanupAccountUsageData(accountId) {
    const client = this.getClientSafe()

    // 需要清理的数据模式
    const patterns = [
      `account_usage:${accountId}`,
      `account_usage:daily:${accountId}:*`,
      `account_usage:monthly:${accountId}:*`,
      `account_usage:hourly:${accountId}:*`,
      `account_usage:model:daily:${accountId}:*`,
      `account_usage:model:monthly:${accountId}:*`,
      `account_usage:model:hourly:${accountId}:*`
    ]

    // 其他关联数据
    const directKeys = [`account:overload:${accountId}`, `concurrency:${accountId}`]

    let deletedCount = 0

    // 删除直接键
    for (const key of directKeys) {
      const result = await client.del(key)
      deletedCount += result
    }

    // 删除模式匹配的键
    for (const pattern of patterns) {
      if (pattern.includes('*')) {
        const keys = await this.scanKeys(pattern)
        if (keys.length > 0) {
          const result = await client.del(...keys)
          deletedCount += result
        }
      } else {
        const result = await client.del(pattern)
        deletedCount += result
      }
    }

    if (deletedCount > 0) {
      logger.info(`[cleanupAccountUsageData] 已清理账号 ${accountId} 的 ${deletedCount} 个关联数据`)
    }

    return deletedCount
  }

  // 🤖 Droid 账户相关操作
  // 🚀 性能优化：账户索引键（避免 SCAN 操作）
  static DROID_ACCOUNT_INDEX = 'droid:accounts:index'

  async setDroidAccount(accountId, accountData) {
    const key = `droid:account:${accountId}`
    const client = this.getClientSafe()
    // 同时更新账户数据和索引
    await client.hset(key, accountData)
    await client.sadd(RedisClient.DROID_ACCOUNT_INDEX, accountId)
  }

  async getDroidAccount(accountId) {
    const key = `droid:account:${accountId}`
    return await this.client.hgetall(key)
  }

  async getAllDroidAccounts() {
    const client = this.getClientSafe()

    // 🚀 优先使用索引 Set（避免 SCAN 操作）
    let accountIds = await client.smembers(RedisClient.DROID_ACCOUNT_INDEX)

    // 如果索引为空，回退到 SCAN 并重建索引（兼容旧数据）
    if (!accountIds || accountIds.length === 0) {
      const keys = await this.scanKeys('droid:account:*')
      accountIds = keys.map((k) => k.replace('droid:account:', ''))

      // 重建索引
      if (accountIds.length > 0) {
        await client.sadd(RedisClient.DROID_ACCOUNT_INDEX, ...accountIds)
        logger.info(`📋 Rebuilt Droid account index with ${accountIds.length} accounts`)
      }
    }

    // 🚀 批量获取账户数据（使用 Promise.all 并行执行）
    const accounts = []
    const ghostIds = []
    if (accountIds.length > 0) {
      const dataPromises = accountIds.map((id) => client.hgetall(`droid:account:${id}`))
      const results = await Promise.all(dataPromises)

      for (let i = 0; i < accountIds.length; i++) {
        const accountData = results[i]
        if (accountData && Object.keys(accountData).length > 0) {
          accounts.push({ id: accountIds[i], ...accountData })
        } else {
          // 🧹 记录幽灵账户，稍后清理
          ghostIds.push(accountIds[i])
        }
      }

      // 🧹 后台清理幽灵账户索引
      if (ghostIds.length > 0) {
        Promise.all(ghostIds.map((id) => client.srem(RedisClient.DROID_ACCOUNT_INDEX, id))).catch(
          (err) => logger.error('Failed to cleanup Droid ghost accounts:', err)
        )
      }
    }
    return accounts
  }

  async deleteDroidAccount(accountId) {
    const key = `droid:account:${accountId}`
    const client = this.getClientSafe()
    // 同时删除账户数据和索引
    await client.del(key)
    await client.srem(RedisClient.DROID_ACCOUNT_INDEX, accountId)
  }

  // 🚀 性能优化：OpenAI 账户索引键
  static OPENAI_ACCOUNT_INDEX = 'openai:accounts:index'

  async setOpenAiAccount(accountId, accountData) {
    const key = `openai:account:${accountId}`
    const client = this.getClientSafe()
    await client.hset(key, accountData)
    await client.sadd(RedisClient.OPENAI_ACCOUNT_INDEX, accountId)
  }
  async getOpenAiAccount(accountId) {
    const key = `openai:account:${accountId}`
    return await this.client.hgetall(key)
  }
  async deleteOpenAiAccount(accountId) {
    const key = `openai:account:${accountId}`
    const client = this.getClientSafe()
    await client.del(key)
    await client.srem(RedisClient.OPENAI_ACCOUNT_INDEX, accountId)
  }

  async getAllOpenAIAccounts() {
    const client = this.getClientSafe()

    // 🚀 优先使用索引 Set
    let accountIds = await client.smembers(RedisClient.OPENAI_ACCOUNT_INDEX)

    // 如果索引为空，回退到 SCAN 并重建索引
    if (!accountIds || accountIds.length === 0) {
      const keys = await this.scanKeys('openai:account:*')
      accountIds = keys.map((k) => k.replace('openai:account:', ''))

      if (accountIds.length > 0) {
        await client.sadd(RedisClient.OPENAI_ACCOUNT_INDEX, ...accountIds)
        logger.info(`📋 Rebuilt OpenAI account index with ${accountIds.length} accounts`)
      }
    }

    // 🚀 批量获取账户数据（使用 Promise.all 并行执行）
    const accounts = []
    const ghostIds = []
    if (accountIds.length > 0) {
      const dataPromises = accountIds.map((id) => client.hgetall(`openai:account:${id}`))
      const results = await Promise.all(dataPromises)

      for (let i = 0; i < accountIds.length; i++) {
        const accountData = results[i]
        if (accountData && Object.keys(accountData).length > 0) {
          accounts.push({ id: accountIds[i], ...accountData })
        } else {
          // 🧹 记录幽灵账户，稍后清理
          ghostIds.push(accountIds[i])
        }
      }

      // 🧹 后台清理幽灵账户索引
      if (ghostIds.length > 0) {
        Promise.all(ghostIds.map((id) => client.srem(RedisClient.OPENAI_ACCOUNT_INDEX, id))).catch(
          (err) => logger.error('Failed to cleanup OpenAI ghost accounts:', err)
        )
      }
    }
    return accounts
  }

  // 🔐 会话管理（用于管理员登录等）
  async setSession(sessionId, sessionData, ttl = 86400) {
    const key = `session:${sessionId}`
    await this.client.hset(key, sessionData)
    await this.client.expire(key, ttl)
  }

  async getSession(sessionId) {
    const key = `session:${sessionId}`
    return await this.client.hgetall(key)
  }

  async deleteSession(sessionId) {
    const key = `session:${sessionId}`
    return await this.client.del(key)
  }

  // 🗝️ API Key哈希索引管理
  async setApiKeyHash(hashedKey, keyData, ttl = 0) {
    const key = `apikey_hash:${hashedKey}`
    await this.client.hset(key, keyData)
    if (ttl > 0) {
      await this.client.expire(key, ttl)
    }
  }

  async getApiKeyHash(hashedKey) {
    const key = `apikey_hash:${hashedKey}`
    return await this.client.hgetall(key)
  }

  async deleteApiKeyHash(hashedKey) {
    const key = `apikey_hash:${hashedKey}`
    return await this.client.del(key)
  }

  // 🔗 OAuth会话管理
  async setOAuthSession(sessionId, sessionData, ttl = 600) {
    // 10分钟过期
    const key = `oauth:${sessionId}`

    // 序列化复杂对象，特别是 proxy 配置
    const serializedData = {}
    for (const [dataKey, value] of Object.entries(sessionData)) {
      if (typeof value === 'object' && value !== null) {
        serializedData[dataKey] = JSON.stringify(value)
      } else {
        serializedData[dataKey] = value
      }
    }

    await this.client.hset(key, serializedData)
    await this.client.expire(key, ttl)
  }

  async getOAuthSession(sessionId) {
    const key = `oauth:${sessionId}`
    const data = await this.client.hgetall(key)

    // 反序列化 proxy 字段
    if (data.proxy) {
      try {
        data.proxy = JSON.parse(data.proxy)
      } catch (error) {
        // 如果解析失败，设置为 null
        data.proxy = null
      }
    }

    return data
  }

  async deleteOAuthSession(sessionId) {
    const key = `oauth:${sessionId}`
    return await this.client.del(key)
  }

  // 📈 系统统计
  async getSystemStats() {
    const keys = await Promise.all([
      this.scanKeys('apikey:*'),
      this.scanKeys('claude:account:*'),
      this.scanKeys('usage:*')
    ])

    return {
      totalApiKeys: keys[0].length,
      totalClaudeAccounts: keys[1].length,
      totalUsageRecords: keys[2].length
    }
  }

  // 📊 获取今日系统统计
  async getTodayStats() {
    try {
      const today = getDateStringInTimezone()
      const dailyKeys = await this.scanKeys(`usage:daily:*:${today}`)

      let totalRequestsToday = 0
      let totalTokensToday = 0
      let totalInputTokensToday = 0
      let totalOutputTokensToday = 0
      let totalCacheCreateTokensToday = 0
      let totalCacheReadTokensToday = 0

      // 批量获取所有今日数据，提高性能
      if (dailyKeys.length > 0) {
        const pipeline = this.client.pipeline()
        dailyKeys.forEach((key) => pipeline.hgetall(key))
        const results = await pipeline.exec()

        for (const [error, dailyData] of results) {
          if (error || !dailyData) {
            continue
          }

          totalRequestsToday += parseInt(dailyData.requests) || 0
          const currentDayTokens = parseInt(dailyData.tokens) || 0
          totalTokensToday += currentDayTokens

          // 处理旧数据兼容性：如果有总token但没有输入输出分离，则使用总token作为输出token
          const inputTokens = parseInt(dailyData.inputTokens) || 0
          const outputTokens = parseInt(dailyData.outputTokens) || 0
          const cacheCreateTokens = parseInt(dailyData.cacheCreateTokens) || 0
          const cacheReadTokens = parseInt(dailyData.cacheReadTokens) || 0
          const totalTokensFromSeparate = inputTokens + outputTokens

          if (totalTokensFromSeparate === 0 && currentDayTokens > 0) {
            // 旧数据：没有输入输出分离，假设70%为输出，30%为输入（基于一般对话比例）
            totalOutputTokensToday += Math.round(currentDayTokens * 0.7)
            totalInputTokensToday += Math.round(currentDayTokens * 0.3)
          } else {
            // 新数据：使用实际的输入输出分离
            totalInputTokensToday += inputTokens
            totalOutputTokensToday += outputTokens
          }

          // 添加cache token统计
          totalCacheCreateTokensToday += cacheCreateTokens
          totalCacheReadTokensToday += cacheReadTokens
        }
      }

      // 获取今日创建的API Key数量（批量优化）
      const allApiKeys = await this.scanKeys('apikey:*')
      let apiKeysCreatedToday = 0

      if (allApiKeys.length > 0) {
        const pipeline = this.client.pipeline()
        allApiKeys.forEach((key) => pipeline.hget(key, 'createdAt'))
        const results = await pipeline.exec()

        for (const [error, createdAt] of results) {
          if (!error && createdAt && createdAt.startsWith(today)) {
            apiKeysCreatedToday++
          }
        }
      }

      return {
        requestsToday: totalRequestsToday,
        tokensToday: totalTokensToday,
        inputTokensToday: totalInputTokensToday,
        outputTokensToday: totalOutputTokensToday,
        cacheCreateTokensToday: totalCacheCreateTokensToday,
        cacheReadTokensToday: totalCacheReadTokensToday,
        apiKeysCreatedToday
      }
    } catch (error) {
      console.error('Error getting today stats:', error)
      return {
        requestsToday: 0,
        tokensToday: 0,
        inputTokensToday: 0,
        outputTokensToday: 0,
        cacheCreateTokensToday: 0,
        cacheReadTokensToday: 0,
        apiKeysCreatedToday: 0
      }
    }
  }

  // 📈 获取系统总的平均RPM和TPM
  async getSystemAverages() {
    try {
      const allApiKeys = await this.scanKeys('apikey:*')
      let totalRequests = 0
      let totalTokens = 0
      let totalInputTokens = 0
      let totalOutputTokens = 0
      let oldestCreatedAt = new Date()

      // 批量获取所有usage数据和key数据，提高性能
      const usageKeys = allApiKeys.map((key) => `usage:${key.replace('apikey:', '')}`)
      const pipeline = this.client.pipeline()

      // 添加所有usage查询
      usageKeys.forEach((key) => pipeline.hgetall(key))
      // 添加所有key数据查询
      allApiKeys.forEach((key) => pipeline.hgetall(key))

      const results = await pipeline.exec()
      const usageResults = results.slice(0, usageKeys.length)
      const keyResults = results.slice(usageKeys.length)

      for (let i = 0; i < allApiKeys.length; i++) {
        const totalData = usageResults[i][1] || {}
        const keyData = keyResults[i][1] || {}

        totalRequests += parseInt(totalData.totalRequests) || 0
        totalTokens += parseInt(totalData.totalTokens) || 0
        totalInputTokens += parseInt(totalData.totalInputTokens) || 0
        totalOutputTokens += parseInt(totalData.totalOutputTokens) || 0

        const createdAt = keyData.createdAt ? new Date(keyData.createdAt) : new Date()
        if (createdAt < oldestCreatedAt) {
          oldestCreatedAt = createdAt
        }
      }

      const now = new Date()
      // 保持与个人API Key计算一致的算法：按天计算然后转换为分钟
      const daysSinceOldest = Math.max(
        1,
        Math.ceil((now - oldestCreatedAt) / (1000 * 60 * 60 * 24))
      )
      const totalMinutes = daysSinceOldest * 24 * 60

      return {
        systemRPM: Math.round((totalRequests / totalMinutes) * 100) / 100,
        systemTPM: Math.round((totalTokens / totalMinutes) * 100) / 100,
        totalInputTokens,
        totalOutputTokens,
        totalTokens
      }
    } catch (error) {
      console.error('Error getting system averages:', error)
      return {
        systemRPM: 0,
        systemTPM: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0
      }
    }
  }

  // 📊 获取实时系统指标（基于滑动窗口）
  async getRealtimeSystemMetrics() {
    try {
      const configLocal = require('../../config/config')
      const windowMinutes = configLocal.system.metricsWindow || 5

      const now = new Date()
      const currentMinute = Math.floor(now.getTime() / 60000)

      // 调试：打印当前时间和分钟时间戳
      logger.debug(
        `🔍 Realtime metrics - Current time: ${now.toISOString()}, Minute timestamp: ${currentMinute}`
      )

      // 使用Pipeline批量获取窗口内的所有分钟数据
      const pipeline = this.client.pipeline()
      const minuteKeys = []
      for (let i = 0; i < windowMinutes; i++) {
        const minuteKey = `system:metrics:minute:${currentMinute - i}`
        minuteKeys.push(minuteKey)
        pipeline.hgetall(minuteKey)
      }

      logger.debug(`🔍 Realtime metrics - Checking keys: ${minuteKeys.join(', ')}`)

      const results = await pipeline.exec()

      // 聚合计算
      let totalRequests = 0
      let totalTokens = 0
      let totalInputTokens = 0
      let totalOutputTokens = 0
      let totalCacheCreateTokens = 0
      let totalCacheReadTokens = 0
      let validDataCount = 0

      results.forEach(([err, data], index) => {
        if (!err && data && Object.keys(data).length > 0) {
          validDataCount++
          totalRequests += parseInt(data.requests || 0)
          totalTokens += parseInt(data.totalTokens || 0)
          totalInputTokens += parseInt(data.inputTokens || 0)
          totalOutputTokens += parseInt(data.outputTokens || 0)
          totalCacheCreateTokens += parseInt(data.cacheCreateTokens || 0)
          totalCacheReadTokens += parseInt(data.cacheReadTokens || 0)

          logger.debug(`🔍 Realtime metrics - Key ${minuteKeys[index]} data:`, {
            requests: data.requests,
            totalTokens: data.totalTokens
          })
        }
      })

      logger.debug(
        `🔍 Realtime metrics - Valid data count: ${validDataCount}/${windowMinutes}, Total requests: ${totalRequests}, Total tokens: ${totalTokens}`
      )

      // 计算平均值（每分钟）
      const realtimeRPM =
        windowMinutes > 0 ? Math.round((totalRequests / windowMinutes) * 100) / 100 : 0
      const realtimeTPM =
        windowMinutes > 0 ? Math.round((totalTokens / windowMinutes) * 100) / 100 : 0

      const result = {
        realtimeRPM,
        realtimeTPM,
        windowMinutes,
        totalRequests,
        totalTokens,
        totalInputTokens,
        totalOutputTokens,
        totalCacheCreateTokens,
        totalCacheReadTokens
      }

      logger.debug('🔍 Realtime metrics - Final result:', result)

      return result
    } catch (error) {
      console.error('Error getting realtime system metrics:', error)
      // 如果出错，返回历史平均值作为降级方案
      const historicalMetrics = await this.getSystemAverages()
      return {
        realtimeRPM: historicalMetrics.systemRPM,
        realtimeTPM: historicalMetrics.systemTPM,
        windowMinutes: 0, // 标识使用了历史数据
        totalRequests: 0,
        totalTokens: historicalMetrics.totalTokens,
        totalInputTokens: historicalMetrics.totalInputTokens,
        totalOutputTokens: historicalMetrics.totalOutputTokens,
        totalCacheCreateTokens: 0,
        totalCacheReadTokens: 0
      }
    }
  }

  // 🔗 会话sticky映射管理
  async setSessionAccountMapping(sessionHash, accountId, ttl = null) {
    const appConfig = require('../../config/config')
    // 从配置读取TTL（小时），转换为秒，默认1小时
    const defaultTTL = ttl !== null ? ttl : (appConfig.session?.stickyTtlHours || 1) * 60 * 60
    const key = `sticky_session:${sessionHash}`
    await this.client.set(key, accountId, 'EX', defaultTTL)
  }

  async getSessionAccountMapping(sessionHash) {
    const key = `sticky_session:${sessionHash}`
    return await this.client.get(key)
  }

  // 🚀 智能会话TTL续期：剩余时间少于阈值时自动续期
  async extendSessionAccountMappingTTL(sessionHash) {
    const appConfig = require('../../config/config')
    const key = `sticky_session:${sessionHash}`

    // 📊 从配置获取参数
    const ttlHours = appConfig.session?.stickyTtlHours || 1 // 小时，默认1小时
    const thresholdMinutes = appConfig.session?.renewalThresholdMinutes || 0 // 分钟，默认0（不续期）

    // 如果阈值为0，不执行续期
    if (thresholdMinutes === 0) {
      return true
    }

    const fullTTL = ttlHours * 60 * 60 // 转换为秒
    const renewalThreshold = thresholdMinutes * 60 // 转换为秒

    try {
      // 获取当前剩余TTL（秒）
      const remainingTTL = await this.client.ttl(key)

      // 键不存在或已过期
      if (remainingTTL === -2) {
        return false
      }

      // 键存在但没有TTL（永不过期，不需要处理）
      if (remainingTTL === -1) {
        return true
      }

      // 🎯 智能续期策略：仅在剩余时间少于阈值时才续期
      if (remainingTTL < renewalThreshold) {
        await this.client.expire(key, fullTTL)
        logger.debug(
          `🔄 Renewed sticky session TTL: ${sessionHash} (was ${Math.round(
            remainingTTL / 60
          )}min, renewed to ${ttlHours}h)`
        )
        return true
      }

      // 剩余时间充足，无需续期
      logger.debug(
        `✅ Sticky session TTL sufficient: ${sessionHash} (remaining ${Math.round(
          remainingTTL / 60
        )}min)`
      )
      return true
    } catch (error) {
      logger.error('❌ Failed to extend session TTL:', error)
      return false
    }
  }

  async deleteSessionAccountMapping(sessionHash) {
    const key = `sticky_session:${sessionHash}`
    return await this.client.del(key)
  }

  // 🧹 清理过期数据
  async cleanup() {
    try {
      const patterns = ['usage:daily:*', 'ratelimit:*', 'session:*', 'sticky_session:*', 'oauth:*']

      for (const pattern of patterns) {
        const keys = await this.scanKeys(pattern)
        const pipeline = this.client.pipeline()

        for (const key of keys) {
          const ttl = await this.client.ttl(key)
          if (ttl === -1) {
            // 没有设置过期时间的键
            if (key.startsWith('oauth:')) {
              pipeline.expire(key, 600) // OAuth会话设置10分钟过期
            } else {
              pipeline.expire(key, 86400) // 其他设置1天过期
            }
          }
        }

        await pipeline.exec()
      }

      logger.info('🧹 Redis cleanup completed')
    } catch (error) {
      logger.error('❌ Redis cleanup failed:', error)
    }
  }

  // 获取并发配置
  _getConcurrencyConfig() {
    const defaults = {
      leaseSeconds: 300,
      renewIntervalSeconds: 30,
      cleanupGraceSeconds: 30
    }

    const configValues = {
      ...defaults,
      ...(config.concurrency || {})
    }

    const normalizeNumber = (value, fallback, options = {}) => {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) {
        return fallback
      }

      if (options.allowZero && parsed === 0) {
        return 0
      }

      if (options.min !== undefined && parsed < options.min) {
        return options.min
      }

      return parsed
    }

    return {
      leaseSeconds: normalizeNumber(configValues.leaseSeconds, defaults.leaseSeconds, {
        min: 30
      }),
      renewIntervalSeconds: normalizeNumber(
        configValues.renewIntervalSeconds,
        defaults.renewIntervalSeconds,
        {
          allowZero: true,
          min: 0
        }
      ),
      cleanupGraceSeconds: normalizeNumber(
        configValues.cleanupGraceSeconds,
        defaults.cleanupGraceSeconds,
        {
          min: 0
        }
      )
    }
  }

  // 增加并发计数（基于租约的有序集合）
  async incrConcurrency(apiKeyId, requestId, leaseSeconds = null) {
    if (!requestId) {
      throw new Error('Request ID is required for concurrency tracking')
    }

    try {
      const { leaseSeconds: defaultLeaseSeconds, cleanupGraceSeconds } =
        this._getConcurrencyConfig()
      const lease = leaseSeconds || defaultLeaseSeconds
      const key = `concurrency:${apiKeyId}`
      const now = Date.now()
      const expireAt = now + lease * 1000
      const ttl = Math.max((lease + cleanupGraceSeconds) * 1000, 60000)

      const luaScript = `
        local key = KEYS[1]
        local member = ARGV[1]
        local expireAt = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local ttl = tonumber(ARGV[4])

        redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
        redis.call('ZADD', key, expireAt, member)

        if ttl > 0 then
          redis.call('PEXPIRE', key, ttl)
        end

        local count = redis.call('ZCARD', key)
        return count
      `

      const count = await this.client.eval(luaScript, 1, key, requestId, expireAt, now, ttl)
      logger.database(
        `🔢 Incremented concurrency for key ${apiKeyId}: ${count} (request ${requestId})`
      )
      return count
    } catch (error) {
      logger.error('❌ Failed to increment concurrency:', error)
      throw error
    }
  }

  // 刷新并发租约，防止长连接提前过期
  async refreshConcurrencyLease(apiKeyId, requestId, leaseSeconds = null) {
    if (!requestId) {
      return 0
    }

    try {
      const { leaseSeconds: defaultLeaseSeconds, cleanupGraceSeconds } =
        this._getConcurrencyConfig()
      const lease = leaseSeconds || defaultLeaseSeconds
      const key = `concurrency:${apiKeyId}`
      const now = Date.now()
      const expireAt = now + lease * 1000
      const ttl = Math.max((lease + cleanupGraceSeconds) * 1000, 60000)

      const luaScript = `
        local key = KEYS[1]
        local member = ARGV[1]
        local expireAt = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local ttl = tonumber(ARGV[4])

        redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

        local exists = redis.call('ZSCORE', key, member)

        if exists then
          redis.call('ZADD', key, expireAt, member)
          if ttl > 0 then
            redis.call('PEXPIRE', key, ttl)
          end
          return 1
        end

        return 0
      `

      const refreshed = await this.client.eval(luaScript, 1, key, requestId, expireAt, now, ttl)
      if (refreshed === 1) {
        logger.debug(`🔄 Refreshed concurrency lease for key ${apiKeyId} (request ${requestId})`)
      }
      return refreshed
    } catch (error) {
      logger.error('❌ Failed to refresh concurrency lease:', error)
      return 0
    }
  }

  // 减少并发计数
  async decrConcurrency(apiKeyId, requestId) {
    try {
      const key = `concurrency:${apiKeyId}`
      const now = Date.now()

      const luaScript = `
        local key = KEYS[1]
        local member = ARGV[1]
        local now = tonumber(ARGV[2])

        if member then
          redis.call('ZREM', key, member)
        end

        redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

        local count = redis.call('ZCARD', key)
        if count <= 0 then
          redis.call('DEL', key)
          return 0
        end

        return count
      `

      const count = await this.client.eval(luaScript, 1, key, requestId || '', now)
      logger.database(
        `🔢 Decremented concurrency for key ${apiKeyId}: ${count} (request ${requestId || 'n/a'})`
      )
      return count
    } catch (error) {
      logger.error('❌ Failed to decrement concurrency:', error)
      throw error
    }
  }

  // 获取当前并发数
  async getConcurrency(apiKeyId) {
    try {
      const key = `concurrency:${apiKeyId}`
      const now = Date.now()

      const luaScript = `
        local key = KEYS[1]
        local now = tonumber(ARGV[1])

        redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
        return redis.call('ZCARD', key)
      `

      const count = await this.client.eval(luaScript, 1, key, now)
      return parseInt(count || 0)
    } catch (error) {
      logger.error('❌ Failed to get concurrency:', error)
      return 0
    }
  }

  // 🏢 Claude Console 账户并发控制（复用现有并发机制）
  // 增加 Console 账户并发计数
  async incrConsoleAccountConcurrency(accountId, requestId, leaseSeconds = null) {
    if (!requestId) {
      throw new Error('Request ID is required for console account concurrency tracking')
    }
    // 使用特殊的 key 前缀区分 Console 账户并发
    const compositeKey = `console_account:${accountId}`
    return await this.incrConcurrency(compositeKey, requestId, leaseSeconds)
  }

  // 刷新 Console 账户并发租约
  async refreshConsoleAccountConcurrencyLease(accountId, requestId, leaseSeconds = null) {
    if (!requestId) {
      return 0
    }
    const compositeKey = `console_account:${accountId}`
    return await this.refreshConcurrencyLease(compositeKey, requestId, leaseSeconds)
  }

  // 减少 Console 账户并发计数
  async decrConsoleAccountConcurrency(accountId, requestId) {
    const compositeKey = `console_account:${accountId}`
    return await this.decrConcurrency(compositeKey, requestId)
  }

  // 获取 Console 账户当前并发数
  async getConsoleAccountConcurrency(accountId) {
    const compositeKey = `console_account:${accountId}`
    return await this.getConcurrency(compositeKey)
  }

  // 🔧 Basic Redis operations wrapper methods for convenience
  async get(key) {
    const client = this.getClientSafe()
    return await client.get(key)
  }

  async set(key, value, ...args) {
    const client = this.getClientSafe()
    return await client.set(key, value, ...args)
  }

  async setex(key, ttl, value) {
    const client = this.getClientSafe()
    return await client.setex(key, ttl, value)
  }

  async del(...keys) {
    const client = this.getClientSafe()
    return await client.del(...keys)
  }

  async keys(pattern) {
    // 使用 scanKeys 替代 KEYS 命令（兼容 AWS Valkey）
    return await this.scanKeys(pattern)
  }

  // 📊 获取账户会话窗口内的使用统计（包含模型细分）
  async getAccountSessionWindowUsage(accountId, windowStart, windowEnd) {
    try {
      if (!windowStart || !windowEnd) {
        return {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreateTokens: 0,
          totalCacheReadTokens: 0,
          totalAllTokens: 0,
          totalRequests: 0,
          modelUsage: {}
        }
      }

      const startDate = new Date(windowStart)
      const endDate = new Date(windowEnd)

      // 添加日志以调试时间窗口
      logger.debug(`📊 Getting session window usage for account ${accountId}`)
      logger.debug(`   Window: ${windowStart} to ${windowEnd}`)
      logger.debug(`   Start UTC: ${startDate.toISOString()}, End UTC: ${endDate.toISOString()}`)

      // 获取窗口内所有可能的小时键
      // 重要：需要使用配置的时区来构建键名，因为数据存储时使用的是配置时区
      const hourlyKeys = []
      const currentHour = new Date(startDate)
      currentHour.setMinutes(0)
      currentHour.setSeconds(0)
      currentHour.setMilliseconds(0)

      while (currentHour <= endDate) {
        // 使用时区转换函数来获取正确的日期和小时
        const tzDateStr = getDateStringInTimezone(currentHour)
        const tzHour = String(getHourInTimezone(currentHour)).padStart(2, '0')
        const key = `account_usage:hourly:${accountId}:${tzDateStr}:${tzHour}`

        logger.debug(`   Adding hourly key: ${key}`)
        hourlyKeys.push(key)
        currentHour.setHours(currentHour.getHours() + 1)
      }

      // 批量获取所有小时的数据
      const pipeline = this.client.pipeline()
      for (const key of hourlyKeys) {
        pipeline.hgetall(key)
      }
      const results = await pipeline.exec()

      // 聚合所有数据
      let totalInputTokens = 0
      let totalOutputTokens = 0
      let totalCacheCreateTokens = 0
      let totalCacheReadTokens = 0
      let totalAllTokens = 0
      let totalRequests = 0
      const modelUsage = {}

      logger.debug(`   Processing ${results.length} hourly results`)

      for (const [error, data] of results) {
        if (error || !data || Object.keys(data).length === 0) {
          continue
        }

        // 处理总计数据
        const hourInputTokens = parseInt(data.inputTokens || 0)
        const hourOutputTokens = parseInt(data.outputTokens || 0)
        const hourCacheCreateTokens = parseInt(data.cacheCreateTokens || 0)
        const hourCacheReadTokens = parseInt(data.cacheReadTokens || 0)
        const hourAllTokens = parseInt(data.allTokens || 0)
        const hourRequests = parseInt(data.requests || 0)

        totalInputTokens += hourInputTokens
        totalOutputTokens += hourOutputTokens
        totalCacheCreateTokens += hourCacheCreateTokens
        totalCacheReadTokens += hourCacheReadTokens
        totalAllTokens += hourAllTokens
        totalRequests += hourRequests

        if (hourAllTokens > 0) {
          logger.debug(`   Hour data: allTokens=${hourAllTokens}, requests=${hourRequests}`)
        }

        // 处理每个模型的数据
        for (const [key, value] of Object.entries(data)) {
          // 查找模型相关的键（格式: model:{modelName}:{metric}）
          if (key.startsWith('model:')) {
            const parts = key.split(':')
            if (parts.length >= 3) {
              const modelName = parts[1]
              const metric = parts.slice(2).join(':')

              if (!modelUsage[modelName]) {
                modelUsage[modelName] = {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheCreateTokens: 0,
                  cacheReadTokens: 0,
                  allTokens: 0,
                  requests: 0
                }
              }

              if (metric === 'inputTokens') {
                modelUsage[modelName].inputTokens += parseInt(value || 0)
              } else if (metric === 'outputTokens') {
                modelUsage[modelName].outputTokens += parseInt(value || 0)
              } else if (metric === 'cacheCreateTokens') {
                modelUsage[modelName].cacheCreateTokens += parseInt(value || 0)
              } else if (metric === 'cacheReadTokens') {
                modelUsage[modelName].cacheReadTokens += parseInt(value || 0)
              } else if (metric === 'allTokens') {
                modelUsage[modelName].allTokens += parseInt(value || 0)
              } else if (metric === 'requests') {
                modelUsage[modelName].requests += parseInt(value || 0)
              }
            }
          }
        }
      }

      logger.debug(`📊 Session window usage summary:`)
      logger.debug(`   Total allTokens: ${totalAllTokens}`)
      logger.debug(`   Total requests: ${totalRequests}`)
      logger.debug(`   Input: ${totalInputTokens}, Output: ${totalOutputTokens}`)
      logger.debug(
        `   Cache Create: ${totalCacheCreateTokens}, Cache Read: ${totalCacheReadTokens}`
      )

      return {
        totalInputTokens,
        totalOutputTokens,
        totalCacheCreateTokens,
        totalCacheReadTokens,
        totalAllTokens,
        totalRequests,
        modelUsage
      }
    } catch (error) {
      logger.error(`❌ Failed to get session window usage for account ${accountId}:`, error)
      return {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreateTokens: 0,
        totalCacheReadTokens: 0,
        totalAllTokens: 0,
        totalRequests: 0,
        modelUsage: {}
      }
    }
  }

  // ============================================================================
  // 💰 账户余额管理方法
  // ============================================================================

  // 账户余额缓存（API 查询结果）
  async setAccountBalance(platform, accountId, balanceData, ttl = 3600) {
    const key = `account_balance:${platform}:${accountId}`

    const payload = {
      balance:
        balanceData && balanceData.balance !== null && balanceData.balance !== undefined
          ? String(balanceData.balance)
          : '',
      currency: balanceData?.currency || 'USD',
      lastRefreshAt: balanceData?.lastRefreshAt || new Date().toISOString(),
      queryMethod: balanceData?.queryMethod || 'api',
      status: balanceData?.status || 'success',
      errorMessage: balanceData?.errorMessage || balanceData?.error || '',
      rawData: balanceData?.rawData ? JSON.stringify(balanceData.rawData) : '',
      quota: balanceData?.quota ? JSON.stringify(balanceData.quota) : ''
    }

    await this.client.hset(key, payload)
    await this.client.expire(key, ttl)
  }

  async getAccountBalance(platform, accountId) {
    const key = `account_balance:${platform}:${accountId}`
    const [data, ttlSeconds] = await Promise.all([this.client.hgetall(key), this.client.ttl(key)])

    if (!data || Object.keys(data).length === 0) {
      return null
    }

    let rawData = null
    if (data.rawData) {
      try {
        rawData = JSON.parse(data.rawData)
      } catch (error) {
        rawData = null
      }
    }

    let quota = null
    if (data.quota) {
      try {
        quota = JSON.parse(data.quota)
      } catch (error) {
        quota = null
      }
    }

    return {
      balance: data.balance ? parseFloat(data.balance) : null,
      currency: data.currency || 'USD',
      lastRefreshAt: data.lastRefreshAt || null,
      queryMethod: data.queryMethod || null,
      status: data.status || null,
      errorMessage: data.errorMessage || '',
      rawData,
      quota,
      ttlSeconds: Number.isFinite(ttlSeconds) ? ttlSeconds : null
    }
  }

  // 账户余额缓存（本地统计）
  async setLocalBalance(platform, accountId, statisticsData, ttl = 300) {
    const key = `account_balance_local:${platform}:${accountId}`

    await this.client.hset(key, {
      estimatedBalance: JSON.stringify(statisticsData || {}),
      lastCalculated: new Date().toISOString()
    })
    await this.client.expire(key, ttl)
  }

  async getLocalBalance(platform, accountId) {
    const key = `account_balance_local:${platform}:${accountId}`
    const data = await this.client.hgetall(key)

    if (!data || !data.estimatedBalance) {
      return null
    }

    try {
      return JSON.parse(data.estimatedBalance)
    } catch (error) {
      return null
    }
  }

  async deleteAccountBalance(platform, accountId) {
    const key = `account_balance:${platform}:${accountId}`
    const localKey = `account_balance_local:${platform}:${accountId}`
    await this.client.del(key, localKey)
  }

  // 账户余额脚本配置
  async setBalanceScriptConfig(platform, accountId, scriptConfig) {
    const key = `account_balance_script:${platform}:${accountId}`
    await this.client.set(key, JSON.stringify(scriptConfig || {}))
  }

  async getBalanceScriptConfig(platform, accountId) {
    const key = `account_balance_script:${platform}:${accountId}`
    const raw = await this.client.get(key)
    if (!raw) {
      return null
    }
    try {
      return JSON.parse(raw)
    } catch (error) {
      return null
    }
  }

  // ==================== Account Test Configuration ====================
  // 保存账户测试配置
  async saveAccountTestConfig(accountId, platform, testConfig) {
    const key = `account:test_config:${platform}:${accountId}`

    // 向后兼容：如果旧配置有 testHour 字段，转换为 cron 表达式
    if (testConfig.testHour !== undefined && !testConfig.cronExpression) {
      const hour = parseInt(testConfig.testHour, 10)
      if (hour >= 0 && hour < 24) {
        testConfig.cronExpression = `0 ${hour} * * *` // 每天指定小时执行
      }
    }

    // 设置默认值
    const configData = {
      enabled: testConfig.enabled !== undefined ? testConfig.enabled : false,
      cronExpression: testConfig.cronExpression || testConfig.testSchedule || '* * * * *', // 默认每天8点
      model: testConfig.model || 'claude-haiku-4-5-20251001',
      createdAt: testConfig.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    // 修复：将对象转换为键值对数组，Redis Hash 需要存储字符串
    const fieldValuePairs = []
    for (const [field, value] of Object.entries(configData)) {
      fieldValuePairs.push(field, String(value))
    }

    await this.client.hset(key, ...fieldValuePairs)

    // 添加日志确认保存成功
    logger.info(`✅ Saved test config for ${platform} account ${accountId}`, {
      key,
      configData
    })

    return configData
  }

  // 获取账户测试配置
  async getAccountTestConfig(accountId, platform) {
    const key = `account:test_config:${platform}:${accountId}`
    const configData = await this.client.hgetall(key)

    logger.info(`🔍 getAccountTestConfig - Key: ${key}`, {
      accountId,
      platform,
      configDataKeys: Object.keys(configData || {}),
      rawEnabled: configData?.enabled,
      rawEnabledType: typeof configData?.enabled
    })

    if (!configData || Object.keys(configData).length === 0) {
      logger.warn(`⚠️  No test config found for ${platform}:${accountId}, returning defaults`)
      // 返回默认配置
      return {
        enabled: false,
        cronExpression: '* * * * *',
        model: 'claude-haiku-4-5-20251001'
      }
    }

    // 转换 enabled 字符串为布尔值
    const result = {
      ...configData,
      enabled: configData.enabled === 'true' || configData.enabled === true
    }

    logger.info(`✅ Loaded test config for ${platform}:${accountId}`, {
      enabled: result.enabled,
      cronExpression: result.cronExpression,
      model: result.model
    })

    return result
  }

  // 获取所有启用测试的账户
  async getEnabledTestAccounts(platform) {
    const pattern = `account:test_config:${platform}:*`
    const keys = await this.scanKeys(pattern)

    const enabledAccounts = []

    for (const key of keys) {
      const configData = await this.client.hgetall(key)
      if (configData && (configData.enabled === 'true' || configData.enabled === true)) {
        // 从 key 中提取 accountId: account:test_config:platform:accountId
        const accountId = key.split(':').slice(3).join(':')
        enabledAccounts.push({
          accountId,
          platform,
          config: {
            ...configData,
            enabled: true
          }
        })
      }
    }

    return enabledAccounts
  }

  // 保存测试结果
  async saveAccountTestResult(accountId, platform, result) {
    const key = `account:test_result:${platform}:${accountId}`
    const resultData = {
      timestamp: result.timestamp || new Date().toISOString(),
      success: result.success,
      error: result.error || '',
      duration: result.duration || 0,
      usage: JSON.stringify(result.usage || {})
    }

    // 使用 LPUSH 添加到列表头部（最新的结果在前面）
    await this.client.lpush(key, JSON.stringify(resultData))

    // 限制列表长度，只保留最近100条结果
    await this.client.ltrim(key, 0, 99)

    return resultData
  }

  // 获取测试历史
  async getAccountTestResults(accountId, platform, limit = 10) {
    const key = `account:test_result:${platform}:${accountId}`

    // 获取最近的测试结果
    const results = await this.client.lrange(key, 0, limit - 1)

    return results
      .map((item) => {
        try {
          const parsed = JSON.parse(item)
          return {
            ...parsed,
            usage: parsed.usage ? JSON.parse(parsed.usage) : {}
          }
        } catch (error) {
          logger.error('Failed to parse test result:', error)
          return null
        }
      })
      .filter((item) => item !== null)
  }

  // 设置最后测试时间
  async setAccountLastTestTime(accountId, platform, timestamp) {
    const key = `account:last_test:${platform}:${accountId}`
    await this.client.set(key, timestamp || new Date().toISOString())
  }

  // 获取最后测试时间
  async getAccountLastTestTime(accountId, platform) {
    const key = `account:last_test:${platform}:${accountId}`
    return await this.client.get(key)
  }

  // 删除账户测试配置（当账户被删除时调用）
  async deleteAccountTestConfig(accountId, platform) {
    const configKey = `account:test_config:${platform}:${accountId}`
    const resultKey = `account:test_result:${platform}:${accountId}`
    const lastTestKey = `account:last_test:${platform}:${accountId}`

    await this.client.del(configKey, resultKey, lastTestKey)
  }
}

const redisClient = new RedisClient()

// 分布式锁相关方法
redisClient.setAccountLock = async function (lockKey, lockValue, ttlMs) {
  try {
    // 使用SET NX PX实现原子性的锁获取
    // ioredis语法: set(key, value, 'PX', milliseconds, 'NX')
    const result = await this.client.set(lockKey, lockValue, 'PX', ttlMs, 'NX')
    return result === 'OK'
  } catch (error) {
    logger.error(`Failed to acquire lock ${lockKey}:`, error)
    return false
  }
}

redisClient.releaseAccountLock = async function (lockKey, lockValue) {
  try {
    // 使用Lua脚本确保只有持有锁的进程才能释放锁
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `
    // ioredis语法: eval(script, numberOfKeys, key1, key2, ..., arg1, arg2, ...)
    const result = await this.client.eval(script, 1, lockKey, lockValue)
    return result === 1
  } catch (error) {
    logger.error(`Failed to release lock ${lockKey}:`, error)
    return false
  }
}

// 📊 获取/保存系统级服务倍率配置（Service Multiplier）
redisClient.getServiceRatesConfig = async function () {
  try {
    const data = await this.client.hgetall('system:service_rates')
    if (!data || Object.keys(data).length === 0) {
      return null
    }
    let rates = {}
    if (data.rates) {
      try {
        rates = JSON.parse(data.rates) || {}
      } catch (e) {
        logger.warn(`⚠️ Failed to parse system:service_rates rates field: ${e.message}`)
        rates = {}
      }
    }
    return {
      rates,
      baseService: data.baseService || null,
      updatedAt: data.updatedAt || null,
      updatedBy: data.updatedBy || null
    }
  } catch (error) {
    logger.error('Failed to read system:service_rates:', error)
    throw error
  }
}

redisClient.setServiceRatesConfig = async function (configToSave) {
  if (!configToSave || typeof configToSave !== 'object') {
    throw new Error('config must be an object')
  }
  const payload = {
    rates: JSON.stringify(configToSave.rates || {}),
    baseService: configToSave.baseService || '',
    updatedAt: configToSave.updatedAt || '',
    updatedBy: configToSave.updatedBy || ''
  }
  await this.client.hset('system:service_rates', payload)
}

// 导出时区辅助函数
redisClient.getDateInTimezone = getDateInTimezone
redisClient.getDateStringInTimezone = getDateStringInTimezone
redisClient.getHourInTimezone = getHourInTimezone
redisClient.getWeekStringInTimezone = getWeekStringInTimezone

module.exports = redisClient
