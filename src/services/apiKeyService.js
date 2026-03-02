const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const config = require('../../config/config')
const redis = require('../models/redis')
const logger = require('../utils/logger')

const ACCOUNT_TYPE_CONFIG = {
  claude: { prefix: 'claude:account:' },
  'claude-console': { prefix: 'claude_console_account:' },
  openai: { prefix: 'openai:account:' },
  'openai-responses': { prefix: 'openai_responses_account:' },
  'azure-openai': { prefix: 'azure_openai:account:' },
  gemini: { prefix: 'gemini_account:' },
  'gemini-api': { prefix: 'gemini_api_account:' },
  droid: { prefix: 'droid:account:' }
}

const ACCOUNT_TYPE_PRIORITY = [
  'openai',
  'openai-responses',
  'azure-openai',
  'claude',
  'claude-console',
  'gemini',
  'gemini-api',
  'droid'
]

const ACCOUNT_CATEGORY_MAP = {
  claude: 'claude',
  'claude-console': 'claude',
  openai: 'openai',
  'openai-responses': 'openai',
  'azure-openai': 'openai',
  gemini: 'gemini',
  'gemini-api': 'gemini',
  droid: 'droid'
}

/**
 * 规范化权限数据，兼容旧格式（字符串）和新格式（数组）
 * @param {string|array} permissions - 权限数据
 * @returns {array} - 权限数组，空数组表示全部服务
 */
function normalizePermissions(permissions) {
  if (!permissions) {
    return []
  } // 空 = 全部服务
  if (Array.isArray(permissions)) {
    return permissions
  }
  // 尝试解析 JSON 字符串（新格式存储）
  if (typeof permissions === 'string') {
    if (permissions.startsWith('[')) {
      try {
        const parsed = JSON.parse(permissions)
        if (Array.isArray(parsed)) {
          return parsed
        }
      } catch (e) {
        // 解析失败，继续处理为普通字符串
      }
    }
    // 旧格式 'all' 转为空数组
    if (permissions === 'all') {
      return []
    }
    // 旧单个字符串转为数组
    return [permissions]
  }
  return []
}

/**
 * 检查是否有访问特定服务的权限
 * @param {string|array} permissions - 权限数据
 * @param {string} service - 服务名称（claude/gemini/openai/droid）
 * @returns {boolean} - 是否有权限
 */
function hasPermission(permissions, service) {
  const perms = normalizePermissions(permissions)
  return perms.length === 0 || perms.includes(service) // 空数组 = 全部服务
}

function normalizeAccountTypeKey(type) {
  if (!type) {
    return null
  }
  const lower = String(type).toLowerCase()
  if (lower === 'claude_console') {
    return 'claude-console'
  }
  if (lower === 'openai_responses' || lower === 'openai-response' || lower === 'openai-responses') {
    return 'openai-responses'
  }
  if (lower === 'azure_openai' || lower === 'azureopenai' || lower === 'azure-openai') {
    return 'azure-openai'
  }
  if (lower === 'gemini_api' || lower === 'gemini-api') {
    return 'gemini-api'
  }
  return lower
}

function sanitizeAccountIdForType(accountId, accountType) {
  if (!accountId || typeof accountId !== 'string') {
    return accountId
  }
  if (accountType === 'openai-responses') {
    return accountId.replace(/^responses:/, '')
  }
  if (accountType === 'gemini-api') {
    return accountId.replace(/^api:/, '')
  }
  return accountId
}

class ApiKeyService {
  constructor() {
    this.prefix = config.security.apiKeyPrefix
  }

  // 🔑 生成新的API Key
  async generateApiKey(options = {}) {
    const {
      name = 'Unnamed Key',
      description = '',
      tokenLimit = 0, // 默认为0，不再使用token限制
      expiresAt = null,
      claudeAccountId = null,
      claudeConsoleAccountId = null,
      geminiAccountId = null,
      openaiAccountId = null,
      azureOpenaiAccountId = null,
      bedrockAccountId = null, // 添加 Bedrock 账号ID支持
      droidAccountId = null,
      permissions = [], // 数组格式，空数组表示全部服务，如 ['claude', 'gemini']
      isActive = true,
      concurrencyLimit = 0,
      rateLimitWindow = null,
      rateLimitRequests = null,
      rateLimitCost = null, // 新增：速率限制费用字段
      enableModelRestriction = false,
      restrictedModels = [],
      enableClientRestriction = false,
      allowedClients = [],
      dailyCostLimit = 0,
      totalCostLimit = 0,
      weeklyOpusCostLimit = 0,
      weeklyCostLimit = 0,
      boosterPackAmount = 0, // 新增：加油包金额
      tags = [],
      activationDays = 0, // 新增：激活后有效天数（0表示不使用此功能）
      activationUnit = 'days', // 新增：激活时间单位 'hours' 或 'days'
      expirationMode = 'fixed', // 新增：过期模式 'fixed'(固定时间) 或 'activation'(首次使用后激活)
      icon = '' // 新增：图标（base64编码）
    } = options

    // 生成简单的API Key (64字符十六进制)
    const apiKey = `${this.prefix}${this._generateSecretKey()}`
    const keyId = uuidv4()
    const hashedKey = this._hashApiKey(apiKey)

    const keyData = {
      id: keyId,
      name,
      description,
      apiKey: hashedKey,
      tokenLimit: String(tokenLimit ?? 0),
      concurrencyLimit: String(concurrencyLimit ?? 0),
      rateLimitWindow: String(rateLimitWindow ?? 0),
      rateLimitRequests: String(rateLimitRequests ?? 0),
      rateLimitCost: String(rateLimitCost ?? 0), // 新增：速率限制费用字段
      isActive: String(isActive),
      claudeAccountId: claudeAccountId || '',
      claudeConsoleAccountId: claudeConsoleAccountId || '',
      geminiAccountId: geminiAccountId || '',
      openaiAccountId: openaiAccountId || '',
      azureOpenaiAccountId: azureOpenaiAccountId || '',
      bedrockAccountId: bedrockAccountId || '', // 添加 Bedrock 账号ID
      droidAccountId: droidAccountId || '',
      permissions: JSON.stringify(normalizePermissions(permissions)),
      enableModelRestriction: String(enableModelRestriction),
      restrictedModels: JSON.stringify(restrictedModels || []),
      enableClientRestriction: String(enableClientRestriction || false),
      allowedClients: JSON.stringify(allowedClients || []),
      dailyCostLimit: String(dailyCostLimit || 0),
      totalCostLimit: String(totalCostLimit || 0),
      weeklyOpusCostLimit: String(weeklyOpusCostLimit || 0),
      weeklyCostLimit: String(weeklyCostLimit || 0),
      boosterPackAmount: String(boosterPackAmount || 0), // 新增：加油包金额
      tags: JSON.stringify(tags || []),
      activationDays: String(activationDays || 0), // 新增：激活后有效天数
      activationUnit: activationUnit || 'days', // 新增：激活时间单位
      expirationMode: expirationMode || 'fixed', // 新增：过期模式
      isActivated: expirationMode === 'fixed' ? 'true' : 'false', // 根据模式决定激活状态
      activatedAt: expirationMode === 'fixed' ? new Date().toISOString() : '', // 激活时间
      createdAt: new Date().toISOString(),
      lastUsedAt: '',
      expiresAt: expirationMode === 'fixed' ? expiresAt || '' : '', // 固定模式才设置过期时间
      createdBy: options.createdBy || 'admin',
      userId: options.userId || '',
      userUsername: options.userUsername || '',
      icon: icon || '' // 新增：图标（base64编码）
    }

    // 保存API Key数据并建立哈希映射
    await redis.setApiKey(keyId, keyData, hashedKey)

    logger.success(`🔑 Generated new API key: ${name} (${keyId})`)

    return {
      id: keyId,
      apiKey, // 只在创建时返回完整的key
      name: keyData.name,
      description: keyData.description,
      tokenLimit: parseInt(keyData.tokenLimit),
      concurrencyLimit: parseInt(keyData.concurrencyLimit),
      rateLimitWindow: parseInt(keyData.rateLimitWindow || 0),
      rateLimitRequests: parseInt(keyData.rateLimitRequests || 0),
      rateLimitCost: parseFloat(keyData.rateLimitCost || 0), // 新增：速率限制费用字段
      isActive: keyData.isActive === 'true',
      claudeAccountId: keyData.claudeAccountId,
      claudeConsoleAccountId: keyData.claudeConsoleAccountId,
      geminiAccountId: keyData.geminiAccountId,
      openaiAccountId: keyData.openaiAccountId,
      azureOpenaiAccountId: keyData.azureOpenaiAccountId,
      bedrockAccountId: keyData.bedrockAccountId, // 添加 Bedrock 账号ID
      droidAccountId: keyData.droidAccountId,
      permissions: normalizePermissions(keyData.permissions),
      enableModelRestriction: keyData.enableModelRestriction === 'true',
      restrictedModels: JSON.parse(keyData.restrictedModels),
      enableClientRestriction: keyData.enableClientRestriction === 'true',
      allowedClients: JSON.parse(keyData.allowedClients || '[]'),
      dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
      totalCostLimit: parseFloat(keyData.totalCostLimit || 0),
      weeklyOpusCostLimit: parseFloat(keyData.weeklyOpusCostLimit || 0),
      weeklyCostLimit: parseFloat(keyData.weeklyCostLimit || 0),
      boosterPackAmount: parseFloat(keyData.boosterPackAmount || 0), // 新增：加油包金额
      tags: JSON.parse(keyData.tags || '[]'),
      activationDays: parseInt(keyData.activationDays || 0),
      activationUnit: keyData.activationUnit || 'days',
      expirationMode: keyData.expirationMode || 'fixed',
      isActivated: keyData.isActivated === 'true',
      activatedAt: keyData.activatedAt,
      createdAt: keyData.createdAt,
      expiresAt: keyData.expiresAt,
      createdBy: keyData.createdBy
    }
  }

