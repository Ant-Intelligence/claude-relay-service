const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')
const pricingSource = require('../../config/pricingSource')
const logger = require('../utils/logger')

class PricingService {
  constructor() {
    this.dataDir = path.join(process.cwd(), 'data')
    this.pricingFile = path.join(this.dataDir, 'model_pricing.json')
    this.pricingUrl = pricingSource.pricingUrl
    this.hashUrl = pricingSource.hashUrl
    this.fallbackFile = path.join(
      process.cwd(),
      'resources',
      'model-pricing',
      'model_prices_and_context_window.json'
    )
    this.localHashFile = path.join(this.dataDir, 'model_pricing.sha256')
    this.pricingData = null
    this.lastUpdated = null
    this.updateInterval = 24 * 60 * 60 * 1000 // 24小时
    this.hashCheckInterval = 10 * 60 * 1000 // 10分钟哈希校验
    this.fileWatcher = null // 文件监听器
    this.reloadDebounceTimer = null // 防抖定时器
    this.hashCheckTimer = null // 哈希轮询定时器
    this.updateTimer = null // 定时更新任务句柄
    this.hashSyncInProgress = false // 哈希同步状态

    // 1 小时缓存价格（美元/token），从 model_pricing.json 的 cache_creation_input_token_cost_above_1hr 字段动态构建
    // ephemeral_5m 的价格使用 model_pricing.json 中的 cache_creation_input_token_cost
    // 在 pricingData 加载后通过 buildEphemeral1hPricing() 自动填充
    this.ephemeral1hPricing = {}

    // Claude 缓存价格倍率（相对于 input_cost_per_token）
    this.claudeCacheMultipliers = { write5m: 1.25, write1h: 2, read: 0.1 }

    // Claude 功能特性标识
    this.claudeFeatureFlags = {
      context1mBeta: 'context-1m-2025-08-07',
      fastModeBeta: 'fast-mode-2026-02-01',
      fastModeSpeed: 'fast'
    }
  }