  // 🔍 验证API Key
  async validateApiKey(apiKey) {
    try {
      if (!apiKey || !apiKey.startsWith(this.prefix)) {
        return { valid: false, error: 'Invalid API key format' }
      }

      // 计算API Key的哈希值
      const hashedKey = this._hashApiKey(apiKey)

      // 通过哈希值直接查找API Key（性能优化）
      const keyData = await redis.findApiKeyByHash(hashedKey)

      if (!keyData) {
        // ⚠️ 警告：映射表查找失败，可能是竞态条件或映射表损坏
        logger.warn(
          `⚠️ API key not found in hash map: ${hashedKey.substring(0, 16)}... (possible race condition or corrupted hash map)`
        )
        return { valid: false, error: 'API key not found' }
      }

      // 检查是否激活
      if (keyData.isActive !== 'true') {
        return { valid: false, error: 'API key is disabled' }
      }

      // 处理激活逻辑（仅在 activation 模式下）
      if (keyData.expirationMode === 'activation' && keyData.isActivated !== 'true') {
        // 首次使用，需要激活
        const now = new Date()
        const activationPeriod = parseInt(keyData.activationDays || 30) // 默认30
        const activationUnit = keyData.activationUnit || 'days' // 默认天

        // 根据单位计算过期时间
        let milliseconds
        if (activationUnit === 'hours') {
          milliseconds = activationPeriod * 60 * 60 * 1000 // 小时转毫秒
        } else {
          milliseconds = activationPeriod * 24 * 60 * 60 * 1000 // 天转毫秒
        }

        const expiresAt = new Date(now.getTime() + milliseconds)

        // 更新激活状态和过期时间
        keyData.isActivated = 'true'
        keyData.activatedAt = now.toISOString()
        keyData.expiresAt = expiresAt.toISOString()
        keyData.lastUsedAt = now.toISOString()

        // 保存到Redis
        await redis.setApiKey(keyData.id, keyData)

        logger.success(
          `🔓 API key activated: ${keyData.id} (${
            keyData.name
          }), will expire in ${activationPeriod} ${activationUnit} at ${expiresAt.toISOString()}`
        )
      }

      // 检查是否过期
      if (keyData.expiresAt && new Date() > new Date(keyData.expiresAt)) {
        return { valid: false, error: 'API key has expired' }
      }

      // 如果API Key属于某个用户，检查用户是否被禁用
      if (keyData.userId) {
        try {
          const userService = require('./userService')
          const user = await userService.getUserById(keyData.userId, false)
          if (!user || !user.isActive) {
            return { valid: false, error: 'User account is disabled' }
          }
        } catch (error) {
          logger.error('❌ Error checking user status during API key validation:', error)
          return { valid: false, error: 'Unable to validate user status' }
        }
      }

      // 获取使用统计（供返回数据使用）
      const usage = await redis.getUsageStats(keyData.id)

      // 获取费用统计（包括加油包使用量）
      const [dailyCost, costStats, boosterPackUsed] = await Promise.all([
        redis.getDailyCost(keyData.id),
        redis.getCostStats(keyData.id),
        redis.getBoosterPackUsed(keyData.id)
      ])
      const totalCost = costStats?.total || 0

      // 更新最后使用时间（优化：只在实际API调用时更新，而不是验证时）
      // 注意：lastUsedAt的更新已移至recordUsage方法中

      logger.api(`🔓 API key validated successfully: ${keyData.id}`)

      // 解析限制模型数据
      let restrictedModels = []
      try {
        restrictedModels = keyData.restrictedModels ? JSON.parse(keyData.restrictedModels) : []
      } catch (e) {
        restrictedModels = []
      }

      // 解析允许的客户端
      let allowedClients = []
      try {
        allowedClients = keyData.allowedClients ? JSON.parse(keyData.allowedClients) : []
      } catch (e) {
        allowedClients = []
      }

      // 解析标签
      let tags = []
      try {
        tags = keyData.tags ? JSON.parse(keyData.tags) : []
      } catch (e) {
        tags = []
      }

      return {
        valid: true,
        keyData: {
          id: keyData.id,
          name: keyData.name,
          description: keyData.description,
          createdAt: keyData.createdAt,
          expiresAt: keyData.expiresAt,
          claudeAccountId: keyData.claudeAccountId,
          claudeConsoleAccountId: keyData.claudeConsoleAccountId,
          geminiAccountId: keyData.geminiAccountId,
          openaiAccountId: keyData.openaiAccountId,
          azureOpenaiAccountId: keyData.azureOpenaiAccountId,
          bedrockAccountId: keyData.bedrockAccountId, // 添加 Bedrock 账号ID
          droidAccountId: keyData.droidAccountId,
          permissions: normalizePermissions(keyData.permissions),
          tokenLimit: parseInt(keyData.tokenLimit),
          concurrencyLimit: parseInt(keyData.concurrencyLimit || 0),
          rateLimitWindow: parseInt(keyData.rateLimitWindow || 0),
          rateLimitRequests: parseInt(keyData.rateLimitRequests || 0),
          rateLimitCost: parseFloat(keyData.rateLimitCost || 0), // 新增：速率限制费用字段
          enableModelRestriction: keyData.enableModelRestriction === 'true',
          restrictedModels,
          enableClientRestriction: keyData.enableClientRestriction === 'true',
          allowedClients,
          dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
          totalCostLimit: parseFloat(keyData.totalCostLimit || 0),
          weeklyOpusCostLimit: parseFloat(keyData.weeklyOpusCostLimit || 0),
          weeklyCostLimit: parseFloat(keyData.weeklyCostLimit || 0),
          boosterPackAmount: parseFloat(keyData.boosterPackAmount || 0), // 加油包总金额
          boosterPackUsed: boosterPackUsed || 0, // 加油包已使用金额
          dailyCost: dailyCost || 0,
          totalCost,
          weeklyOpusCost: (await redis.getWeeklyOpusCost(keyData.id)) || 0,
          weeklyCost: (await redis.getWeeklyCost(keyData.id)) || 0,
          tags,
          usage
        }
      }
    } catch (error) {
      logger.error('❌ API key validation error:', error)
      return { valid: false, error: 'Internal validation error' }
    }
  }

  // 🔍 验证API Key（仅用于统计查询，不触发激活）
  async validateApiKeyForStats(apiKey) {
    try {
      if (!apiKey || !apiKey.startsWith(this.prefix)) {
        return { valid: false, error: 'Invalid API key format' }
      }

      // 计算API Key的哈希值
      const hashedKey = this._hashApiKey(apiKey)

      // 通过哈希值直接查找API Key（性能优化）
      const keyData = await redis.findApiKeyByHash(hashedKey)

      if (!keyData) {
        return { valid: false, error: 'API key not found' }
      }

      // 检查是否激活
      if (keyData.isActive !== 'true') {
        return { valid: false, error: 'API key is disabled' }
      }

      // 注意：这里不处理激活逻辑，保持 API Key 的未激活状态

      // 检查是否过期（仅对已激活的 Key 检查）
      if (
        keyData.isActivated === 'true' &&
        keyData.expiresAt &&
        new Date() > new Date(keyData.expiresAt)
      ) {
        return { valid: false, error: 'API key has expired' }
      }

      // 如果API Key属于某个用户，检查用户是否被禁用
      if (keyData.userId) {
        try {
          const userService = require('./userService')
          const user = await userService.getUserById(keyData.userId, false)
          if (!user || !user.isActive) {
            return { valid: false, error: 'User account is disabled' }
          }
        } catch (userError) {
          // 如果用户服务出错，记录但不影响API Key验证
          logger.warn(`Failed to check user status for API key ${keyData.id}:`, userError)
        }
      }

      // 获取当日费用（包括加油包使用量）
      const [dailyCost, costStats, boosterPackUsed] = await Promise.all([
        redis.getDailyCost(keyData.id),
        redis.getCostStats(keyData.id),
        redis.getBoosterPackUsed(keyData.id)
      ])

      // 获取使用统计
      const usage = await redis.getUsageStats(keyData.id)

      // 解析限制模型数据
      let restrictedModels = []
      try {
        restrictedModels = keyData.restrictedModels ? JSON.parse(keyData.restrictedModels) : []
      } catch (e) {
        restrictedModels = []
      }

      // 解析允许的客户端
      let allowedClients = []
      try {
        allowedClients = keyData.allowedClients ? JSON.parse(keyData.allowedClients) : []
      } catch (e) {
        allowedClients = []
      }

      // 解析标签
      let tags = []
      try {
        tags = keyData.tags ? JSON.parse(keyData.tags) : []
      } catch (e) {
        tags = []
      }

      return {
        valid: true,
        keyData: {
          id: keyData.id,
          name: keyData.name,
          description: keyData.description,
          createdAt: keyData.createdAt,
          expiresAt: keyData.expiresAt,
          // 添加激活相关字段
          expirationMode: keyData.expirationMode || 'fixed',
          isActivated: keyData.isActivated === 'true',
          activationDays: parseInt(keyData.activationDays || 0),
          activationUnit: keyData.activationUnit || 'days',
          activatedAt: keyData.activatedAt || null,
          claudeAccountId: keyData.claudeAccountId,
          claudeConsoleAccountId: keyData.claudeConsoleAccountId,
          geminiAccountId: keyData.geminiAccountId,
          openaiAccountId: keyData.openaiAccountId,
          azureOpenaiAccountId: keyData.azureOpenaiAccountId,
          bedrockAccountId: keyData.bedrockAccountId,
          droidAccountId: keyData.droidAccountId,
          permissions: normalizePermissions(keyData.permissions),
          tokenLimit: parseInt(keyData.tokenLimit),
          concurrencyLimit: parseInt(keyData.concurrencyLimit || 0),
          rateLimitWindow: parseInt(keyData.rateLimitWindow || 0),
          rateLimitRequests: parseInt(keyData.rateLimitRequests || 0),
          rateLimitCost: parseFloat(keyData.rateLimitCost || 0),
          enableModelRestriction: keyData.enableModelRestriction === 'true',
          restrictedModels,
          enableClientRestriction: keyData.enableClientRestriction === 'true',
          allowedClients,
          dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
          totalCostLimit: parseFloat(keyData.totalCostLimit || 0),
          weeklyOpusCostLimit: parseFloat(keyData.weeklyOpusCostLimit || 0),
          weeklyCostLimit: parseFloat(keyData.weeklyCostLimit || 0),
          boosterPackAmount: parseFloat(keyData.boosterPackAmount || 0), // 加油包总金额
          boosterPackUsed: boosterPackUsed || 0, // 加油包已使用金额
          dailyCost: dailyCost || 0,
          totalCost: costStats?.total || 0,
          weeklyOpusCost: (await redis.getWeeklyOpusCost(keyData.id)) || 0,
          weeklyCost: (await redis.getWeeklyCost(keyData.id)) || 0,
          tags,
          usage
        }
      }
    } catch (error) {
      logger.error('❌ API key validation error (stats):', error)
      return { valid: false, error: 'Internal validation error' }
    }
  }