  // 初始化价格服务
  async initialize() {
    try {
      // 确保data目录存在
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true })
        logger.info('📁 Created data directory')
      }

      // 检查是否需要下载或更新价格数据
      await this.checkAndUpdatePricing()

      // 初次启动时执行一次哈希校验，确保与远端保持一致
      await this.syncWithRemoteHash()

      // 设置定时更新
      if (this.updateTimer) {
        clearInterval(this.updateTimer)
      }
      this.updateTimer = setInterval(() => {
        this.checkAndUpdatePricing()
      }, this.updateInterval)

      // 设置哈希轮询
      this.setupHashCheck()

      // 设置文件监听器
      this.setupFileWatcher()

      logger.success('💰 Pricing service initialized successfully')
    } catch (error) {
      logger.error('❌ Failed to initialize pricing service:', error)
    }
  }

  // 检查并更新价格数据
  async checkAndUpdatePricing() {
    try {
      const needsUpdate = this.needsUpdate()

      if (needsUpdate) {
        logger.info('🔄 Updating model pricing data...')
        await this.downloadPricingData()
      } else {
        // 如果不需要更新，加载现有数据
        await this.loadPricingData()
      }
    } catch (error) {
      logger.error('❌ Failed to check/update pricing:', error)
      // 如果更新失败，尝试使用fallback
      await this.useFallbackPricing()
    }
  }

  // 检查是否需要更新
  needsUpdate() {
    if (!fs.existsSync(this.pricingFile)) {
      logger.info('📋 Pricing file not found, will download')
      return true
    }

    const stats = fs.statSync(this.pricingFile)
    const fileAge = Date.now() - stats.mtime.getTime()

    if (fileAge > this.updateInterval) {
      logger.info(
        `📋 Pricing file is ${Math.round(fileAge / (60 * 60 * 1000))} hours old, will update`
      )
      return true
    }

    return false
  }

  // 下载价格数据
  async downloadPricingData() {
    try {
      await this._downloadFromRemote()
    } catch (downloadError) {
      logger.warn(`⚠️  Failed to download pricing data: ${downloadError.message}`)
      logger.info('📋 Using local fallback pricing data...')
      await this.useFallbackPricing()
    }
  }

  // 哈希轮询设置
  setupHashCheck() {
    if (this.hashCheckTimer) {
      clearInterval(this.hashCheckTimer)
    }

    this.hashCheckTimer = setInterval(() => {
      this.syncWithRemoteHash()
    }, this.hashCheckInterval)

    logger.info('🕒 已启用价格文件哈希轮询（每10分钟校验一次）')
  }

  // 与远端哈希对比
  async syncWithRemoteHash() {
    if (this.hashSyncInProgress) {
      return
    }

    this.hashSyncInProgress = true
    try {
      const remoteHash = await this.fetchRemoteHash()

      if (!remoteHash) {
        return
      }

      const localHash = this.computeLocalHash()

      if (!localHash) {
        logger.info('📄 本地价格文件缺失，尝试下载最新版本')
        await this.downloadPricingData()
        return
      }

      if (remoteHash !== localHash) {
        logger.info('🔁 检测到远端价格文件更新，开始下载最新数据')
        await this.downloadPricingData()
      }
    } catch (error) {
      logger.warn(`⚠️  哈希校验失败：${error.message}`)
    } finally {
      this.hashSyncInProgress = false
    }
  }

  // 获取远端哈希值
  fetchRemoteHash() {
    return new Promise((resolve, reject) => {
      const request = https.get(this.hashUrl, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`哈希文件获取失败：HTTP ${response.statusCode}`))
          return
        }

        let data = ''
        response.on('data', (chunk) => {
          data += chunk
        })

        response.on('end', () => {
          const hash = data.trim().split(/\s+/)[0]

          if (!hash) {
            reject(new Error('哈希文件内容为空'))
            return
          }

          resolve(hash)
        })
      })

      request.on('error', (error) => {
        reject(new Error(`网络错误：${error.message}`))
      })

      request.setTimeout(30000, () => {
        request.destroy()
        reject(new Error('获取哈希超时（30秒）'))
      })
    })
  }

  // 计算本地文件哈希
  computeLocalHash() {
    if (!fs.existsSync(this.pricingFile)) {
      return null
    }

    if (fs.existsSync(this.localHashFile)) {
      const cached = fs.readFileSync(this.localHashFile, 'utf8').trim()
      if (cached) {
        return cached
      }
    }

    const fileBuffer = fs.readFileSync(this.pricingFile)
    return this.persistLocalHash(fileBuffer)
  }

  // 写入本地哈希文件
  persistLocalHash(content) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')
    fs.writeFileSync(this.localHashFile, `${hash}\n`)
    return hash
  }

  // 实际的下载逻辑
  _downloadFromRemote() {
    return new Promise((resolve, reject) => {
      const request = https.get(this.pricingUrl, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
          return
        }

        const chunks = []
        response.on('data', (chunk) => {
          const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          chunks.push(bufferChunk)
        })

        response.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks)
            const rawContent = buffer.toString('utf8')
            const jsonData = JSON.parse(rawContent)

            // 保存到文件并更新哈希
            fs.writeFileSync(this.pricingFile, rawContent)
            this.persistLocalHash(buffer)

            // 更新内存中的数据
            this.pricingData = jsonData
            this.lastUpdated = new Date()
            this.buildEphemeral1hPricing()

            logger.success(`💰 Downloaded pricing data for ${Object.keys(jsonData).length} models`)

            // 设置或重新设置文件监听器
            this.setupFileWatcher()

            resolve()
          } catch (error) {
            reject(new Error(`Failed to parse pricing data: ${error.message}`))
          }
        })
      })

      request.on('error', (error) => {
        reject(new Error(`Network error: ${error.message}`))
      })

      request.setTimeout(30000, () => {
        request.destroy()
        reject(new Error('Download timeout after 30 seconds'))
      })
    })
  }

  // 加载本地价格数据
  async loadPricingData() {
    try {
      if (fs.existsSync(this.pricingFile)) {
        const data = fs.readFileSync(this.pricingFile, 'utf8')
        this.pricingData = JSON.parse(data)

        const stats = fs.statSync(this.pricingFile)
        this.lastUpdated = stats.mtime
        this.buildEphemeral1hPricing()

        logger.info(
          `💰 Loaded pricing data for ${Object.keys(this.pricingData).length} models from cache`
        )
      } else {
        logger.warn('💰 No pricing data file found, will use fallback')
        await this.useFallbackPricing()
      }
    } catch (error) {
      logger.error('❌ Failed to load pricing data:', error)
      await this.useFallbackPricing()
    }
  }

  // 从 pricingData 中构建 ephemeral1hPricing 映射表（仅 Claude 官方模型）
  buildEphemeral1hPricing() {
    if (!this.pricingData) {
      return
    }

    const newMap = {}
    for (const [model, pricing] of Object.entries(this.pricingData)) {
      if (
        model.startsWith('claude-') &&
        !model.includes('/') &&
        !model.includes('.') &&
        pricing?.cache_creation_input_token_cost_above_1hr
      ) {
        newMap[model] = pricing.cache_creation_input_token_cost_above_1hr
      }
    }

    this.ephemeral1hPricing = newMap
    logger.info(`💰 Built ephemeral 1h pricing map: ${Object.keys(newMap).length} models`)
  }

  // 使用fallback价格数据
  async useFallbackPricing() {
    try {
      if (fs.existsSync(this.fallbackFile)) {
        logger.info('📋 Copying fallback pricing data to data directory...')

        // 读取fallback文件
        const fallbackData = fs.readFileSync(this.fallbackFile, 'utf8')
        const jsonData = JSON.parse(fallbackData)

        const formattedJson = JSON.stringify(jsonData, null, 2)

        // 保存到data目录
        fs.writeFileSync(this.pricingFile, formattedJson)
        this.persistLocalHash(formattedJson)

        // 更新内存中的数据
        this.pricingData = jsonData
        this.lastUpdated = new Date()
        this.buildEphemeral1hPricing()

        // 设置或重新设置文件监听器
        this.setupFileWatcher()

        logger.warn(`⚠️  Using fallback pricing data for ${Object.keys(jsonData).length} models`)
        logger.info(
          '💡 Note: This fallback data may be outdated. The system will try to update from the remote source on next check.'
        )
      } else {
        logger.error('❌ Fallback pricing file not found at:', this.fallbackFile)
        logger.error(
          '❌ Please ensure the resources/model-pricing directory exists with the pricing file'
        )
        this.pricingData = {}
        this.buildEphemeral1hPricing()
      }
    } catch (error) {
      logger.error('❌ Failed to use fallback pricing data:', error)
      this.pricingData = {}
      this.buildEphemeral1hPricing()
    }
  }

  // 获取模型价格信息
  getModelPricing(modelName) {
    if (!this.pricingData || !modelName) {
      return null
    }

    // 尝试直接匹配
    if (this.pricingData[modelName]) {
      logger.debug(`💰 Found exact pricing match for ${modelName}`)
      return this.pricingData[modelName]
    }

    // 特殊处理：gpt-5-codex 回退到 gpt-5
    if (modelName === 'gpt-5-codex' && !this.pricingData['gpt-5-codex']) {
      const fallbackPricing = this.pricingData['gpt-5']
      if (fallbackPricing) {
        logger.info(`💰 Using gpt-5 pricing as fallback for ${modelName}`)
        return fallbackPricing
      }
    }

    // 特殊处理：gpt-5.4 回退到 gpt-5.3-codex 或 gpt-5（OpenAI 尚未公布 gpt-5.4 API 定价）
    if (modelName === 'gpt-5.4' && !this.pricingData['gpt-5.4']) {
      const fallbackPricing = this.pricingData['gpt-5.3-codex'] || this.pricingData['gpt-5']
      if (fallbackPricing) {
        logger.info(`💰 Using gpt-5.3-codex/gpt-5 pricing as fallback for ${modelName}`)
        return fallbackPricing
      }
    }

    // 特殊处理：gpt-5.3-codex 回退到 gpt-5.2-codex（OpenAI 尚未公布 gpt-5.3-codex API 定价）
    if (modelName === 'gpt-5.3-codex' && !this.pricingData['gpt-5.3-codex']) {
      const fallbackPricing = this.pricingData['gpt-5.2-codex']
      if (fallbackPricing) {
        logger.info(`💰 Using gpt-5.2-codex pricing as fallback for ${modelName}`)
        return fallbackPricing
      }
    }

    // 对于Bedrock区域前缀模型（如 us.anthropic.claude-sonnet-4-20250514-v1:0），
    // 尝试去掉区域前缀进行匹配
    if (modelName.includes('.anthropic.') || modelName.includes('.claude')) {
      // 提取不带区域前缀的模型名
      const withoutRegion = modelName.replace(/^(us|eu|apac)\./, '')
      if (this.pricingData[withoutRegion]) {
        logger.debug(
          `💰 Found pricing for ${modelName} by removing region prefix: ${withoutRegion}`
        )
        return this.pricingData[withoutRegion]
      }
    }

    // 尝试模糊匹配（处理版本号等变化）
    const normalizedModel = modelName.toLowerCase().replace(/[_-]/g, '')
    const modelHasVendorPrefix = modelName.includes('/')

    for (const [key, value] of Object.entries(this.pricingData)) {
      // 跳过带 vendor 前缀的 key（如 github_copilot/xxx、openai/xxx），
      // 避免将无前缀模型名（如 gpt-5.3-codex）误匹配到其他 provider 的同名 key
      if (key.includes('/') && !modelHasVendorPrefix) {
        continue
      }
      const normalizedKey = key.toLowerCase().replace(/[_-]/g, '')
      if (normalizedKey.includes(normalizedModel) || normalizedModel.includes(normalizedKey)) {
        logger.debug(`💰 Found pricing for ${modelName} using fuzzy match: ${key}`)
        return value
      }
    }

    // 对于Bedrock模型，尝试更智能的匹配
    if (modelName.includes('anthropic.claude')) {
      // 提取核心模型名部分（去掉区域和前缀）
      const coreModel = modelName.replace(/^(us|eu|apac)\./, '').replace('anthropic.', '')

      for (const [key, value] of Object.entries(this.pricingData)) {
        if (key.includes(coreModel) || key.replace('anthropic.', '').includes(coreModel)) {
          logger.debug(`💰 Found pricing for ${modelName} using Bedrock core model match: ${key}`)
          return value
        }
      }
    }

    logger.debug(`💰 No pricing found for model: ${modelName}`)
    return null
  }

  // 确保价格对象包含缓存价格
  ensureCachePricing(pricing) {
    if (!pricing) {
      return pricing
    }

    // 如果缺少缓存价格，根据输入价格计算（缓存创建价格通常是输入价格的1.25倍，缓存读取是0.1倍）
    if (!pricing.cache_creation_input_token_cost && pricing.input_cost_per_token) {
      pricing.cache_creation_input_token_cost = pricing.input_cost_per_token * 1.25
    }
    if (!pricing.cache_read_input_token_cost && pricing.input_cost_per_token) {
      pricing.cache_read_input_token_cost = pricing.input_cost_per_token * 0.1
    }
    return pricing
  }

  // 获取 1 小时缓存价格
  getEphemeral1hPricing(modelName, pricing = null) {
    if (!modelName) {
      return 0
    }

    // 如果传入了 pricing 对象，优先使用其 cache_creation_input_token_cost_above_1hr 字段
    const pricingVal = pricing?.cache_creation_input_token_cost_above_1hr
    if (pricingVal !== null && pricingVal !== undefined) {
      return pricingVal
    }

    // 尝试直接匹配（从 model_pricing.json 动态构建的映射表）
    if (this.ephemeral1hPricing[modelName]) {
      return this.ephemeral1hPricing[modelName]
    }

    // 尝试通过 getModelPricing 模糊匹配（处理 Bedrock 区域前缀等变体模型名）
    const lookedUp = this.getModelPricing(modelName)
    if (lookedUp?.cache_creation_input_token_cost_above_1hr) {
      logger.debug(
        `💰 Found 1h cache pricing for ${modelName} via fuzzy match: ${lookedUp.cache_creation_input_token_cost_above_1hr}`
      )
      return lookedUp.cache_creation_input_token_cost_above_1hr
    }

    // 兜底：仅在 model_pricing.json 中完全找不到该模型时触发，使用最新主力模型价格
    const modelLower = modelName.toLowerCase()

    if (modelLower.includes('opus')) {
      return 0.00001 // $10/MTok (opus-4-5/4-6)
    }

    // 检查是否是 Sonnet 系列
    if (modelLower.includes('sonnet')) {
      return 0.000006 // $6/MTok
    }

    // 检查是否是 Haiku 系列
    if (modelLower.includes('haiku')) {
      return 0.000002 // $2/MTok (haiku-4-5)
    }

    // 默认返回 0（未知模型）
    logger.debug(`💰 No 1h cache pricing found for model: ${modelName}`)
    return 0
  }

  // ========== Media Billing Helper Functions ==========

  /**
   * Parse resolution string to pixel dimensions
   * @param {string|null} resolution - Resolution string (e.g., "1024x1024")
   * @returns {Object} Object with width, height, and total pixels
   */
  parseResolutionToPixels(resolution) {
    if (!resolution || typeof resolution !== 'string') {
      return { width: 0, height: 0, pixels: 0 }
    }
    const match = resolution.match(/^(\d+)x(\d+)$/)
    if (!match) {
      logger.debug(`💰 Invalid resolution format: ${resolution}`)
      return { width: 0, height: 0, pixels: 0 }
    }
    const width = parseInt(match[1], 10)
    const height = parseInt(match[2], 10)
    return { width, height, pixels: width * height }
  }

  /**
   * Check if pricing indicates a media generation model
   * @param {Object|null} pricing - Pricing data object
   * @returns {boolean} True if model is a media generation model
   */
  isMediaModel(pricing) {
    if (!pricing || !pricing.mode) {
      return false
    }
    return ['image_generation', 'video_generation', 'audio_generation'].includes(pricing.mode)
  }

  /**
   * Check if pricing indicates an image generation model
   * @param {Object|null} pricing - Pricing data object
   * @returns {boolean} True if model is an image generation model
   */
  isImageGenerationModel(pricing) {
    return pricing?.mode === 'image_generation'
  }

  /**
   * Check if pricing indicates a video generation model
   * @param {Object|null} pricing - Pricing data object
   * @returns {boolean} True if model is a video generation model
   */
  isVideoGenerationModel(pricing) {
    return pricing?.mode === 'video_generation'
  }

  // 从 usage 中提取 anthropic-beta 功能集合
  extractBetaFeatures(usage) {
    const betaStr = usage?.request_anthropic_beta || ''
    if (!betaStr) {
      return new Set()
    }
    return new Set(betaStr.split(',').map((s) => s.trim()))
  }

  // 从 usage 中提取 speed 信号（响应 speed 或请求 request_speed）
  extractSpeedSignal(usage) {
    return usage?.speed || usage?.request_speed || null
  }

  // 去除模型名称中的 [1m] 后缀
  stripLongContextSuffix(modelName) {
    if (!modelName) {
      return modelName
    }
    return modelName.replace(/\[1m\]$/, '')
  }

  // 计算使用费用
  calculateCost(usage, modelName) {
    const noPricingResult = {
      inputCost: 0,
      outputCost: 0,
      cacheCreateCost: 0,
      cacheReadCost: 0,
      ephemeral5mCost: 0,
      ephemeral1hCost: 0,
      imageInputCost: 0,
      imageOutputCost: 0,
      imageTotalCost: 0,
      videoOutputCost: 0,
      mediaTotalCost: 0,
      totalCost: 0,
      hasPricing: false,
      isLongContextRequest: false,
      isFastMode: false,
      isImageModel: false,
      isVideoModel: false,
      isMediaModel: false,
      pricing: {
        input: 0,
        output: 0,
        cacheCreate: 0,
        cacheRead: 0,
        ephemeral1h: 0,
        inputPerImage: 0,
        outputPerImage: 0,
        outputPerImageToken: 0,
        inputPerPixel: 0,
        outputPerPixel: 0,
        outputPerSecond: 0
      }
    }

    // ========== Feature Detection ==========
    const betaFeatures = this.extractBetaFeatures(usage)
    const speedSignal = this.extractSpeedSignal(usage)

    // 检查 context-1m beta（触发 200K+ 定价，无需 [1m] 后缀）
    const hasContext1mBeta = betaFeatures.has(this.claudeFeatureFlags.context1mBeta)

    // 检查 fast mode（需要 beta header 和 speed 信号同时出现才确认）
    const hasFastModeBeta = betaFeatures.has(this.claudeFeatureFlags.fastModeBeta)
    const hasFastSpeed = speedSignal === this.claudeFeatureFlags.fastModeSpeed
    const isFastModeRequest = hasFastModeBeta && hasFastSpeed

    // 去除 [1m] 后缀以获取基础模型名
    const baseModelName = this.stripLongContextSuffix(modelName)
    const isLongContextModel = modelName && modelName.includes('[1m]')

    // ========== Pricing Lookup ==========
    const pricing = this.getModelPricing(modelName)

    // Fast Mode 倍率：从 provider_specific_entry.fast 读取，没有则不应用
    const fastMultiplier =
      isFastModeRequest && pricing?.provider_specific_entry?.fast
        ? pricing.provider_specific_entry.fast
        : 1
    const isFastMode = fastMultiplier > 1

    if (isFastMode) {
      logger.info(
        `🚀 Fast mode ${fastMultiplier}x multiplier applied for ${baseModelName} (from provider_specific_entry)`
      )
    } else if (isFastModeRequest) {
      logger.warn(
        `⚠️ Fast mode request detected but no fast pricing found for ${baseModelName}; fallback to standard profile`
      )
    }

    // Detect media model types
    const isImageModel = this.isImageGenerationModel(pricing)
    const isVideoModel = this.isVideoGenerationModel(pricing)
    const isMediaModelFlag = isImageModel || isVideoModel

    if (!pricing) {
      return noPricingResult
    }

    // ========== 200K+ Long Context Detection ==========
    const inputTokens = usage.input_tokens || 0
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0
    const cacheReadTokens = usage.cache_read_input_tokens || 0
    const totalInputTokens = inputTokens + cacheCreationTokens + cacheReadTokens

    // 200K+ 定价触发条件：[1m] 后缀 或 context-1m beta，且总输入超过 200k
    const isLongContextRequest =
      (isLongContextModel || hasContext1mBeta) && totalInputTokens > 200000

    // ========== Input/Output Cost ==========
    let inputPrice = pricing.input_cost_per_token || 0
    let outputPrice = pricing.output_cost_per_token || 0

    if (isLongContextRequest) {
      // 优先使用 model_pricing.json 中的 above_200k 字段
      if (pricing.input_cost_per_token_above_200k_tokens !== undefined) {
        inputPrice = pricing.input_cost_per_token_above_200k_tokens
      } else if (baseModelName.startsWith('claude-')) {
        // Claude 模型兜底：2× 基础输入价格
        inputPrice = (pricing.input_cost_per_token || 0) * 2
        logger.info(`💰 Using 200K+ fallback (2× input) for ${modelName}: $${inputPrice}/token`)
      }
      if (pricing.output_cost_per_token_above_200k_tokens !== undefined) {
        outputPrice = pricing.output_cost_per_token_above_200k_tokens
      }
      logger.info(
        `💰 Using 200K+ pricing for ${modelName}: input=$${inputPrice}/token, output=$${outputPrice}/token`
      )
    }

    // ========== Cache Pricing ==========
    // 对于 Claude 模型，如果 model_pricing.json 缺少 cache 字段，通过 input × multiplier 推导
    const isClaudeModel = baseModelName.startsWith('claude-')

    let cacheWritePrice = pricing.cache_creation_input_token_cost
    let cacheReadPrice = pricing.cache_read_input_token_cost
    let cache1hWritePrice = pricing.cache_creation_input_token_cost_above_1hr

    if (isClaudeModel && cacheWritePrice === undefined) {
      cacheWritePrice = (pricing.input_cost_per_token || 0) * this.claudeCacheMultipliers.write5m
    }
    if (isClaudeModel && cache1hWritePrice === undefined) {
      cache1hWritePrice = (pricing.input_cost_per_token || 0) * this.claudeCacheMultipliers.write1h
    }
    if (isClaudeModel && cacheReadPrice === undefined) {
      cacheReadPrice = (pricing.input_cost_per_token || 0) * this.claudeCacheMultipliers.read
    }

    // 200K+ 时也升级 cache 价格
    if (isLongContextRequest) {
      if (pricing.cache_creation_input_token_cost_above_200k_tokens !== undefined) {
        cacheWritePrice = pricing.cache_creation_input_token_cost_above_200k_tokens
      }
      if (pricing.cache_read_input_token_cost_above_200k_tokens !== undefined) {
        cacheReadPrice = pricing.cache_read_input_token_cost_above_200k_tokens
      }
    }

    cacheWritePrice = cacheWritePrice || 0
    cacheReadPrice = cacheReadPrice || 0
    cache1hWritePrice = cache1hWritePrice || 0

    // ========== 应用 Fast Mode 倍率（在 200K+ 价格之上叠加） ==========
    if (fastMultiplier > 1) {
      inputPrice *= fastMultiplier
      outputPrice *= fastMultiplier
      cacheWritePrice *= fastMultiplier
      cacheReadPrice *= fastMultiplier
      cache1hWritePrice *= fastMultiplier
    }

    const inputCost = inputTokens * inputPrice
    const outputCost = (usage.output_tokens || 0) * outputPrice

    const cacheReadCost = (usage.cache_read_input_tokens || 0) * cacheReadPrice

    // 处理缓存创建费用
    let ephemeral5mCost = 0
    let ephemeral1hCost = 0
    let cacheCreateCost = 0

    if (usage.cache_creation && typeof usage.cache_creation === 'object') {
      const ephemeral5mTokens = usage.cache_creation.ephemeral_5m_input_tokens || 0
      const ephemeral1hTokens = usage.cache_creation.ephemeral_1h_input_tokens || 0
      const totalCacheTokens = ephemeral5mTokens + ephemeral1hTokens

      cacheCreateCost = totalCacheTokens * cacheWritePrice
      ephemeral5mCost = ephemeral5mTokens * cacheWritePrice
      ephemeral1hCost = ephemeral1hTokens * cacheWritePrice
    } else if (usage.cache_creation_input_tokens) {
      cacheCreateCost = (usage.cache_creation_input_tokens || 0) * cacheWritePrice
      ephemeral5mCost = cacheCreateCost
    }

    // ========== Media Cost Calculation ==========
    let imageInputCost = 0
    let imageOutputCost = 0
    let videoOutputCost = 0

    // Image billing calculation
    if (isImageModel) {
      const inputImages = usage.input_images || 0
      const outputImages = usage.output_images || 0
      logger.info(
        `🖼️ Image cost calculation for ${modelName}: isImageModel=${isImageModel}, outputImages=${outputImages}, output_cost_per_image=${pricing?.output_cost_per_image}`
      )

      // Calculate pixel counts if resolution is provided but pixel counts are not
      let inputPixels = usage.input_pixels || 0
      let outputPixels = usage.output_pixels || 0

      if (usage.image_resolution && (!inputPixels || !outputPixels)) {
        const parsed = this.parseResolutionToPixels(usage.image_resolution)
        if (parsed.pixels > 0) {
          if (!inputPixels && inputImages > 0) {
            inputPixels = parsed.pixels * inputImages
          }
          if (!outputPixels && outputImages > 0) {
            outputPixels = parsed.pixels * outputImages
          }
        }
      }

      // Image output cost calculation (priority: per-image → per-pixel → per-token)
      if (pricing.output_cost_per_image && outputImages > 0) {
        imageOutputCost = outputImages * pricing.output_cost_per_image
      } else if (pricing.output_cost_per_pixel && outputPixels > 0) {
        imageOutputCost = outputPixels * pricing.output_cost_per_pixel
      } else if (pricing.output_cost_per_image_token && (usage.output_tokens || 0) > 0) {
        // Token-based fallback for image output
        imageOutputCost = (usage.output_tokens || 0) * pricing.output_cost_per_image_token
      }

      // Image input cost calculation (priority: per-image → per-pixel)
      if (pricing.input_cost_per_image && inputImages > 0) {
        imageInputCost = inputImages * pricing.input_cost_per_image
      } else if (pricing.input_cost_per_pixel && inputPixels > 0) {
        imageInputCost = inputPixels * pricing.input_cost_per_pixel
      }

      if (imageInputCost > 0 || imageOutputCost > 0) {
        logger.debug(
          `💰 Image billing for ${modelName}: input=${inputImages} images ($${imageInputCost.toFixed(6)}), output=${outputImages} images ($${imageOutputCost.toFixed(6)})`
        )
      }
    }

    // Video billing calculation
    if (isVideoModel) {
      const outputDurationSeconds = usage.output_duration_seconds || 0

      if (pricing.output_cost_per_second && outputDurationSeconds > 0) {
        // Use exact duration (no rounding) for fractional seconds support
        videoOutputCost = outputDurationSeconds * pricing.output_cost_per_second

        logger.debug(
          `💰 Video billing for ${modelName}: duration=${outputDurationSeconds}s, cost=$${videoOutputCost.toFixed(6)}`
        )
      }
    }

    // Calculate media totals
    const imageTotalCost = imageInputCost + imageOutputCost
    const mediaTotalCost = imageTotalCost + videoOutputCost

    // Calculate total cost including media
    const tokenTotalCost = inputCost + outputCost + cacheCreateCost + cacheReadCost
    const totalCost = tokenTotalCost + mediaTotalCost

    return {
      inputCost,
      outputCost,
      cacheCreateCost,
      cacheReadCost,
      ephemeral5mCost,
      ephemeral1hCost,
      // Media cost fields
      imageInputCost,
      imageOutputCost,
      imageTotalCost,
      videoOutputCost,
      mediaTotalCost,
      totalCost,
      hasPricing: true,
      isLongContextRequest,
      isFastMode,
      // Media model flags
      isImageModel,
      isVideoModel,
      isMediaModel: isMediaModelFlag,
      pricing: {
        input: inputPrice,
        output: outputPrice,
        cacheCreate: cacheWritePrice,
        cacheRead: cacheReadPrice,
        ephemeral1h: this.getEphemeral1hPricing(baseModelName, pricing),
        // Media pricing rates
        inputPerImage: pricing?.input_cost_per_image || 0,
        outputPerImage: pricing?.output_cost_per_image || 0,
        outputPerImageToken: pricing?.output_cost_per_image_token || 0,
        inputPerPixel: pricing?.input_cost_per_pixel || 0,
        outputPerPixel: pricing?.output_cost_per_pixel || 0,
        outputPerSecond: pricing?.output_cost_per_second || 0
      }
    }
  }

  // 格式化价格显示
  formatCost(cost) {
    if (cost === 0) {
      return '$0.000000'
    }
    if (cost < 0.000001) {
      return `$${cost.toExponential(2)}`
    }
    if (cost < 0.01) {
      return `$${cost.toFixed(6)}`
    }
    if (cost < 1) {
      return `$${cost.toFixed(4)}`
    }
    return `$${cost.toFixed(2)}`
  }

  // 获取服务状态
  getStatus() {
    return {
      initialized: this.pricingData !== null,
      lastUpdated: this.lastUpdated,
      modelCount: this.pricingData ? Object.keys(this.pricingData).length : 0,
      nextUpdate: this.lastUpdated
        ? new Date(this.lastUpdated.getTime() + this.updateInterval)
        : null
    }
  }

  // 强制更新价格数据
  async forceUpdate() {
    try {
      await this._downloadFromRemote()
      return { success: true, message: 'Pricing data updated successfully' }
    } catch (error) {
      logger.error('❌ Force update failed:', error)
      logger.info('📋 Force update failed, using fallback pricing data...')
      await this.useFallbackPricing()
      return {
        success: false,
        message: `Download failed: ${error.message}. Using fallback pricing data instead.`
      }
    }
  }

  // 设置文件监听器
  setupFileWatcher() {
    try {
      // 如果已有监听器，先关闭
      if (this.fileWatcher) {
        this.fileWatcher.close()
        this.fileWatcher = null
      }

      // 只有文件存在时才设置监听器
      if (!fs.existsSync(this.pricingFile)) {
        logger.debug('💰 Pricing file does not exist yet, skipping file watcher setup')
        return
      }

      // 使用 fs.watchFile 作为更可靠的文件监听方式
      // 它使用轮询，虽然性能稍差，但更可靠
      const watchOptions = {
        persistent: true,
        interval: 60000 // 每60秒检查一次
      }

      // 记录初始的修改时间
      let lastMtime = fs.statSync(this.pricingFile).mtimeMs

      fs.watchFile(this.pricingFile, watchOptions, (curr, _prev) => {
        // 检查文件是否真的被修改了（不仅仅是访问）
        if (curr.mtimeMs !== lastMtime) {
          lastMtime = curr.mtimeMs
          logger.debug(
            `💰 Detected change in pricing file (mtime: ${new Date(curr.mtime).toISOString()})`
          )
          this.handleFileChange()
        }
      })

      // 保存引用以便清理
      this.fileWatcher = {
        close: () => fs.unwatchFile(this.pricingFile)
      }

      logger.info('👁️  File watcher set up for model_pricing.json (polling every 60s)')
    } catch (error) {
      logger.error('❌ Failed to setup file watcher:', error)
    }
  }

  // 处理文件变化（带防抖）
  handleFileChange() {
    // 清除之前的定时器
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer)
    }

    // 设置新的定时器（防抖500ms）
    this.reloadDebounceTimer = setTimeout(async () => {
      logger.info('🔄 Reloading pricing data due to file change...')
      await this.reloadPricingData()
    }, 500)
  }

  // 重新加载价格数据
  async reloadPricingData() {
    try {
      // 验证文件是否存在
      if (!fs.existsSync(this.pricingFile)) {
        logger.warn('💰 Pricing file was deleted, using fallback')
        await this.useFallbackPricing()
        // 重新设置文件监听器（fallback会创建新文件）
        this.setupFileWatcher()
        return
      }

      // 读取文件内容
      const data = fs.readFileSync(this.pricingFile, 'utf8')

      // 尝试解析JSON
      const jsonData = JSON.parse(data)

      // 验证数据结构
      if (typeof jsonData !== 'object' || Object.keys(jsonData).length === 0) {
        throw new Error('Invalid pricing data structure')
      }

      // 更新内存中的数据
      this.pricingData = jsonData
      this.lastUpdated = new Date()
      this.buildEphemeral1hPricing()

      const modelCount = Object.keys(jsonData).length
      logger.success(`💰 Reloaded pricing data for ${modelCount} models from file`)

      // 显示一些统计信息
      const claudeModels = Object.keys(jsonData).filter((k) => k.includes('claude')).length
      const gptModels = Object.keys(jsonData).filter((k) => k.includes('gpt')).length
      const geminiModels = Object.keys(jsonData).filter((k) => k.includes('gemini')).length

      logger.debug(
        `💰 Model breakdown: Claude=${claudeModels}, GPT=${gptModels}, Gemini=${geminiModels}`
      )
    } catch (error) {
      logger.error('❌ Failed to reload pricing data:', error)
      logger.warn('💰 Keeping existing pricing data in memory')
    }
  }

  // 清理资源
  cleanup() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer)
      this.updateTimer = null
      logger.debug('💰 Pricing update timer cleared')
    }
    if (this.fileWatcher) {
      this.fileWatcher.close()
      this.fileWatcher = null
      logger.debug('💰 File watcher closed')
    }
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = null
    }
    if (this.hashCheckTimer) {
      clearInterval(this.hashCheckTimer)
      this.hashCheckTimer = null
      logger.debug('💰 Hash check timer cleared')
    }
  }
}

module.exports = new PricingService()