  // 📋 获取所有API Keys
  async getAllApiKeys(includeDeleted = false) {
    try {
      let apiKeys = await redis.getAllApiKeys()
      const client = redis.getClientSafe()
      const accountInfoCache = new Map()

      // 默认过滤掉已删除的API Keys
      if (!includeDeleted) {
        apiKeys = apiKeys.filter((key) => key.isDeleted !== 'true')
      }

      // 优化：使用 Promise.all 并行处理所有 API Key，而不是串行 for 循环
      // 这可以显著减少总耗时（从 N * 单个耗时 变为 max(单个耗时)）
      await Promise.all(
        apiKeys.map(async (key) => {
          await this._enrichApiKey(key, client, accountInfoCache)
          delete key.apiKey // 不返回哈希后的key
        })
      )

      return apiKeys
    } catch (error) {
      logger.error('❌ Failed to get API keys:', error)
      throw error
    }
  }

  // 🔧 辅助方法：丰富单个API Key的详细数据
  async _enrichApiKey(key, client, accountInfoCache) {
    try {
      // 🔧 修复：从 Redis 获取完整数据，合并索引中缺失的字段（如限制、加油包等）
      const fullKeyData = await redis.getApiKey(key.id)
      if (fullKeyData && Object.keys(fullKeyData).length > 0) {
        key = { ...fullKeyData, ...key }
      }

      // 并行查询所有统计数据
      const [
        usage,
        costStats,
        concurrency,
        dailyCost,
        weeklyOpusCost,
        weeklyCost,
        boosterPackUsed,
        weeklyResetTime,
        isWeeklyCostActive
      ] = await Promise.all([
        redis.getUsageStats(key.id),
        redis.getCostStats(key.id),
        redis.getConcurrency(key.id),
        redis.getDailyCost(key.id),
        redis.getWeeklyOpusCost(key.id),
        redis.getWeeklyCost(key.id),
        redis.getBoosterPackUsed(key.id),
        redis.getWeeklyCostResetTime(key.id),
        redis.isWeeklyCostActive(key.id)
      ])

      // 添加cost信息到usage对象以保持前端兼容性
      if (usage && costStats) {
        usage.total = usage.total || {}
        usage.total.cost = costStats.total
        usage.totalCost = costStats.total
      }

      // 基本字段转换
      key.usage = usage
      key.totalCost = costStats ? costStats.total : 0
      key.tokenLimit = parseInt(key.tokenLimit || 0)
      key.concurrencyLimit = parseInt(key.concurrencyLimit || 0)
      key.rateLimitWindow = parseInt(key.rateLimitWindow || 0)
      key.rateLimitRequests = parseInt(key.rateLimitRequests || 0)
      key.rateLimitCost = parseFloat(key.rateLimitCost || 0)
      key.currentConcurrency = concurrency
      key.isActive = key.isActive === 'true'
      key.enableModelRestriction = key.enableModelRestriction === 'true'
      key.enableClientRestriction = key.enableClientRestriction === 'true'
      key.permissions = normalizePermissions(key.permissions)
      key.dailyCostLimit = parseFloat(key.dailyCostLimit || 0)
      key.totalCostLimit = parseFloat(key.totalCostLimit || 0)
      key.weeklyOpusCostLimit = parseFloat(key.weeklyOpusCostLimit || 0)
      key.weeklyCostLimit = parseFloat(key.weeklyCostLimit || 0)
      key.boosterPackAmount = parseFloat(key.boosterPackAmount || 0)
      key.boosterPackUsed = boosterPackUsed || 0
      key.dailyCost = dailyCost || 0
      key.weeklyOpusCost = weeklyOpusCost || 0
      key.weeklyCost = weeklyCost || 0
      key.weeklyResetTime = weeklyResetTime ? weeklyResetTime.toISOString() : null
      key.isWeeklyCostActive = isWeeklyCostActive || false
      key.activationDays = parseInt(key.activationDays || 0)
      key.activationUnit = key.activationUnit || 'days'
      key.expirationMode = key.expirationMode || 'fixed'
      key.isActivated = key.isActivated === 'true'
      key.activatedAt = key.activatedAt || null

      // 获取速率限制窗口信息
      if (key.rateLimitWindow > 0) {
        const requestCountKey = `rate_limit:requests:${key.id}`
        const tokenCountKey = `rate_limit:tokens:${key.id}`
        const costCountKey = `rate_limit:cost:${key.id}`
        const windowStartKey = `rate_limit:window_start:${key.id}`

        const [currentWindowRequests, currentWindowTokens, currentWindowCost, windowStart] =
          await Promise.all([
            client.get(requestCountKey),
            client.get(tokenCountKey),
            client.get(costCountKey),
            client.get(windowStartKey)
          ])

        key.currentWindowRequests = parseInt(currentWindowRequests || '0')
        key.currentWindowTokens = parseInt(currentWindowTokens || '0')
        key.currentWindowCost = parseFloat(currentWindowCost || '0')

        if (windowStart) {
          const now = Date.now()
          const windowStartTime = parseInt(windowStart)
          const windowDuration = key.rateLimitWindow * 60 * 1000
          const windowEndTime = windowStartTime + windowDuration

          if (now < windowEndTime) {
            key.windowStartTime = windowStartTime
            key.windowEndTime = windowEndTime
            key.windowRemainingSeconds = Math.max(0, Math.floor((windowEndTime - now) / 1000))
          } else {
            key.windowStartTime = null
            key.windowEndTime = null
            key.windowRemainingSeconds = 0
            key.currentWindowRequests = 0
            key.currentWindowTokens = 0
            key.currentWindowCost = 0
          }
        } else {
          key.windowStartTime = null
          key.windowEndTime = null
          key.windowRemainingSeconds = null
        }
      } else {
        key.currentWindowRequests = 0
        key.currentWindowTokens = 0
        key.currentWindowCost = 0
        key.windowStartTime = null
        key.windowEndTime = null
        key.windowRemainingSeconds = null
      }

      // 解析JSON字段
      try {
        key.restrictedModels = key.restrictedModels ? JSON.parse(key.restrictedModels) : []
      } catch (e) {
        key.restrictedModels = []
      }
      try {
        key.allowedClients = key.allowedClients ? JSON.parse(key.allowedClients) : []
      } catch (e) {
        key.allowedClients = []
      }
      try {
        key.tags = key.tags ? JSON.parse(key.tags) : []
      } catch (e) {
        key.tags = []
      }

      // 移除已弃用字段
      if (Object.prototype.hasOwnProperty.call(key, 'ccrAccountId')) {
        delete key.ccrAccountId
      }

      // 获取最后使用记录
      let lastUsageRecord = null
      try {
        const usageRecords = await redis.getUsageRecords(key.id, 1)
        if (Array.isArray(usageRecords) && usageRecords.length > 0) {
          lastUsageRecord = usageRecords[0]
        }
      } catch (error) {
        logger.debug(`加载 API Key ${key.id} 的使用记录失败:`, error)
      }

      if (lastUsageRecord && (lastUsageRecord.accountId || lastUsageRecord.accountType)) {
        const resolvedAccount = await this._resolveLastUsageAccount(
          key,
          lastUsageRecord,
          accountInfoCache,
          client
        )

        if (resolvedAccount) {
          key.lastUsage = {
            accountId: resolvedAccount.accountId,
            rawAccountId: lastUsageRecord.accountId || resolvedAccount.accountId,
            accountType: resolvedAccount.accountType,
            accountCategory: resolvedAccount.accountCategory,
            accountName: resolvedAccount.accountName,
            recordedAt: lastUsageRecord.timestamp || key.lastUsedAt || null
          }
        } else {
          key.lastUsage = {
            accountId: null,
            rawAccountId: lastUsageRecord.accountId || null,
            accountType: 'deleted',
            accountCategory: 'deleted',
            accountName: '已删除',
            recordedAt: lastUsageRecord.timestamp || key.lastUsedAt || null
          }
        }
      } else {
        key.lastUsage = null
      }

      delete key.apiKey // 不返回哈希后的key
      return key
    } catch (error) {
      logger.error(`❌ Failed to enrich API key ${key.id}:`, error)
      throw error
    }
  }

  // 📄 获取分页的API Keys列表（性能优化版）
  async getApiKeysPaginated(options = {}) {
    try {
      const {
        page = 1,
        pageSize = 20,
        includeDeleted = false,
        sortBy = 'createdAt',
        sortOrder = 'desc',
        searchMode = 'apiKey',
        searchQuery = '',
        filterStatus = 'all',
        filterPermissions = 'all',
        filterTag = ''
      } = options

      // 1️⃣ 获取所有API Key的基本信息
      // 按所属账号搜索时需要完整数据（包含绑定字段），使用全量加载
      let apiKeys =
        searchMode === 'bindingAccount' && searchQuery
          ? await redis.getAllApiKeys()
          : await redis.getAllApiKeysFromIndex()
      const client = redis.getClientSafe()
      const accountInfoCache = new Map()

      // 2️⃣ 过滤逻辑
      // 过滤已删除的keys
      if (!includeDeleted) {
        apiKeys = apiKeys.filter((key) => key.isDeleted !== 'true')
      }

      // 状态过滤
      if (filterStatus !== 'all') {
        apiKeys = apiKeys.filter(
          (key) => key.isActive === (filterStatus === 'active' ? 'true' : 'false')
        )
      }

      // 权限过滤
      if (filterPermissions !== 'all') {
        apiKeys = apiKeys.filter((key) => (key.permissions || 'all') === filterPermissions)
      }

      // 标签过滤
      if (filterTag) {
        apiKeys = apiKeys.filter((key) => {
          if (!key.tags) {
            return false
          }
          let { tags } = key
          if (typeof tags === 'string') {
            try {
              tags = JSON.parse(tags)
            } catch (e) {
              // JSON 解析失败，跳过此 key
              return false
            }
          }
          return Array.isArray(tags) && tags.includes(filterTag)
        })
      }

      // 搜索过滤
      if (searchQuery) {
        const query = searchQuery.toLowerCase()
        if (searchMode === 'bindingAccount') {
          // 按所属账号搜索：构建账户ID→名称映射，然后过滤
          const accountNameMap = await this._buildAccountNameMap()
          apiKeys = apiKeys.filter((key) => {
            const bindingFields = [
              'claudeAccountId',
              'claudeConsoleAccountId',
              'geminiAccountId',
              'openaiAccountId',
              'azureOpenaiAccountId',
              'bedrockAccountId',
              'droidAccountId'
            ]
            return bindingFields.some((field) => {
              const accountId = key[field]
              if (!accountId) {
                return false
              }
              const accountName = accountNameMap.get(accountId)
              if (accountName && accountName.toLowerCase().includes(query)) {
                return true
              }
              // 也匹配账户ID本身（前8位或完整ID）
              return accountId.toLowerCase().includes(query)
            })
          })
        } else {
          apiKeys = apiKeys.filter(
            (key) =>
              key.name?.toLowerCase().includes(query) ||
              key.description?.toLowerCase().includes(query) ||
              key.id?.toLowerCase().includes(query) ||
              (key.tags && JSON.stringify(key.tags).toLowerCase().includes(query))
          )
        }
      }

      // 3️⃣ 排序（支持计算字段）
      // 检查是否需要额外数据来排序（如 periodCost, periodTokens, periodRequests）
      const needsStatisticsForSort = [
        'periodCost',
        'periodTokens',
        'periodRequests',
        'totalCost',
        'dailyCost',
        'weeklyCost'
      ].includes(sortBy)

      if (needsStatisticsForSort) {
        // 批量查询所有keys的统计数据用于排序
        await Promise.all(
          apiKeys.map(async (key) => {
            if (sortBy === 'periodCost' || sortBy === 'totalCost') {
              const costStats = await redis.getCostStats(key.id)
              key._sortValue = costStats?.total || 0
            } else if (sortBy === 'dailyCost') {
              key._sortValue = (await redis.getDailyCost(key.id)) || 0
            } else if (sortBy === 'weeklyCost') {
              key._sortValue = (await redis.getWeeklyCost(key.id)) || 0
            } else if (sortBy === 'periodTokens') {
              const usage = await redis.getUsageStats(key.id)
              key._sortValue = usage?.total?.tokens || 0
            } else if (sortBy === 'periodRequests') {
              const usage = await redis.getUsageStats(key.id)
              key._sortValue = usage?.total?.requests || 0
            }
          })
        )

        // 按统计数据排序
        apiKeys.sort((a, b) => {
          const aVal = a._sortValue || 0
          const bVal = b._sortValue || 0
          const order = sortOrder === 'asc' ? 1 : -1
          if (aVal < bVal) {
            return -1 * order
          }
          if (aVal > bVal) {
            return 1 * order
          }
          return 0
        })

        // 清理临时排序字段
        apiKeys.forEach((key) => delete key._sortValue)
      } else {
        // 基本字段排序
        apiKeys.sort((a, b) => {
          let aVal = a[sortBy]
          let bVal = b[sortBy]

          // 状态字段特殊处理
          if (sortBy === 'status') {
            aVal = a.isActive === 'true' ? 1 : 0
            bVal = b.isActive === 'true' ? 1 : 0
          }
          // 处理时间戳字段
          else if (['createdAt', 'expiresAt', 'lastUsedAt'].includes(sortBy)) {
            aVal = aVal ? new Date(aVal).getTime() : 0
            bVal = bVal ? new Date(bVal).getTime() : 0
          }
          // 处理数值类型字段
          else if (['tokenLimit', 'concurrencyLimit'].includes(sortBy)) {
            aVal = parseInt(aVal || 0)
            bVal = parseInt(bVal || 0)
          }
          // 处理字符串类型字段
          else if (typeof aVal === 'string') {
            aVal = aVal.toLowerCase()
            bVal = typeof bVal === 'string' ? bVal.toLowerCase() : ''
          }

          const order = sortOrder === 'asc' ? 1 : -1
          if (aVal < bVal) {
            return -1 * order
          }
          if (aVal > bVal) {
            return 1 * order
          }
          return 0
        })
      }

      // 4️⃣ 计算分页
      const total = apiKeys.length
      const totalPages = Math.ceil(total / pageSize)
      const validPage = Math.max(1, Math.min(page, totalPages || 1))
      const start = (validPage - 1) * pageSize
      const end = start + pageSize

      // 5️⃣ 获取当前页的keys
      const pageKeys = apiKeys.slice(start, end)

      // 6️⃣ 并行查询当前页的详细数据（关键性能优化！）
      const enrichedKeys = await Promise.all(
        pageKeys.map((key) => this._enrichApiKey(key, client, accountInfoCache))
      )

      return {
        data: enrichedKeys,
        pagination: {
          page: validPage,
          pageSize,
          total,
          totalPages
        }
      }
    } catch (error) {
      logger.error('❌ Failed to get paginated API keys:', error)
      throw error
    }
  }

  // 📝 更新API Key
  async updateApiKey(keyId, updates) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      // 允许更新的字段
      const allowedUpdates = [
        'name',
        'description',
        'tokenLimit',
        'concurrencyLimit',
        'rateLimitWindow',
        'rateLimitRequests',
        'rateLimitCost', // 新增：速率限制费用字段
        'isActive',
        'claudeAccountId',
        'claudeConsoleAccountId',
        'geminiAccountId',
        'openaiAccountId',
        'azureOpenaiAccountId',
        'bedrockAccountId', // 添加 Bedrock 账号ID
        'droidAccountId',
        'permissions',
        'expiresAt',
        'activationDays', // 新增：激活后有效天数
        'activationUnit', // 新增：激活时间单位
        'expirationMode', // 新增：过期模式
        'isActivated', // 新增：是否已激活
        'activatedAt', // 新增：激活时间
        'enableModelRestriction',
        'restrictedModels',
        'enableClientRestriction',
        'allowedClients',
        'dailyCostLimit',
        'totalCostLimit',
        'weeklyOpusCostLimit',
        'weeklyCostLimit',
        'boosterPackAmount', // 新增：加油包金额
        'tags',
        'userId', // 新增：用户ID（所有者变更）
        'userUsername', // 新增：用户名（所有者变更）
        'createdBy' // 新增：创建者（所有者变更）
      ]
      const updatedData = { ...keyData }

      for (const [field, value] of Object.entries(updates)) {
        if (allowedUpdates.includes(field)) {
          if (field === 'restrictedModels' || field === 'allowedClients' || field === 'tags') {
            // 特殊处理数组字段
            updatedData[field] = JSON.stringify(value || [])
          } else if (
            field === 'enableModelRestriction' ||
            field === 'enableClientRestriction' ||
            field === 'isActivated'
          ) {
            // 布尔值转字符串
            updatedData[field] = String(value)
          } else if (field === 'expiresAt' || field === 'activatedAt') {
            // 日期字段保持原样，不要toString()
            updatedData[field] = value || ''
          } else {
            updatedData[field] = (value !== null && value !== undefined ? value : '').toString()
          }
        }
      }

      updatedData.updatedAt = new Date().toISOString()

      // 传递hashedKey以确保映射表一致性
      // keyData.apiKey 存储的就是 hashedKey（见generateApiKey第123行）
      await redis.setApiKey(keyId, updatedData, keyData.apiKey)

      logger.success(`📝 Updated API key: ${keyId}, hashMap updated`)

      return { success: true }
    } catch (error) {
      logger.error('❌ Failed to update API key:', error)
      throw error
    }
  }

  // 🗑️ 软删除API Key (保留使用统计)
  async deleteApiKey(keyId, deletedBy = 'system', deletedByType = 'system') {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      // 标记为已删除，保留所有数据和统计信息
      const updatedData = {
        ...keyData,
        isDeleted: 'true',
        deletedAt: new Date().toISOString(),
        deletedBy,
        deletedByType, // 'user', 'admin', 'system'
        isActive: 'false' // 同时禁用
      }

      await redis.setApiKey(keyId, updatedData)

      // 从哈希映射中移除（这样就不能再使用这个key进行API调用）
      if (keyData.apiKey) {
        await redis.deleteApiKeyHash(keyData.apiKey)
      }

      logger.success(`🗑️ Soft deleted API key: ${keyId} by ${deletedBy} (${deletedByType})`)

      return { success: true }
    } catch (error) {
      logger.error('❌ Failed to delete API key:', error)
      throw error
    }
  }

  // 🔄 恢复已删除的API Key
  async restoreApiKey(keyId, restoredBy = 'system', restoredByType = 'system') {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      // 检查是否确实是已删除的key
      if (keyData.isDeleted !== 'true') {
        throw new Error('API key is not deleted')
      }

      // 准备更新的数据
      const updatedData = { ...keyData }
      updatedData.isActive = 'true'
      updatedData.restoredAt = new Date().toISOString()
      updatedData.restoredBy = restoredBy
      updatedData.restoredByType = restoredByType

      // 从更新的数据中移除删除相关的字段
      delete updatedData.isDeleted
      delete updatedData.deletedAt
      delete updatedData.deletedBy
      delete updatedData.deletedByType

      // 保存更新后的数据
      await redis.setApiKey(keyId, updatedData)

      // 使用Redis的hdel命令删除不需要的字段
      const keyName = `apikey:${keyId}`
      await redis.client.hdel(keyName, 'isDeleted', 'deletedAt', 'deletedBy', 'deletedByType')

      // 重新建立哈希映射（恢复API Key的使用能力）
      if (keyData.apiKey) {
        await redis.setApiKeyHash(keyData.apiKey, {
          id: keyId,
          name: keyData.name,
          isActive: 'true'
        })
      }

      logger.success(`✅ Restored API key: ${keyId} by ${restoredBy} (${restoredByType})`)

      return { success: true, apiKey: updatedData }
    } catch (error) {
      logger.error('❌ Failed to restore API key:', error)
      throw error
    }
  }

  // 🗑️ 彻底删除API Key（物理删除）
  async permanentDeleteApiKey(keyId) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      // 确保只能彻底删除已经软删除的key
      if (keyData.isDeleted !== 'true') {
        throw new Error('只能彻底删除已经删除的API Key')
      }

      // 删除所有相关的使用统计数据
      const today = new Date().toISOString().split('T')[0]
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]

      // 删除每日统计
      await redis.client.del(`usage:daily:${today}:${keyId}`)
      await redis.client.del(`usage:daily:${yesterday}:${keyId}`)

      // 删除月度统计
      const currentMonth = today.substring(0, 7)
      await redis.client.del(`usage:monthly:${currentMonth}:${keyId}`)

      // 删除所有相关的统计键（通过模式匹配）
      const usageKeys = await redis.scanKeys(`usage:*:${keyId}*`)
      if (usageKeys.length > 0) {
        await redis.client.del(...usageKeys)
      }

      // 删除API Key本身
      await redis.deleteApiKey(keyId)

      logger.success(`🗑️ Permanently deleted API key: ${keyId}`)

      return { success: true }
    } catch (error) {
      logger.error('❌ Failed to permanently delete API key:', error)
      throw error
    }
  }

  // 🧹 清空所有已删除的API Keys
  async clearAllDeletedApiKeys() {
    try {
      const allKeys = await this.getAllApiKeys(true)
      const deletedKeys = allKeys.filter((key) => key.isDeleted === 'true')

      let successCount = 0
      let failedCount = 0
      const errors = []

      for (const key of deletedKeys) {
        try {
          await this.permanentDeleteApiKey(key.id)
          successCount++
        } catch (error) {
          failedCount++
          errors.push({
            keyId: key.id,
            keyName: key.name,
            error: error.message
          })
        }
      }

      logger.success(`🧹 Cleared deleted API keys: ${successCount} success, ${failedCount} failed`)

      return {
        success: true,
        total: deletedKeys.length,
        successCount,
        failedCount,
        errors
      }
    } catch (error) {
      logger.error('❌ Failed to clear all deleted API keys:', error)
      throw error
    }
  }

  // 📊 记录使用情况（支持缓存token和账户级别统计）
  async recordUsage(
    keyId,
    inputTokens = 0,
    outputTokens = 0,
    cacheCreateTokens = 0,
    cacheReadTokens = 0,
    model = 'unknown',
    accountId = null,
    useBooster = false // 新增：是否使用加油包
  ) {
    try {
      const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

      // 计算费用
      const CostCalculator = require('../utils/costCalculator')
      const costInfo = CostCalculator.calculateCost(
        {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheCreateTokens,
          cache_read_input_tokens: cacheReadTokens
        },
        model
      )

      // 检查是否为 1M 上下文请求
      let isLongContextRequest = false
      if (model && model.includes('[1m]')) {
        const totalInputTokens = inputTokens + cacheCreateTokens + cacheReadTokens
        isLongContextRequest = totalInputTokens > 200000
      }

      // 记录API Key级别的使用统计
      await redis.incrementTokenUsage(
        keyId,
        totalTokens,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        model,
        0, // ephemeral5mTokens - 暂时为0，后续处理
        0, // ephemeral1hTokens - 暂时为0，后续处理
        isLongContextRequest
      )

      // 记录费用统计
      if (costInfo.costs.total > 0) {
        // 检查是否使用加油包
        if (useBooster) {
          // Get current used amount and limit BEFORE incrementing (防止竞态条件)
          const currentUsed = await redis.getBoosterPackUsed(keyId)
          const keyData = await redis.getApiKey(keyId)
          const boosterPackAmount = parseFloat(keyData.boosterPackAmount || 0)

          // Check if adding this cost would exceed the limit
          if (currentUsed + costInfo.costs.total > boosterPackAmount) {
            const allowedAmount = Math.max(0, boosterPackAmount - currentUsed)
            logger.warn(
              `⚠️ Booster pack would be exceeded for ${keyId}. Cost: $${costInfo.costs.total.toFixed(6)}, Allowed: $${allowedAmount.toFixed(6)}, Current: $${currentUsed.toFixed(6)}, Limit: $${boosterPackAmount.toFixed(2)}`
            )

            // Only charge what's remaining in booster, rest goes to normal cost
            if (allowedAmount > 0) {
              await redis.incrementBoosterPackUsed(keyId, allowedAmount)
              await redis.addBoosterPackRecord(keyId, {
                timestamp: Date.now(),
                amount: allowedAmount,
                model,
                accountType: accountId ? 'account' : 'unknown'
              })
              logger.database(
                `🚀 Recorded partial booster usage for ${keyId}: $${allowedAmount.toFixed(6)}`
              )
            }

            // Charge the excess to normal cost
            const excessCost = costInfo.costs.total - allowedAmount
            if (excessCost > 0) {
              await redis.incrementDailyCost(keyId, excessCost)

              // 记录周费用（修复：与 recordUsageWithDetails 保持一致）
              const keyDataForWeekly = await redis.getApiKey(keyId)
              const weeklyCostLimit = parseFloat(keyDataForWeekly?.weeklyCostLimit || 0)
              if (weeklyCostLimit > 0) {
                await redis.incrementWeeklyCost(keyId, excessCost)
              }

              logger.database(
                `💰 Excess cost to normal for ${keyId}: $${excessCost.toFixed(6)}, model: ${model}`
              )
            }
          } else {
            // Normal booster pack usage - within limit
            await redis.incrementBoosterPackUsed(keyId, costInfo.costs.total)
            await redis.addBoosterPackRecord(keyId, {
              timestamp: Date.now(),
              amount: costInfo.costs.total,
              model,
              accountType: accountId ? 'account' : 'unknown'
            })
            logger.database(
              `🚀 Recorded booster pack usage for ${keyId}: $${costInfo.costs.total.toFixed(6)}, model: ${model}`
            )
          }
        } else {
          // 正常费用，不使用加油包
          await redis.incrementDailyCost(keyId, costInfo.costs.total)

          // 记录周费用（修复：与 recordUsageWithDetails 保持一致）
          const keyDataForWeekly = await redis.getApiKey(keyId)
          const weeklyCostLimit = parseFloat(keyDataForWeekly?.weeklyCostLimit || 0)
          if (weeklyCostLimit > 0) {
            await redis.incrementWeeklyCost(keyId, costInfo.costs.total)
          }

          logger.database(
            `💰 Recorded cost for ${keyId}: $${costInfo.costs.total.toFixed(6)}, model: ${model}`
          )
        }
      } else {
        logger.debug(`💰 No cost recorded for ${keyId} - zero cost for model: ${model}`)
      }

      // 获取API Key数据以确定关联的账户
      const keyData = await redis.getApiKey(keyId)
      if (keyData && Object.keys(keyData).length > 0) {
        // 更新最后使用时间
        keyData.lastUsedAt = new Date().toISOString()
        await redis.setApiKey(keyId, keyData)

        // 记录账户级别的使用统计（只统计实际处理请求的账户）
        if (accountId) {
          await redis.incrementAccountUsage(
            accountId,
            totalTokens,
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            model,
            isLongContextRequest
          )
          logger.database(
            `📊 Recorded account usage: ${accountId} - ${totalTokens} tokens (API Key: ${keyId})`
          )
        } else {
          logger.debug(
            '⚠️ No accountId provided for usage recording, skipping account-level statistics'
          )
        }
      }

      // 记录单次请求的使用详情
      const usageCost = costInfo && costInfo.costs ? costInfo.costs.total || 0 : 0
      await redis.addUsageRecord(keyId, {
        timestamp: new Date().toISOString(),
        model,
        accountId: accountId || null,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        totalTokens,
        cost: Number(usageCost.toFixed(6)),
        costBreakdown: costInfo && costInfo.costs ? costInfo.costs : undefined
      })

      const logParts = [`Model: ${model}`, `Input: ${inputTokens}`, `Output: ${outputTokens}`]
      if (cacheCreateTokens > 0) {
        logParts.push(`Cache Create: ${cacheCreateTokens}`)
      }
      if (cacheReadTokens > 0) {
        logParts.push(`Cache Read: ${cacheReadTokens}`)
      }
      logParts.push(`Total: ${totalTokens} tokens`)

      logger.database(`📊 Recorded usage: ${keyId} - ${logParts.join(', ')}`)
    } catch (error) {
      logger.error('❌ Failed to record usage:', error)
    }
  }

  // 📊 记录 Opus 模型费用（仅限 claude 和 claude-console 账户）
  async recordOpusCost(keyId, cost, model, accountType) {
    try {
      // 判断是否为 Opus 模型
      if (!model || !model.toLowerCase().includes('claude-opus')) {
        return // 不是 Opus 模型，直接返回
      }

      // 判断是否为 claude、claude-console 或 ccr 账户
      if (
        !accountType ||
        (accountType !== 'claude' && accountType !== 'claude-console' && accountType !== 'ccr')
      ) {
        logger.debug(`⚠️ Skipping Opus cost recording for non-Claude account type: ${accountType}`)
        return // 不是 claude 账户，直接返回
      }

      // 记录 Opus 周费用
      await redis.incrementWeeklyOpusCost(keyId, cost)
      logger.database(
        `💰 Recorded Opus weekly cost for ${keyId}: $${cost.toFixed(
          6
        )}, model: ${model}, account type: ${accountType}`
      )
    } catch (error) {
      logger.error('❌ Failed to record Opus cost:', error)
    }
  }

  // 📊 记录使用情况（新版本，支持详细的缓存类型）
  async recordUsageWithDetails(
    keyId,
    usageObject,
    model = 'unknown',
    accountId = null,
    accountType = null,
    useBooster = false // 新增：是否使用加油包
  ) {
    try {
      // 提取 token 数量
      const inputTokens = usageObject.input_tokens || 0
      const outputTokens = usageObject.output_tokens || 0
      const cacheCreateTokens = usageObject.cache_creation_input_tokens || 0
      const cacheReadTokens = usageObject.cache_read_input_tokens || 0

      const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

      // 计算费用（支持详细的缓存类型）- 添加错误处理
      let costInfo = { totalCost: 0, ephemeral5mCost: 0, ephemeral1hCost: 0 }
      try {
        const pricingService = require('./pricingService')
        // 确保 pricingService 已初始化
        if (!pricingService.pricingData) {
          logger.warn('⚠️ PricingService not initialized, initializing now...')
          await pricingService.initialize()
        }
        costInfo = pricingService.calculateCost(usageObject, model)

        // 验证计算结果
        if (!costInfo || typeof costInfo.totalCost !== 'number') {
          logger.error(`❌ Invalid cost calculation result for model ${model}:`, costInfo)
          // 使用 CostCalculator 作为后备
          const CostCalculator = require('../utils/costCalculator')
          const fallbackCost = CostCalculator.calculateCost(usageObject, model)
          if (fallbackCost && fallbackCost.costs && fallbackCost.costs.total > 0) {
            logger.warn(
              `⚠️ Using fallback cost calculation for ${model}: $${fallbackCost.costs.total}`
            )
            costInfo = {
              totalCost: fallbackCost.costs.total,
              ephemeral5mCost: 0,
              ephemeral1hCost: 0
            }
          } else {
            costInfo = { totalCost: 0, ephemeral5mCost: 0, ephemeral1hCost: 0 }
          }
        }
      } catch (pricingError) {
        logger.error(`❌ Failed to calculate cost for model ${model}:`, pricingError)
        logger.error(`   Usage object:`, JSON.stringify(usageObject))
        // 使用 CostCalculator 作为后备
        try {
          const CostCalculator = require('../utils/costCalculator')
          const fallbackCost = CostCalculator.calculateCost(usageObject, model)
          if (fallbackCost && fallbackCost.costs && fallbackCost.costs.total > 0) {
            logger.warn(
              `⚠️ Using fallback cost calculation for ${model}: $${fallbackCost.costs.total}`
            )
            costInfo = {
              totalCost: fallbackCost.costs.total,
              ephemeral5mCost: 0,
              ephemeral1hCost: 0
            }
          }
        } catch (fallbackError) {
          logger.error(`❌ Fallback cost calculation also failed:`, fallbackError)
        }
      }

      // 提取详细的缓存创建数据
      let ephemeral5mTokens = 0
      let ephemeral1hTokens = 0

      if (usageObject.cache_creation && typeof usageObject.cache_creation === 'object') {
        ephemeral5mTokens = usageObject.cache_creation.ephemeral_5m_input_tokens || 0
        ephemeral1hTokens = usageObject.cache_creation.ephemeral_1h_input_tokens || 0
      }

      // 提取媒体使用数据（图片、视频）
      const inputImages = usageObject.input_images || 0
      const outputImages = usageObject.output_images || 0
      const outputDurationSeconds = usageObject.output_duration_seconds || 0

      // 记录API Key级别的使用统计 - 这个必须执行
      await redis.incrementTokenUsage(
        keyId,
        totalTokens,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        model,
        ephemeral5mTokens, // 传递5分钟缓存 tokens
        ephemeral1hTokens, // 传递1小时缓存 tokens
        costInfo.isLongContextRequest || false // 传递 1M 上下文请求标记
      )

      // 记录媒体使用统计（如果有媒体使用）
      if (inputImages > 0 || outputImages > 0 || outputDurationSeconds > 0) {
        await redis.incrementMediaUsage(
          keyId,
          inputImages,
          outputImages,
          outputDurationSeconds,
          model
        )
      }

      // 记录费用统计
      logger.info(
        `💰 Cost recording - keyId: ${keyId}, totalCost: $${costInfo.totalCost?.toFixed(6)}, mediaTotalCost: $${costInfo.mediaTotalCost?.toFixed(6)}, useBooster: ${useBooster}`
      )
      if (costInfo.totalCost > 0) {
        // 检查是否使用加油包
        if (useBooster) {
          // Get current used amount and limit BEFORE incrementing (防止竞态条件)
          const currentUsed = await redis.getBoosterPackUsed(keyId)
          const keyData = await redis.getApiKey(keyId)
          const boosterPackAmount = parseFloat(keyData.boosterPackAmount || 0)

          // Check if adding this cost would exceed the limit
          if (currentUsed + costInfo.totalCost > boosterPackAmount) {
            const allowedAmount = Math.max(0, boosterPackAmount - currentUsed)
            logger.warn(
              `⚠️ Booster pack would be exceeded for ${keyId}. Cost: $${costInfo.totalCost.toFixed(6)}, Allowed: $${allowedAmount.toFixed(6)}, Current: $${currentUsed.toFixed(6)}, Limit: $${boosterPackAmount.toFixed(2)}`
            )

            // Only charge what's remaining in booster, rest goes to normal cost
            if (allowedAmount > 0) {
              await redis.incrementBoosterPackUsed(keyId, allowedAmount)
              await redis.addBoosterPackRecord(keyId, {
                timestamp: Date.now(),
                amount: allowedAmount,
                model,
                accountType: accountType || 'unknown'
              })
              logger.database(
                `🚀 Recorded partial booster usage for ${keyId}: $${allowedAmount.toFixed(6)}`
              )
            }

            // Charge the excess to normal cost
            const excessCost = costInfo.totalCost - allowedAmount
            if (excessCost > 0) {
              await redis.incrementDailyCost(keyId, excessCost)
              // 只在设置了周限制时才记录周成本
              const weeklyCostLimit = parseFloat(keyData.weeklyCostLimit || 0)
              if (weeklyCostLimit > 0) {
                await redis.incrementWeeklyCost(keyId, excessCost)
              }
              logger.database(
                `💰 Excess cost to normal for ${keyId}: $${excessCost.toFixed(6)}, model: ${model}`
              )
            }
          } else {
            // Normal booster pack usage - within limit
            await redis.incrementBoosterPackUsed(keyId, costInfo.totalCost)
            await redis.addBoosterPackRecord(keyId, {
              timestamp: Date.now(),
              amount: costInfo.totalCost,
              model,
              accountType: accountType || 'unknown'
            })
            logger.database(
              `🚀 Recorded booster pack usage for ${keyId}: $${costInfo.totalCost.toFixed(6)}, model: ${model}`
            )
          }
        } else {
          // 正常费用，不使用加油包
          await redis.incrementDailyCost(keyId, costInfo.totalCost)
          // 只在设置了周限制时才记录周成本（固定7天窗口）
          const keyDataForWeekly = await redis.getApiKey(keyId)
          const weeklyCostLimit = parseFloat(keyDataForWeekly?.weeklyCostLimit || 0)
          logger.info(
            `💰 Weekly cost check - keyId: ${keyId}, weeklyCostLimit: $${weeklyCostLimit}, totalCost: $${costInfo.totalCost.toFixed(6)}`
          )
          if (weeklyCostLimit > 0) {
            await redis.incrementWeeklyCost(keyId, costInfo.totalCost)
            logger.info(
              `💰 Weekly cost recorded - keyId: ${keyId}, amount: $${costInfo.totalCost.toFixed(6)}`
            )
          }
          logger.database(
            `💰 Recorded cost for ${keyId}: $${costInfo.totalCost.toFixed(6)}, model: ${model}`
          )
        }

        // 记录 Opus 周费用（如果适用，且非加油包）
        if (!useBooster) {
          await this.recordOpusCost(keyId, costInfo.totalCost, model, accountType)
        }

        // 记录详细的缓存费用（如果有）
        if (costInfo.ephemeral5mCost > 0 || costInfo.ephemeral1hCost > 0) {
          logger.database(
            `💰 Cache costs - 5m: $${costInfo.ephemeral5mCost.toFixed(
              6
            )}, 1h: $${costInfo.ephemeral1hCost.toFixed(6)}`
          )
        }
      } else {
        // 如果有 token 使用但费用为 0，记录警告
        if (totalTokens > 0) {
          logger.warn(
            `⚠️ No cost recorded for ${keyId} - zero cost for model: ${model} (tokens: ${totalTokens})`
          )
          logger.warn(`   This may indicate a pricing issue or model not found in pricing data`)
        } else {
          logger.debug(`💰 No cost recorded for ${keyId} - zero tokens for model: ${model}`)
        }
      }

      // 获取API Key数据以确定关联的账户
      const keyData = await redis.getApiKey(keyId)
      if (keyData && Object.keys(keyData).length > 0) {
        // 更新最后使用时间
        keyData.lastUsedAt = new Date().toISOString()
        await redis.setApiKey(keyId, keyData)

        // 记录账户级别的使用统计（只统计实际处理请求的账户）
        if (accountId) {
          await redis.incrementAccountUsage(
            accountId,
            totalTokens,
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            model,
            costInfo.isLongContextRequest || false,
            // 媒体使用字段
            inputImages,
            outputImages,
            outputDurationSeconds
          )
          logger.database(
            `📊 Recorded account usage: ${accountId} - ${totalTokens} tokens, outputImages: ${outputImages} (API Key: ${keyId})`
          )
        } else {
          logger.debug(
            '⚠️ No accountId provided for usage recording, skipping account-level statistics'
          )
        }
      }

      const usageRecord = {
        timestamp: new Date().toISOString(),
        model,
        accountId: accountId || null,
        accountType: accountType || null,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        ephemeral5mTokens,
        ephemeral1hTokens,
        totalTokens,
        // 媒体使用字段
        inputImages,
        outputImages,
        outputDurationSeconds,
        cost: Number((costInfo.totalCost || 0).toFixed(6)),
        costBreakdown: {
          input: costInfo.inputCost || 0,
          output: costInfo.outputCost || 0,
          cacheCreate: costInfo.cacheCreateCost || 0,
          cacheRead: costInfo.cacheReadCost || 0,
          ephemeral5m: costInfo.ephemeral5mCost || 0,
          ephemeral1h: costInfo.ephemeral1hCost || 0,
          // 媒体费用
          imageInput: costInfo.imageInputCost || 0,
          imageOutput: costInfo.imageOutputCost || 0,
          videoOutput: costInfo.videoOutputCost || 0,
          mediaTotal: costInfo.mediaTotalCost || 0
        },
        isLongContext: costInfo.isLongContextRequest || false,
        isMediaModel: costInfo.isMediaModel || false
      }

      await redis.addUsageRecord(keyId, usageRecord)

      const logParts = [`Model: ${model}`, `Input: ${inputTokens}`, `Output: ${outputTokens}`]
      if (cacheCreateTokens > 0) {
        logParts.push(`Cache Create: ${cacheCreateTokens}`)

        // 如果有详细的缓存创建数据，也记录它们
        if (usageObject.cache_creation) {
          const { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } =
            usageObject.cache_creation
          if (ephemeral_5m_input_tokens > 0) {
            logParts.push(`5m: ${ephemeral_5m_input_tokens}`)
          }
          if (ephemeral_1h_input_tokens > 0) {
            logParts.push(`1h: ${ephemeral_1h_input_tokens}`)
          }
        }
      }
      if (cacheReadTokens > 0) {
        logParts.push(`Cache Read: ${cacheReadTokens}`)
      }
      logParts.push(`Total: ${totalTokens} tokens`)
      // 添加媒体使用日志
      if (inputImages > 0) {
        logParts.push(`Input Images: ${inputImages}`)
      }
      if (outputImages > 0) {
        logParts.push(`Output Images: ${outputImages}`)
      }
      if (outputDurationSeconds > 0) {
        logParts.push(`Video Duration: ${outputDurationSeconds}s`)
      }

      logger.database(`📊 Recorded usage: ${keyId} - ${logParts.join(', ')}`)

      // 🔔 发布计费事件到消息队列（异步非阻塞）
      this._publishBillingEvent({
        keyId,
        keyName: keyData?.name,
        userId: keyData?.userId,
        model,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        ephemeral5mTokens,
        ephemeral1hTokens,
        totalTokens,
        cost: costInfo.totalCost || 0,
        costBreakdown: {
          input: costInfo.inputCost || 0,
          output: costInfo.outputCost || 0,
          cacheCreate: costInfo.cacheCreateCost || 0,
          cacheRead: costInfo.cacheReadCost || 0,
          ephemeral5m: costInfo.ephemeral5mCost || 0,
          ephemeral1h: costInfo.ephemeral1hCost || 0
        },
        accountId,
        accountType,
        isLongContext: costInfo.isLongContextRequest || false,
        requestTimestamp: usageRecord.timestamp
      }).catch((err) => {
        // 发布失败不影响主流程，只记录错误
        logger.warn('⚠️ Failed to publish billing event:', err.message)
      })
    } catch (error) {
      logger.error('❌ Failed to record usage:', error)
    }
  }

  async _fetchAccountInfo(accountId, accountType, cache, client) {
    if (!client || !accountId || !accountType) {
      return null
    }

    const cacheKey = `${accountType}:${accountId}`
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey)
    }

    const accountConfig = ACCOUNT_TYPE_CONFIG[accountType]
    if (!accountConfig) {
      cache.set(cacheKey, null)
      return null
    }

    const redisKey = `${accountConfig.prefix}${accountId}`
    let accountData = null
    try {
      accountData = await client.hgetall(redisKey)
    } catch (error) {
      logger.debug(`加载账号信息失败 ${redisKey}:`, error)
    }

    if (accountData && Object.keys(accountData).length > 0) {
      const displayName =
        accountData.name ||
        accountData.displayName ||
        accountData.email ||
        accountData.username ||
        accountData.description ||
        accountId

      const info = { id: accountId, name: displayName }
      cache.set(cacheKey, info)
      return info
    }

    cache.set(cacheKey, null)
    return null
  }

  async _resolveAccountByUsageRecord(usageRecord, cache, client) {
    if (!usageRecord || !client) {
      return null
    }

    const rawAccountId = usageRecord.accountId || null
    const rawAccountType = normalizeAccountTypeKey(usageRecord.accountType)
    const modelName = usageRecord.model || usageRecord.actualModel || usageRecord.service || null

    if (!rawAccountId && !rawAccountType) {
      return null
    }

    const candidateIds = new Set()
    if (rawAccountId) {
      candidateIds.add(rawAccountId)
      if (typeof rawAccountId === 'string' && rawAccountId.startsWith('responses:')) {
        candidateIds.add(rawAccountId.replace(/^responses:/, ''))
      }
      if (typeof rawAccountId === 'string' && rawAccountId.startsWith('api:')) {
        candidateIds.add(rawAccountId.replace(/^api:/, ''))
      }
    }

    if (candidateIds.size === 0) {
      return null
    }

    const typeCandidates = []
    const pushType = (type) => {
      const normalized = normalizeAccountTypeKey(type)
      if (normalized && ACCOUNT_TYPE_CONFIG[normalized] && !typeCandidates.includes(normalized)) {
        typeCandidates.push(normalized)
      }
    }

    pushType(rawAccountType)

    if (modelName) {
      const lowerModel = modelName.toLowerCase()
      if (lowerModel.includes('gpt') || lowerModel.includes('openai')) {
        pushType('openai')
        pushType('openai-responses')
        pushType('azure-openai')
      } else if (lowerModel.includes('gemini')) {
        pushType('gemini')
        pushType('gemini-api')
      } else if (lowerModel.includes('claude') || lowerModel.includes('anthropic')) {
        pushType('claude')
        pushType('claude-console')
      } else if (lowerModel.includes('droid')) {
        pushType('droid')
      }
    }

    ACCOUNT_TYPE_PRIORITY.forEach(pushType)

    for (const type of typeCandidates) {
      const accountConfig = ACCOUNT_TYPE_CONFIG[type]
      if (!accountConfig) {
        continue
      }

      for (const candidateId of candidateIds) {
        const normalizedId = sanitizeAccountIdForType(candidateId, type)
        const accountInfo = await this._fetchAccountInfo(normalizedId, type, cache, client)
        if (accountInfo) {
          return {
            accountId: normalizedId,
            accountName: accountInfo.name,
            accountType: type,
            accountCategory: ACCOUNT_CATEGORY_MAP[type] || 'other',
            rawAccountId: rawAccountId || normalizedId
          }
        }
      }
    }

    return null
  }

  async _resolveLastUsageAccount(apiKey, usageRecord, cache, client) {
    return await this._resolveAccountByUsageRecord(usageRecord, cache, client)
  }

  // 🔔 发布计费事件（内部方法）
  async _publishBillingEvent(eventData) {
    try {
      const billingEventPublisher = require('./billingEventPublisher')
      await billingEventPublisher.publishBillingEvent(eventData)
    } catch (error) {
      // 静默失败，不影响主流程
      logger.debug('Failed to publish billing event:', error.message)
    }
  }

  // 🔐 生成密钥
  _generateSecretKey() {
    return crypto.randomBytes(32).toString('hex')
  }

  // 🔒 哈希API Key
  _hashApiKey(apiKey) {
    return crypto
      .createHash('sha256')
      .update(apiKey + config.security.encryptionKey)
      .digest('hex')
  }

  // 📈 获取使用统计
  async getUsageStats(keyId, options = {}) {
    const usageStats = await redis.getUsageStats(keyId)

    // options 可能是字符串（兼容旧接口），仅当为对象时才解析
    const optionObject =
      options && typeof options === 'object' && !Array.isArray(options) ? options : {}

    if (optionObject.includeRecords === false) {
      return usageStats
    }

    const recordLimit = optionObject.recordLimit || 20
    const recentRecords = await redis.getUsageRecords(keyId, recordLimit)

    return {
      ...usageStats,
      recentRecords
    }
  }

  // 📊 获取账户使用统计
  async getAccountUsageStats(accountId) {
    return await redis.getAccountUsageStats(accountId)
  }

  // 📈 获取所有账户使用统计
  async getAllAccountsUsageStats() {
    return await redis.getAllAccountsUsageStats()
  }

  // === 用户相关方法 ===

  // 🔑 创建API Key（支持用户）
  async createApiKey(options = {}) {
    return await this.generateApiKey(options)
  }

  // 👤 获取用户的API Keys
  async getUserApiKeys(userId, includeDeleted = false) {
    try {
      const allKeys = await redis.getAllApiKeys()
      let userKeys = allKeys.filter((key) => key.userId === userId)

      // 默认过滤掉已删除的API Keys
      if (!includeDeleted) {
        userKeys = userKeys.filter((key) => key.isDeleted !== 'true')
      }

      // Populate usage stats for each user's API key (same as getAllApiKeys does)
      const userKeysWithUsage = []
      for (const key of userKeys) {
        const usage = await redis.getUsageStats(key.id)
        const dailyCost = (await redis.getDailyCost(key.id)) || 0
        const costStats = await redis.getCostStats(key.id)

        userKeysWithUsage.push({
          id: key.id,
          name: key.name,
          description: key.description,
          key: key.apiKey ? `${this.prefix}****${key.apiKey.slice(-4)}` : null, // 只显示前缀和后4位
          tokenLimit: parseInt(key.tokenLimit || 0),
          isActive: key.isActive === 'true',
          createdAt: key.createdAt,
          lastUsedAt: key.lastUsedAt,
          expiresAt: key.expiresAt,
          usage,
          dailyCost,
          totalCost: costStats.total,
          dailyCostLimit: parseFloat(key.dailyCostLimit || 0),
          totalCostLimit: parseFloat(key.totalCostLimit || 0),
          userId: key.userId,
          userUsername: key.userUsername,
          createdBy: key.createdBy,
          droidAccountId: key.droidAccountId,
          // Include deletion fields for deleted keys
          isDeleted: key.isDeleted,
          deletedAt: key.deletedAt,
          deletedBy: key.deletedBy,
          deletedByType: key.deletedByType
        })
      }

      return userKeysWithUsage
    } catch (error) {
      logger.error('❌ Failed to get user API keys:', error)
      return []
    }
  }

  // 🔍 通过ID获取API Key（检查权限）
  async getApiKeyById(keyId, userId = null) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData) {
        return null
      }

      // 如果指定了用户ID，检查权限
      if (userId && keyData.userId !== userId) {
        return null
      }

      return {
        id: keyData.id,
        name: keyData.name,
        description: keyData.description,
        key: keyData.apiKey,
        tokenLimit: parseInt(keyData.tokenLimit || 0),
        isActive: keyData.isActive === 'true',
        createdAt: keyData.createdAt,
        lastUsedAt: keyData.lastUsedAt,
        expiresAt: keyData.expiresAt,
        userId: keyData.userId,
        userUsername: keyData.userUsername,
        createdBy: keyData.createdBy,
        permissions: normalizePermissions(keyData.permissions),
        dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
        totalCostLimit: parseFloat(keyData.totalCostLimit || 0),
        // 所有平台账户绑定字段
        claudeAccountId: keyData.claudeAccountId,
        claudeConsoleAccountId: keyData.claudeConsoleAccountId,
        geminiAccountId: keyData.geminiAccountId,
        openaiAccountId: keyData.openaiAccountId,
        bedrockAccountId: keyData.bedrockAccountId,
        droidAccountId: keyData.droidAccountId,
        azureOpenaiAccountId: keyData.azureOpenaiAccountId,
        ccrAccountId: keyData.ccrAccountId
      }
    } catch (error) {
      logger.error('❌ Failed to get API key by ID:', error)
      return null
    }
  }

  // 🔍 快速获取API Key名称
  async getApiKeyName(keyId) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData) {
        return 'Unknown'
      }
      return keyData.name || 'Unknown'
    } catch (error) {
      logger.warn('❌ Failed to get API key name:', error)
      return 'Unknown'
    }
  }

  // 🔄 重新生成API Key
  async regenerateApiKey(keyId) {
    try {
      const existingKey = await redis.getApiKey(keyId)
      if (!existingKey) {
        throw new Error('API key not found')
      }

      // 生成新的key
      const newApiKey = `${this.prefix}${this._generateSecretKey()}`
      const newHashedKey = this._hashApiKey(newApiKey)

      // 删除旧的哈希映射
      const oldHashedKey = existingKey.apiKey
      await redis.deleteApiKeyHash(oldHashedKey)

      // 更新key数据
      const updatedKeyData = {
        ...existingKey,
        apiKey: newHashedKey,
        updatedAt: new Date().toISOString()
      }

      // 保存新数据并建立新的哈希映射
      await redis.setApiKey(keyId, updatedKeyData, newHashedKey)

      logger.info(`🔄 Regenerated API key: ${existingKey.name} (${keyId})`)

      return {
        id: keyId,
        name: existingKey.name,
        key: newApiKey, // 返回完整的新key
        updatedAt: updatedKeyData.updatedAt
      }
    } catch (error) {
      logger.error('❌ Failed to regenerate API key:', error)
      throw error
    }
  }

  // 🗑️ 硬删除API Key (完全移除)
  async hardDeleteApiKey(keyId) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData) {
        throw new Error('API key not found')
      }

      // 删除key数据和哈希映射
      await redis.deleteApiKey(keyId)
      await redis.deleteApiKeyHash(keyData.apiKey)

      logger.info(`🗑️ Deleted API key: ${keyData.name} (${keyId})`)
      return true
    } catch (error) {
      logger.error('❌ Failed to delete API key:', error)
      throw error
    }
  }

  // 🚫 禁用用户的所有API Keys
  async disableUserApiKeys(userId) {
    try {
      const userKeys = await this.getUserApiKeys(userId)
      let disabledCount = 0

      for (const key of userKeys) {
        if (key.isActive) {
          await this.updateApiKey(key.id, { isActive: false })
          disabledCount++
        }
      }

      logger.info(`🚫 Disabled ${disabledCount} API keys for user: ${userId}`)
      return { count: disabledCount }
    } catch (error) {
      logger.error('❌ Failed to disable user API keys:', error)
      throw error
    }
  }

  // 📊 获取聚合使用统计（支持多个API Key）
  async getAggregatedUsageStats(keyIds, options = {}) {
    try {
      if (!Array.isArray(keyIds)) {
        keyIds = [keyIds]
      }

      const { period: _period = 'week', model: _model } = options
      const stats = {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        dailyStats: [],
        modelStats: []
      }

      // 汇总所有API Key的统计数据
      for (const keyId of keyIds) {
        const keyStats = await redis.getUsageStats(keyId)
        const costStats = await redis.getCostStats(keyId)
        if (keyStats && keyStats.total) {
          stats.totalRequests += keyStats.total.requests || 0
          stats.totalInputTokens += keyStats.total.inputTokens || 0
          stats.totalOutputTokens += keyStats.total.outputTokens || 0
          stats.totalCost += costStats?.total || 0
        }
      }

      // TODO: 实现日期范围和模型统计
      // 这里可以根据需要添加更详细的统计逻辑

      return stats
    } catch (error) {
      logger.error('❌ Failed to get usage stats:', error)
      return {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        dailyStats: [],
        modelStats: []
      }
    }
  }

  // 🔓 解绑账号从所有API Keys
  async unbindAccountFromAllKeys(accountId, accountType) {
    try {
      // 账号类型与字段的映射关系
      const fieldMap = {
        claude: 'claudeAccountId',
        'claude-console': 'claudeConsoleAccountId',
        gemini: 'geminiAccountId',
        'gemini-api': 'geminiAccountId', // 特殊处理，带 api: 前缀
        openai: 'openaiAccountId',
        'openai-responses': 'openaiAccountId', // 特殊处理，带 responses: 前缀
        azure_openai: 'azureOpenaiAccountId',
        bedrock: 'bedrockAccountId',
        droid: 'droidAccountId',
        ccr: null // CCR 账号没有对应的 API Key 字段
      }

      const field = fieldMap[accountType]
      if (!field) {
        logger.info(`账号类型 ${accountType} 不需要解绑 API Key`)
        return 0
      }

      // 获取所有API Keys
      const allKeys = await this.getAllApiKeys()

      // 筛选绑定到此账号的 API Keys
      let boundKeys = []
      if (accountType === 'openai-responses') {
        // OpenAI-Responses 特殊处理：查找 openaiAccountId 字段中带 responses: 前缀的
        boundKeys = allKeys.filter((key) => key.openaiAccountId === `responses:${accountId}`)
      } else if (accountType === 'gemini-api') {
        // Gemini-API 特殊处理：查找 geminiAccountId 字段中带 api: 前缀的
        boundKeys = allKeys.filter((key) => key.geminiAccountId === `api:${accountId}`)
      } else {
        // 其他账号类型正常匹配
        boundKeys = allKeys.filter((key) => key[field] === accountId)
      }

      // 批量解绑
      for (const key of boundKeys) {
        const updates = {}
        if (accountType === 'openai-responses') {
          updates.openaiAccountId = null
        } else if (accountType === 'gemini-api') {
          updates.geminiAccountId = null
        } else if (accountType === 'claude-console') {
          updates.claudeConsoleAccountId = null
        } else {
          updates[field] = null
        }

        await this.updateApiKey(key.id, updates)
        logger.info(
          `✅ 自动解绑 API Key ${key.id} (${key.name}) 从 ${accountType} 账号 ${accountId}`
        )
      }

      if (boundKeys.length > 0) {
        logger.success(
          `🔓 成功解绑 ${boundKeys.length} 个 API Key 从 ${accountType} 账号 ${accountId}`
        )
      }

      return boundKeys.length
    } catch (error) {
      logger.error(`❌ 解绑 API Keys 失败 (${accountType} 账号 ${accountId}):`, error)
      return 0
    }
  }

  // 🧹 清理过期的API Keys
  async cleanupExpiredKeys() {
    try {
      const apiKeys = await redis.getAllApiKeys()
      const now = new Date()
      let cleanedCount = 0

      for (const key of apiKeys) {
        // 检查是否已过期且仍处于激活状态
        if (key.expiresAt && new Date(key.expiresAt) < now && key.isActive === 'true') {
          // 将过期的 API Key 标记为禁用状态，而不是直接删除
          await this.updateApiKey(key.id, { isActive: false })
          logger.info(`🔒 API Key ${key.id} (${key.name}) has expired and been disabled`)
          cleanedCount++
        }
      }

      if (cleanedCount > 0) {
        logger.success(`🧹 Disabled ${cleanedCount} expired API keys`)
      }

      return cleanedCount
    } catch (error) {
      logger.error('❌ Failed to cleanup expired keys:', error)
      return 0
    }
  }

  /**
   * 构建账户ID→名称的映射表，用于按所属账号搜索
   * @returns {Map<string, string>} accountId → accountName
   */
  async _buildAccountNameMap() {
    const nameMap = new Map()
    try {
      const claudeAccountService = require('./claudeAccountService')
      const claudeConsoleAccountService = require('./claudeConsoleAccountService')
      const geminiAccountService = require('./geminiAccountService')
      const geminiApiAccountService = require('./geminiApiAccountService')
      const openaiResponsesAccountService = require('./openaiResponsesAccountService')
      const bedrockAccountService = require('./bedrockAccountService')
      const droidAccountService = require('./droidAccountService')
      const azureOpenaiAccountService = require('./azureOpenaiAccountService')
      const accountGroupService = require('./accountGroupService')

      // 并行获取所有账户列表
      const [
        claudeAccounts,
        consoleAccounts,
        geminiAccounts,
        geminiApiAccounts,
        openaiResponsesAccounts,
        bedrockAccounts,
        droidAccounts,
        azureAccounts,
        allGroups
      ] = await Promise.all([
        claudeAccountService.getAllAccounts({ skipExtendedInfo: true }).catch(() => []),
        claudeConsoleAccountService.getAllAccounts({ skipExtendedInfo: true }).catch(() => []),
        geminiAccountService.getAllAccounts().catch(() => []),
        geminiApiAccountService.getAllAccounts(true).catch(() => []),
        openaiResponsesAccountService.getAllAccounts(true).catch(() => []),
        bedrockAccountService
          .getAllAccounts()
          .then((result) => (Array.isArray(result) ? result : result?.data || []))
          .catch(() => []),
        droidAccountService.getAllAccounts().catch(() => []),
        azureOpenaiAccountService.getAllAccounts().catch(() => []),
        accountGroupService.getAllGroups().catch(() => [])
      ])

      // Claude 官方账户
      for (const acc of claudeAccounts) {
        if (acc.id && acc.name) {
          nameMap.set(acc.id, acc.name)
        }
      }
      // Claude Console 账户
      for (const acc of consoleAccounts) {
        if (acc.id && acc.name) {
          nameMap.set(acc.id, acc.name)
        }
      }
      // Gemini OAuth 账户
      for (const acc of geminiAccounts) {
        if (acc.id && acc.name) {
          nameMap.set(acc.id, acc.name)
        }
      }
      // Gemini API 账户
      for (const acc of geminiApiAccounts) {
        if (acc.id && acc.name) {
          nameMap.set(acc.id, acc.name)
          nameMap.set(`api:${acc.id}`, acc.name)
        }
      }
      // OpenAI Responses 账户
      for (const acc of openaiResponsesAccounts) {
        if (acc.id && acc.name) {
          nameMap.set(acc.id, acc.name)
          nameMap.set(`responses:${acc.id}`, acc.name)
        }
      }
      // Bedrock 账户
      for (const acc of bedrockAccounts) {
        if (acc.id && acc.name) {
          nameMap.set(acc.id, acc.name)
        }
      }
      // Droid 账户
      for (const acc of droidAccounts) {
        if (acc.id && acc.name) {
          nameMap.set(acc.id, acc.name)
        }
      }
      // Azure OpenAI 账户
      for (const acc of azureAccounts) {
        if (acc.id && acc.name) {
          nameMap.set(acc.id, acc.name)
        }
      }
      // 账户分组
      for (const group of allGroups) {
        if (group.id && group.name) {
          nameMap.set(`group:${group.id}`, group.name)
        }
      }
    } catch (error) {
      logger.error('❌ Failed to build account name map:', error)
    }
    return nameMap
  }
}

// 导出实例和单独的方法
const apiKeyService = new ApiKeyService()

// 为了方便其他服务调用，导出 recordUsage 方法
apiKeyService.recordUsageMetrics = apiKeyService.recordUsage.bind(apiKeyService)

// 导出权限辅助函数供路由使用
apiKeyService.hasPermission = hasPermission
apiKeyService.normalizePermissions = normalizePermissions

module.exports = apiKeyService
