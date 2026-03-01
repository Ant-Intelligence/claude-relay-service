const axios = require('axios')
const { v4: uuidv4 } = require('uuid')
const claudeConsoleAccountService = require('./claudeConsoleAccountService')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const config = require('../../config/config')
const {
  sanitizeUpstreamError,
  sanitizeErrorMessage,
  isAccountDisabledError
} = require('../utils/errorSanitizer')
const modelAlertService = require('./modelAlertService')
const { isValidClaudeModel } = require('../utils/modelValidator')
const { createClaudeTestPayload, sendStreamTestRequest } = require('../utils/testPayloadHelper')
const { isStreamWritable } = require('../utils/streamHelper')
const { stripBetaToken, CONTEXT_1M_BETA } = require('../utils/headerFilter')

class ClaudeConsoleRelayService {
  constructor() {
    this.defaultUserAgent = 'claude-cli/1.0.69 (external, cli)'
  }

  /**
   * 🔄 转换 messages 数组中的 system role 消息
   * Console API 不支持 role="system"，需要将 system 内容合并到第一条 user 消息
   * @param {Object} requestBody - 原始请求体
   * @returns {Object} 转换后的请求体
   */
  _transformSystemMessages(requestBody) {
    if (!requestBody || !Array.isArray(requestBody.messages)) {
      return requestBody
    }

    // 收集所有 system messages 的内容
    const systemContents = []
    const nonSystemMessages = []

    for (const msg of requestBody.messages) {
      if (msg && msg.role === 'system') {
        systemContents.push(msg.content)
      } else {
        nonSystemMessages.push(msg)
      }
    }

    // 如果没有 system messages，直接返回原请求
    if (systemContents.length === 0) {
      return requestBody
    }

    // 合并 system 内容到第一条 user 消息
    const systemText = systemContents.join('\n\n')
    let transformedMessages = nonSystemMessages

    // 查找第一条 user 消息
    const firstUserIndex = nonSystemMessages.findIndex((m) => m && m.role === 'user')

    if (firstUserIndex !== -1) {
      // 将 system 内容前置到第一条 user 消息
      const firstUserMsg = nonSystemMessages[firstUserIndex]
      const mergedContent = `${systemText}\n\n${firstUserMsg.content}`
      transformedMessages = [...nonSystemMessages]
      transformedMessages[firstUserIndex] = {
        ...firstUserMsg,
        content: mergedContent
      }
    } else {
      // 如果没有 user 消息，创建一个包含 system 内容的 user 消息
      logger.warn(
        `⚠️ Console API: No user message found to merge system prompt, creating new user message with system content`
      )
      transformedMessages = [{ role: 'user', content: systemText }, ...nonSystemMessages]
    }

    logger.debug(
      `🔄 Console API: Transformed ${systemContents.length} system message(s) into user message context`
    )

    return {
      ...requestBody,
      messages: transformedMessages
    }
  }

  // 🔧 修补孤立的 tool_use（缺少对应 tool_result）
  // 客户端在长对话中可能截断历史消息，导致 tool_use 丢失对应的 tool_result，
  // 上游 Claude API 严格校验每个 tool_use 必须紧跟 tool_result，否则返回 400。
  _patchOrphanedToolUse(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return messages
    }

    const SYNTHETIC_TEXT = '[tool_result missing; tool execution interrupted]'
    const makeSyntheticResult = (toolUseId) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      is_error: true,
      content: [{ type: 'text', text: SYNTHETIC_TEXT }]
    })

    const pendingToolUseIds = []
    const patched = []

    for (const message of messages) {
      if (!message || !Array.isArray(message.content)) {
        patched.push(message)
        continue
      }

      if (message.role === 'assistant') {
        if (pendingToolUseIds.length > 0) {
          patched.push({
            role: 'user',
            content: pendingToolUseIds.map(makeSyntheticResult)
          })
          logger.warn(
            `🔧 [Console] Patched ${pendingToolUseIds.length} orphaned tool_use(s): ${pendingToolUseIds.join(', ')}`
          )
          pendingToolUseIds.length = 0
        }

        const toolUseIds = message.content
          .filter((part) => part?.type === 'tool_use' && typeof part.id === 'string')
          .map((part) => part.id)
        if (toolUseIds.length > 0) {
          pendingToolUseIds.push(...toolUseIds)
        }

        patched.push(message)
        continue
      }

      if (message.role === 'user' && pendingToolUseIds.length > 0) {
        const toolResultIds = new Set(
          message.content
            .filter((p) => p?.type === 'tool_result' && typeof p.tool_use_id === 'string')
            .map((p) => p.tool_use_id)
        )
        const missing = pendingToolUseIds.filter((id) => !toolResultIds.has(id))

        if (missing.length > 0) {
          const synthetic = missing.map(makeSyntheticResult)
          logger.warn(
            `🔧 [Console] Patched ${missing.length} missing tool_result(s) in user message: ${missing.join(', ')}`
          )
          message.content = [...synthetic, ...message.content]
        }

        pendingToolUseIds.length = 0
      }

      patched.push(message)
    }

    if (pendingToolUseIds.length > 0) {
      patched.push({
        role: 'user',
        content: pendingToolUseIds.map(makeSyntheticResult)
      })
      logger.warn(
        `🔧 [Console] Patched ${pendingToolUseIds.length} trailing orphaned tool_use(s): ${pendingToolUseIds.join(', ')}`
      )
    }

    return patched
  }

  // 🚀 转发请求到Claude Console API
  async relayRequest(
    requestBody,
    apiKeyData,
    clientRequest,
    clientResponse,
    clientHeaders,
    accountId,
    options = {}
  ) {
    let abortController = null
    let account = null
    const requestId = uuidv4() // 用于并发追踪
    let concurrencyAcquired = false

    try {
      // 获取账户信息
      account = await claudeConsoleAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Claude Console Claude account not found')
      }

      logger.info(
        `📤 Processing Claude Console API request for key: ${apiKeyData.name || apiKeyData.id}, account: ${account.name} (${accountId}), request: ${requestId}`
      )

      // 🔒 并发控制：原子性抢占槽位
      if (account.maxConcurrentTasks > 0) {
        // 先抢占，再检查 - 避免竞态条件
        const newConcurrency = Number(
          await redis.incrConsoleAccountConcurrency(accountId, requestId, 600)
        )
        concurrencyAcquired = true

        // 检查是否超过限制
        if (newConcurrency > account.maxConcurrentTasks) {
          // 超限，立即回滚
          await redis.decrConsoleAccountConcurrency(accountId, requestId)
          concurrencyAcquired = false

          logger.warn(
            `⚠️ Console account ${account.name} (${accountId}) concurrency limit exceeded: ${newConcurrency}/${account.maxConcurrentTasks} (request: ${requestId}, rolled back)`
          )

          const error = new Error('Console account concurrency limit reached')
          error.code = 'CONSOLE_ACCOUNT_CONCURRENCY_FULL'
          error.accountId = accountId
          throw error
        }

        logger.debug(
          `🔓 Acquired concurrency slot for account ${account.name} (${accountId}), current: ${newConcurrency}/${account.maxConcurrentTasks}, request: ${requestId}`
        )
      }
      logger.debug(`🌐 Account API URL: ${account.apiUrl}`)
      logger.debug(`🔍 Account supportedModels: ${JSON.stringify(account.supportedModels)}`)
      logger.debug(`🔑 Account has apiKey: ${!!account.apiKey}`)
      logger.debug(`📝 Request model: ${requestBody.model}`)

      // 处理模型映射
      let mappedModel = requestBody.model
      if (
        account.supportedModels &&
        typeof account.supportedModels === 'object' &&
        !Array.isArray(account.supportedModels)
      ) {
        const newModel = claudeConsoleAccountService.getMappedModel(
          account.supportedModels,
          requestBody.model
        )
        if (newModel !== requestBody.model) {
          logger.info(`🔄 Mapping model from ${requestBody.model} to ${newModel}`)
          mappedModel = newModel
        }
      }

      // 创建修改后的请求体
      const modifiedRequestBody = {
        ...requestBody,
        model: mappedModel
      }

      // 🔧 修补孤立的 tool_use
      modifiedRequestBody.messages = this._patchOrphanedToolUse(modifiedRequestBody.messages)

      // 🔄 转换 system messages (Console API 不支持 role="system")
      const transformedRequestBody = this._transformSystemMessages(modifiedRequestBody)

      // 模型兼容性检查已经在调度器中完成，这里不需要再检查

      // 创建代理agent
      const proxyAgent = claudeConsoleAccountService._createProxyAgent(account.proxy)

      // 创建AbortController用于取消请求
      abortController = new AbortController()

      // 设置客户端断开监听器
      const handleClientDisconnect = () => {
        logger.info('🔌 Client disconnected, aborting Claude Console Claude request')
        if (abortController && !abortController.signal.aborted) {
          abortController.abort()
        }
      }

      // 监听客户端断开事件
      if (clientRequest) {
        clientRequest.once('close', handleClientDisconnect)
      }
      if (clientResponse) {
        clientResponse.once('close', handleClientDisconnect)
      }

      // 构建完整的API URL
      const cleanUrl = account.apiUrl.replace(/\/$/, '') // 移除末尾斜杠
      let apiEndpoint

      if (options.customPath) {
        // 如果指定了自定义路径（如 count_tokens），使用它
        const baseUrl = cleanUrl.replace(/\/v1\/messages$/, '') // 移除已有的 /v1/messages
        apiEndpoint = `${baseUrl}${options.customPath}`
      } else {
        // 默认使用 messages 端点
        apiEndpoint = cleanUrl.endsWith('/v1/messages') ? cleanUrl : `${cleanUrl}/v1/messages`
      }

      logger.debug(`🎯 Final API endpoint: ${apiEndpoint}`)
      logger.debug(`[DEBUG] Options passed to relayRequest: ${JSON.stringify(options)}`)
      logger.debug(`[DEBUG] Client headers received: ${JSON.stringify(clientHeaders)}`)

      // 过滤客户端请求头
      const filteredHeaders = this._filterClientHeaders(clientHeaders)
      logger.debug(`[DEBUG] Filtered client headers: ${JSON.stringify(filteredHeaders)}`)

      // 决定使用的 User-Agent：优先使用账户自定义的，否则透传客户端的，最后才使用默认值
      const userAgent =
        account.userAgent ||
        clientHeaders?.['user-agent'] ||
        clientHeaders?.['User-Agent'] ||
        this.defaultUserAgent

      // 准备请求配置
      const requestConfig = {
        method: 'POST',
        url: apiEndpoint,
        data: transformedRequestBody,
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'User-Agent': userAgent,
          ...filteredHeaders
        },
        timeout: config.requestTimeout || 600000,
        signal: abortController.signal,
        validateStatus: () => true // 接受所有状态码
      }

      if (proxyAgent) {
        requestConfig.httpAgent = proxyAgent
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
      }

      // 根据 API Key 格式选择认证方式
      if (account.apiKey && account.apiKey.startsWith('sk-ant-')) {
        // Anthropic 官方 API Key 使用 x-api-key
        requestConfig.headers['x-api-key'] = account.apiKey
        logger.debug('[DEBUG] Using x-api-key authentication for sk-ant-* API key')
      } else {
        // 其他 API Key 使用 Authorization Bearer
        requestConfig.headers['Authorization'] = `Bearer ${account.apiKey}`
        logger.debug('[DEBUG] Using Authorization Bearer authentication')
      }

      logger.debug(
        `[DEBUG] Initial headers before beta: ${JSON.stringify(requestConfig.headers, null, 2)}`
      )

      // 添加beta header如果需要
      if (options.betaHeader) {
        logger.debug(`[DEBUG] Adding beta header: ${options.betaHeader}`)
        requestConfig.headers['anthropic-beta'] = options.betaHeader
      } else {
        logger.debug('[DEBUG] No beta header to add')
      }

      // 发送请求
      logger.debug(
        '📤 Sending request to Claude Console API with headers:',
        JSON.stringify(requestConfig.headers, null, 2)
      )
      const response = await axios(requestConfig)

      // 移除监听器（请求成功完成）
      if (clientRequest) {
        clientRequest.removeListener('close', handleClientDisconnect)
      }
      if (clientResponse) {
        clientResponse.removeListener('close', handleClientDisconnect)
      }

      logger.debug(`🔗 Claude Console API response: ${response.status}`)
      logger.debug(`[DEBUG] Response headers: ${JSON.stringify(response.headers)}`)
      logger.debug(`[DEBUG] Response data type: ${typeof response.data}`)
      logger.debug(
        `[DEBUG] Response data length: ${response.data ? (typeof response.data === 'string' ? response.data.length : JSON.stringify(response.data).length) : 0}`
      )

      // 对于错误响应，记录原始错误和清理后的预览
      if (response.status < 200 || response.status >= 300) {
        // 记录原始错误响应（包含供应商信息，用于调试）
        const rawData =
          typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
        logger.error(
          `📝 Upstream error response from ${account?.name || accountId}: ${rawData.substring(0, 500)}`
        )

        // 记录清理后的数据到error
        try {
          const responseData =
            typeof response.data === 'string' ? JSON.parse(response.data) : response.data
          const sanitizedData = sanitizeUpstreamError(responseData)
          logger.error(`🧹 [SANITIZED] Error response to client: ${JSON.stringify(sanitizedData)}`)
        } catch (e) {
          const rawText =
            typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
          const sanitizedText = sanitizeErrorMessage(rawText)
          logger.error(`🧹 [SANITIZED] Error response to client: ${sanitizedText}`)
        }
      } else {
        logger.debug(
          `[DEBUG] Response data preview: ${typeof response.data === 'string' ? response.data.substring(0, 200) : JSON.stringify(response.data).substring(0, 200)}`
        )
      }

      // 检查是否为账户禁用/不可用的 400 错误
      const accountDisabledError = isAccountDisabledError(response.status, response.data)

      // 检查错误状态并相应处理
      if (response.status === 401) {
        logger.warn(`🚫 Unauthorized error detected for Claude Console account ${accountId}`)
        await claudeConsoleAccountService.markAccountUnauthorized(accountId)
      } else if (accountDisabledError) {
        logger.error(
          `🚫 Account disabled error (400) detected for Claude Console account ${accountId}, marking as blocked`
        )
        // 传入完整的错误详情到 webhook
        const errorDetails =
          typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
        await claudeConsoleAccountService.markConsoleAccountBlocked(accountId, errorDetails)
      } else if (response.status === 429) {
        logger.warn(`🚫 Rate limit detected for Claude Console account ${accountId}`)
        // 收到429先检查是否因为超过了手动配置的每日额度
        await claudeConsoleAccountService.checkQuotaUsage(accountId).catch((err) => {
          logger.error('❌ Failed to check quota after 429 error:', err)
        })

        await claudeConsoleAccountService.markAccountRateLimited(accountId)
      } else if (response.status === 529) {
        logger.warn(`🚫 Overload error detected for Claude Console account ${accountId}`)
        await claudeConsoleAccountService.markAccountOverloaded(accountId)
      } else if (response.status === 200 || response.status === 201) {
        // 如果请求成功，检查并移除错误状态
        const isRateLimited = await claudeConsoleAccountService.isAccountRateLimited(accountId)
        if (isRateLimited) {
          await claudeConsoleAccountService.removeAccountRateLimit(accountId)
        }
        const isOverloaded = await claudeConsoleAccountService.isAccountOverloaded(accountId)
        if (isOverloaded) {
          await claudeConsoleAccountService.removeAccountOverload(accountId)
        }
      }

      // 更新最后使用时间
      await this._updateLastUsedTime(accountId)

      // 准备响应体并清理错误信息（如果是错误响应）
      let responseBody
      if (response.status < 200 || response.status >= 300) {
        // 错误响应，清理供应商信息
        try {
          const responseData =
            typeof response.data === 'string' ? JSON.parse(response.data) : response.data
          const sanitizedData = sanitizeUpstreamError(responseData)
          responseBody = JSON.stringify(sanitizedData)
          logger.debug(`🧹 Sanitized error response`)
        } catch (parseError) {
          // 如果无法解析为JSON，尝试清理文本
          const rawText =
            typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
          responseBody = sanitizeErrorMessage(rawText)
          logger.debug(`🧹 Sanitized error text`)
        }
      } else {
        // 成功响应，不需要清理
        responseBody =
          typeof response.data === 'string' ? response.data : JSON.stringify(response.data)

        // 🔔 Model anomaly check + replacement for successful responses
        try {
          const responseData =
            typeof response.data === 'string' ? JSON.parse(response.data) : response.data
          const detectedModel = responseData?.model
          const requestedModel = requestBody.model

          // Async non-blocking model check
          modelAlertService
            .checkAndAlert({
              modelName: detectedModel,
              apiKeyName: apiKeyData.name || apiKeyData.id,
              apiKeyId: apiKeyData.id,
              accountId,
              accountName: account.name
            })
            .catch((err) => {
              logger.warn('Model alert check failed:', err.message)
            })

          // 如果模型异常，替换为请求的模型
          if (detectedModel && requestedModel && !isValidClaudeModel(detectedModel)) {
            responseData.model = requestedModel
            responseBody = JSON.stringify(responseData)
            logger.warn(
              `🔄 Replaced anomaly model "${detectedModel}" with requested model "${requestedModel}"`
            )
          }
        } catch (parseErr) {
          logger.warn('Failed to parse response for model check:', parseErr.message)
        }
      }

      logger.debug(`[DEBUG] Final response body to return: ${responseBody.substring(0, 200)}...`)

      return {
        statusCode: response.status,
        headers: response.headers,
        body: responseBody,
        accountId
      }
    } catch (error) {
      // 处理特定错误
      if (
        error.name === 'AbortError' ||
        error.name === 'CanceledError' ||
        error.code === 'ECONNABORTED' ||
        error.code === 'ERR_CANCELED'
      ) {
        logger.info('Request aborted due to client disconnect')
        throw new Error('Client disconnected')
      }

      logger.error(
        `❌ Claude Console relay request failed (Account: ${account?.name || accountId}):`,
        error.message
      )

      // 不再因为模型不支持而block账号

      throw error
    } finally {
      // 🔓 并发控制：释放并发槽位
      if (concurrencyAcquired) {
        try {
          await redis.decrConsoleAccountConcurrency(accountId, requestId)
          logger.debug(
            `🔓 Released concurrency slot for account ${account?.name || accountId}, request: ${requestId}`
          )
        } catch (releaseError) {
          logger.error(
            `❌ Failed to release concurrency slot for account ${accountId}, request: ${requestId}:`,
            releaseError.message
          )
        }
      }
    }
  }

  // 🌊 处理流式响应
  async relayStreamRequestWithUsageCapture(
    requestBody,
    apiKeyData,
    responseStream,
    clientHeaders,
    usageCallback,
    accountId,
    streamTransformer = null,
    options = {}
  ) {
    let account = null
    const requestId = uuidv4() // 用于并发追踪
    let concurrencyAcquired = false
    let leaseRefreshInterval = null // 租约刷新定时器

    try {
      // 获取账户信息
      account = await claudeConsoleAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Claude Console Claude account not found')
      }

      logger.info(
        `📡 Processing streaming Claude Console API request for key: ${apiKeyData.name || apiKeyData.id}, account: ${account.name} (${accountId}), request: ${requestId}`
      )

      // 🔒 并发控制：原子性抢占槽位
      if (account.maxConcurrentTasks > 0) {
        // 先抢占，再检查 - 避免竞态条件
        const newConcurrency = Number(
          await redis.incrConsoleAccountConcurrency(accountId, requestId, 600)
        )
        concurrencyAcquired = true

        // 检查是否超过限制
        if (newConcurrency > account.maxConcurrentTasks) {
          // 超限，立即回滚
          await redis.decrConsoleAccountConcurrency(accountId, requestId)
          concurrencyAcquired = false

          logger.warn(
            `⚠️ Console account ${account.name} (${accountId}) concurrency limit exceeded: ${newConcurrency}/${account.maxConcurrentTasks} (stream request: ${requestId}, rolled back)`
          )

          const error = new Error('Console account concurrency limit reached')
          error.code = 'CONSOLE_ACCOUNT_CONCURRENCY_FULL'
          error.accountId = accountId
          throw error
        }

        logger.debug(
          `🔓 Acquired concurrency slot for stream account ${account.name} (${accountId}), current: ${newConcurrency}/${account.maxConcurrentTasks}, request: ${requestId}`
        )

        // 🔄 启动租约刷新定时器（每5分钟刷新一次，防止长连接租约过期）
        leaseRefreshInterval = setInterval(
          async () => {
            try {
              await redis.refreshConsoleAccountConcurrencyLease(accountId, requestId, 600)
              logger.debug(
                `🔄 Refreshed concurrency lease for stream account ${account.name} (${accountId}), request: ${requestId}`
              )
            } catch (refreshError) {
              logger.error(
                `❌ Failed to refresh concurrency lease for account ${accountId}, request: ${requestId}:`,
                refreshError.message
              )
            }
          },
          5 * 60 * 1000
        ) // 5分钟刷新一次
      }

      logger.debug(`🌐 Account API URL: ${account.apiUrl}`)

      // 处理模型映射
      let mappedModel = requestBody.model
      if (
        account.supportedModels &&
        typeof account.supportedModels === 'object' &&
        !Array.isArray(account.supportedModels)
      ) {
        const newModel = claudeConsoleAccountService.getMappedModel(
          account.supportedModels,
          requestBody.model
        )
        if (newModel !== requestBody.model) {
          logger.info(`🔄 [Stream] Mapping model from ${requestBody.model} to ${newModel}`)
          mappedModel = newModel
        }
      }

      // 创建修改后的请求体
      const modifiedRequestBody = {
        ...requestBody,
        model: mappedModel
      }

      // 🔧 修补孤立的 tool_use
      modifiedRequestBody.messages = this._patchOrphanedToolUse(modifiedRequestBody.messages)

      // 🔄 转换 system messages (Console API 不支持 role="system")
      const transformedRequestBody = this._transformSystemMessages(modifiedRequestBody)

      // 模型兼容性检查已经在调度器中完成，这里不需要再检查

      // 创建代理agent
      const proxyAgent = claudeConsoleAccountService._createProxyAgent(account.proxy)

      // 发送流式请求
      await this._makeClaudeConsoleStreamRequest(
        transformedRequestBody,
        account,
        apiKeyData,
        proxyAgent,
        clientHeaders,
        responseStream,
        accountId,
        usageCallback,
        streamTransformer,
        options
      )

      // 更新最后使用时间
      await this._updateLastUsedTime(accountId)
    } catch (error) {
      logger.error(
        `❌ Claude Console stream relay failed (Account: ${account?.name || accountId}):`,
        error
      )
      throw error
    } finally {
      // 🛑 清理租约刷新定时器
      if (leaseRefreshInterval) {
        clearInterval(leaseRefreshInterval)
        logger.debug(
          `🛑 Cleared lease refresh interval for stream account ${account?.name || accountId}, request: ${requestId}`
        )
      }

      // 🔓 并发控制:释放并发槽位
      if (concurrencyAcquired) {
        try {
          await redis.decrConsoleAccountConcurrency(accountId, requestId)
          logger.debug(
            `🔓 Released concurrency slot for stream account ${account?.name || accountId}, request: ${requestId}`
          )
        } catch (releaseError) {
          logger.error(
            `❌ Failed to release concurrency slot for stream account ${accountId}, request: ${requestId}:`,
            releaseError.message
          )
        }
      }
    }
  }

  // 🌊 发送流式请求到Claude Console API
  async _makeClaudeConsoleStreamRequest(
    body,
    account,
    apiKeyData,
    proxyAgent,
    clientHeaders,
    responseStream,
    accountId,
    usageCallback,
    streamTransformer = null,
    requestOptions = {}
  ) {
    return new Promise((resolve, reject) => {
      let aborted = false

      // 构建完整的API URL
      const cleanUrl = account.apiUrl.replace(/\/$/, '') // 移除末尾斜杠
      const apiEndpoint = cleanUrl.endsWith('/v1/messages') ? cleanUrl : `${cleanUrl}/v1/messages`

      logger.debug(`🎯 Final API endpoint for stream: ${apiEndpoint}`)

      // 过滤客户端请求头
      const filteredHeaders = this._filterClientHeaders(clientHeaders)
      logger.debug(`[DEBUG] Filtered client headers: ${JSON.stringify(filteredHeaders)}`)

      // 决定使用的 User-Agent：优先使用账户自定义的，否则透传客户端的，最后才使用默认值
      const userAgent =
        account.userAgent ||
        clientHeaders?.['user-agent'] ||
        clientHeaders?.['User-Agent'] ||
        this.defaultUserAgent

      // 准备请求配置
      const requestConfig = {
        method: 'POST',
        url: apiEndpoint,
        data: body,
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'User-Agent': userAgent,
          ...filteredHeaders
        },
        timeout: config.requestTimeout || 600000,
        responseType: 'stream',
        validateStatus: () => true // 接受所有状态码
      }

      if (proxyAgent) {
        requestConfig.httpAgent = proxyAgent
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
      }

      // 根据 API Key 格式选择认证方式
      if (account.apiKey && account.apiKey.startsWith('sk-ant-')) {
        // Anthropic 官方 API Key 使用 x-api-key
        requestConfig.headers['x-api-key'] = account.apiKey
        logger.debug('[DEBUG] Using x-api-key authentication for sk-ant-* API key')
      } else {
        // 其他 API Key 使用 Authorization Bearer
        requestConfig.headers['Authorization'] = `Bearer ${account.apiKey}`
        logger.debug('[DEBUG] Using Authorization Bearer authentication')
      }

      // 添加beta header如果需要
      if (requestOptions.betaHeader) {
        requestConfig.headers['anthropic-beta'] = requestOptions.betaHeader
      }

      // 发送请求
      const request = axios(requestConfig)

      request
        .then((response) => {
          logger.debug(`🌊 Claude Console Claude stream response status: ${response.status}`)

          // 错误响应处理
          if (response.status !== 200) {
            logger.error(
              `❌ Claude Console API returned error status: ${response.status} | Account: ${account?.name || accountId}`
            )

            // 收集错误数据用于检测
            let errorDataForCheck = ''
            const errorChunks = []

            response.data.on('data', (chunk) => {
              errorChunks.push(chunk)
              errorDataForCheck += chunk.toString()
            })

            response.data.on('end', async () => {
              // 记录原始错误消息到日志（方便调试，包含供应商信息）
              logger.error(
                `📝 [Stream] Upstream error response from ${account?.name || accountId}: ${errorDataForCheck.substring(0, 500)}`
              )

              // 检查是否为账户禁用错误
              const accountDisabledError = isAccountDisabledError(
                response.status,
                errorDataForCheck
              )

              if (response.status === 401) {
                await claudeConsoleAccountService.markAccountUnauthorized(accountId)
              } else if (accountDisabledError) {
                logger.error(
                  `🚫 [Stream] Account disabled error (400) detected for Claude Console account ${accountId}, marking as blocked`
                )
                // 传入完整的错误详情到 webhook
                await claudeConsoleAccountService.markConsoleAccountBlocked(
                  accountId,
                  errorDataForCheck
                )
              } else if (response.status === 429) {
                await claudeConsoleAccountService.markAccountRateLimited(accountId)
                // 检查是否因为超过每日额度
                claudeConsoleAccountService.checkQuotaUsage(accountId).catch((err) => {
                  logger.error('❌ Failed to check quota after 429 error:', err)
                })
              } else if (response.status === 529) {
                await claudeConsoleAccountService.markAccountOverloaded(accountId)
              }

              // ⚠️ 关键改动：不向客户端发送任何内容，而是 reject 让重试机制接管
              // 构建错误对象，包含重试所需的所有信息
              const streamError = new Error(
                `Upstream stream error: ${response.status} from account ${account?.name || accountId}`
              )
              streamError.statusCode = response.status
              streamError.errorData = errorDataForCheck
              streamError.accountId = accountId
              streamError.accountName = account?.name

              // 尝试解析错误码
              try {
                const errorJson = JSON.parse(errorDataForCheck)
                streamError.errorCode =
                  errorJson?.error?.type || errorJson?.error || 'UPSTREAM_ERROR'
              } catch {
                streamError.errorCode = 'UPSTREAM_ERROR'
              }

              logger.warn(
                `🔄 [Stream] Rejecting with error for retry mechanism: ${response.status} - ${streamError.errorCode}`
              )

              reject(streamError) // 让重试机制接管
            })

            return
          }

          // 成功响应，检查并移除错误状态
          claudeConsoleAccountService.isAccountRateLimited(accountId).then((isRateLimited) => {
            if (isRateLimited) {
              claudeConsoleAccountService.removeAccountRateLimit(accountId)
            }
          })
          claudeConsoleAccountService.isAccountOverloaded(accountId).then((isOverloaded) => {
            if (isOverloaded) {
              claudeConsoleAccountService.removeAccountOverload(accountId)
            }
          })

          // 设置响应头
          if (!responseStream.headersSent) {
            responseStream.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no'
            })
          }

          let buffer = ''
          let finalUsageReported = false
          let modelAlertChecked = false // Flag to prevent duplicate model checks
          const collectedUsageData = {
            model: body.model || account?.defaultModel || null
          }

          // 处理流数据
          response.data.on('data', (chunk) => {
            try {
              if (aborted) {
                return
              }

              const chunkStr = chunk.toString()
              buffer += chunkStr

              // 处理完整的SSE行
              const lines = buffer.split('\n')
              buffer = lines.pop() || ''

              // 转发数据并解析usage
              if (lines.length > 0 && !responseStream.destroyed) {
                const linesToForward = lines.join('\n') + (lines.length > 0 ? '\n' : '')

                // 应用流转换器如果有
                if (streamTransformer) {
                  const transformed = streamTransformer(linesToForward)
                  if (transformed) {
                    responseStream.write(transformed)
                  }
                } else {
                  responseStream.write(linesToForward)
                }

                // 解析SSE数据寻找usage信息
                for (const line of lines) {
                  if (line.startsWith('data:')) {
                    const jsonStr = line.slice(5).trimStart()
                    if (!jsonStr || jsonStr === '[DONE]') {
                      continue
                    }
                    try {
                      const data = JSON.parse(jsonStr)

                      // 收集usage数据
                      if (data.type === 'message_start' && data.message && data.message.usage) {
                        collectedUsageData.input_tokens = data.message.usage.input_tokens || 0
                        collectedUsageData.cache_creation_input_tokens =
                          data.message.usage.cache_creation_input_tokens || 0
                        collectedUsageData.cache_read_input_tokens =
                          data.message.usage.cache_read_input_tokens || 0
                        collectedUsageData.model = data.message.model

                        // 检查是否有详细的 cache_creation 对象
                        if (
                          data.message.usage.cache_creation &&
                          typeof data.message.usage.cache_creation === 'object'
                        ) {
                          collectedUsageData.cache_creation = {
                            ephemeral_5m_input_tokens:
                              data.message.usage.cache_creation.ephemeral_5m_input_tokens || 0,
                            ephemeral_1h_input_tokens:
                              data.message.usage.cache_creation.ephemeral_1h_input_tokens || 0
                          }
                          logger.info(
                            '📊 Collected detailed cache creation data:',
                            JSON.stringify(collectedUsageData.cache_creation)
                          )
                        }
                      }

                      // 🔔 Model anomaly check - 独立条件，不依赖usage字段
                      if (data.type === 'message_start' && data.message && !modelAlertChecked) {
                        modelAlertChecked = true
                        const detectedModel = data.message.model
                        modelAlertService
                          .checkAndAlert({
                            modelName: detectedModel,
                            apiKeyName: apiKeyData.name || apiKeyData.id,
                            apiKeyId: apiKeyData.id,
                            accountId,
                            accountName: account.name
                          })
                          .catch((err) => {
                            logger.warn('Model alert check failed (stream):', err.message)
                          })
                      }

                      if (data.type === 'message_delta' && data.usage) {
                        // 提取所有usage字段，message_delta可能包含完整的usage信息
                        if (data.usage.output_tokens !== undefined) {
                          collectedUsageData.output_tokens = data.usage.output_tokens || 0
                        }

                        // 提取input_tokens（如果存在）
                        if (data.usage.input_tokens !== undefined) {
                          collectedUsageData.input_tokens = data.usage.input_tokens || 0
                        }

                        // 提取cache相关的tokens
                        if (data.usage.cache_creation_input_tokens !== undefined) {
                          collectedUsageData.cache_creation_input_tokens =
                            data.usage.cache_creation_input_tokens || 0
                        }
                        if (data.usage.cache_read_input_tokens !== undefined) {
                          collectedUsageData.cache_read_input_tokens =
                            data.usage.cache_read_input_tokens || 0
                        }

                        // 检查是否有详细的 cache_creation 对象
                        if (
                          data.usage.cache_creation &&
                          typeof data.usage.cache_creation === 'object'
                        ) {
                          collectedUsageData.cache_creation = {
                            ephemeral_5m_input_tokens:
                              data.usage.cache_creation.ephemeral_5m_input_tokens || 0,
                            ephemeral_1h_input_tokens:
                              data.usage.cache_creation.ephemeral_1h_input_tokens || 0
                          }
                        }

                        logger.info(
                          '📊 [Console] Collected usage data from message_delta:',
                          JSON.stringify(collectedUsageData)
                        )

                        // 如果已经收集到了完整数据，触发回调
                        if (
                          collectedUsageData.input_tokens !== undefined &&
                          collectedUsageData.output_tokens !== undefined &&
                          !finalUsageReported
                        ) {
                          if (!collectedUsageData.model) {
                            collectedUsageData.model = body.model || account?.defaultModel || null
                          }
                          logger.info(
                            '🎯 [Console] Complete usage data collected:',
                            JSON.stringify(collectedUsageData)
                          )
                          if (usageCallback) {
                            usageCallback({ ...collectedUsageData, accountId })
                          }
                          finalUsageReported = true
                        }
                      }

                      // 不再因为模型不支持而block账号
                    } catch (e) {
                      // 忽略解析错误
                    }
                  }
                }
              }
            } catch (error) {
              logger.error(
                `❌ Error processing Claude Console stream data (Account: ${account?.name || accountId}):`,
                error
              )
              if (!responseStream.destroyed) {
                responseStream.write('event: error\n')
                responseStream.write(
                  `data: ${JSON.stringify({
                    error: 'Stream processing error',
                    message: error.message,
                    timestamp: new Date().toISOString()
                  })}\n\n`
                )
              }
            }
          })

          response.data.on('end', () => {
            try {
              // 处理缓冲区中剩余的数据
              if (buffer.trim() && !responseStream.destroyed) {
                if (streamTransformer) {
                  const transformed = streamTransformer(buffer)
                  if (transformed) {
                    responseStream.write(transformed)
                  }
                } else {
                  responseStream.write(buffer)
                }
              }

              // 🔧 兜底逻辑：确保所有未保存的usage数据都不会丢失
              if (!finalUsageReported) {
                if (
                  collectedUsageData.input_tokens !== undefined ||
                  collectedUsageData.output_tokens !== undefined
                ) {
                  // 补全缺失的字段
                  if (collectedUsageData.input_tokens === undefined) {
                    collectedUsageData.input_tokens = 0
                    logger.warn(
                      '⚠️ [Console] message_delta missing input_tokens, setting to 0. This may indicate incomplete usage data.'
                    )
                  }
                  if (collectedUsageData.output_tokens === undefined) {
                    collectedUsageData.output_tokens = 0
                    logger.warn(
                      '⚠️ [Console] message_delta missing output_tokens, setting to 0. This may indicate incomplete usage data.'
                    )
                  }
                  // 确保有 model 字段
                  if (!collectedUsageData.model) {
                    collectedUsageData.model = body.model || account?.defaultModel || null
                  }
                  logger.info(
                    `📊 [Console] Saving incomplete usage data via fallback: ${JSON.stringify(collectedUsageData)}`
                  )
                  if (usageCallback) {
                    usageCallback({ ...collectedUsageData, accountId })
                  }
                  finalUsageReported = true
                } else {
                  logger.warn(
                    '⚠️ [Console] Stream completed but no usage data was captured! This indicates a problem with SSE parsing or API response format.'
                  )
                }
              }

              // 确保流正确结束
              if (!responseStream.destroyed) {
                responseStream.end()
              }

              logger.debug('🌊 Claude Console Claude stream response completed')
              resolve()
            } catch (error) {
              logger.error('❌ Error processing stream end:', error)
              reject(error)
            }
          })

          response.data.on('error', (error) => {
            logger.error(
              `❌ Claude Console stream error (Account: ${account?.name || accountId}):`,
              error
            )
            if (!responseStream.destroyed) {
              responseStream.write('event: error\n')
              responseStream.write(
                `data: ${JSON.stringify({
                  error: 'Stream error',
                  message: error.message,
                  timestamp: new Date().toISOString()
                })}\n\n`
              )
              responseStream.end()
            }
            reject(error)
          })
        })
        .catch((error) => {
          if (aborted) {
            return
          }

          logger.error(
            `❌ Claude Console stream request error (Account: ${account?.name || accountId}):`,
            error.message
          )

          // 检查错误状态
          if (error.response) {
            if (error.response.status === 401) {
              claudeConsoleAccountService.markAccountUnauthorized(accountId)
            } else if (error.response.status === 429) {
              claudeConsoleAccountService.markAccountRateLimited(accountId)
              // 检查是否因为超过每日额度
              claudeConsoleAccountService.checkQuotaUsage(accountId).catch((err) => {
                logger.error('❌ Failed to check quota after 429 error:', err)
              })
            } else if (error.response.status === 529) {
              claudeConsoleAccountService.markAccountOverloaded(accountId)
            }
          }

          // 发送错误响应
          if (!responseStream.headersSent) {
            responseStream.writeHead(error.response?.status || 500, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive'
            })
          }

          if (!responseStream.destroyed) {
            responseStream.write('event: error\n')
            responseStream.write(
              `data: ${JSON.stringify({
                error: error.message,
                code: error.code,
                timestamp: new Date().toISOString()
              })}\n\n`
            )
            responseStream.end()
          }

          reject(error)
        })

      // 处理客户端断开连接
      responseStream.on('close', () => {
        logger.debug('🔌 Client disconnected, cleaning up Claude Console stream')
        aborted = true
      })
    })
  }

  // 🔧 过滤客户端请求头
  _filterClientHeaders(clientHeaders) {
    const sensitiveHeaders = [
      'content-type',
      'user-agent',
      'authorization',
      'x-api-key',
      'host',
      'content-length',
      'connection',
      'proxy-authorization',
      'content-encoding',
      'transfer-encoding',
      'anthropic-version'
    ]

    const filteredHeaders = {}

    Object.keys(clientHeaders || {}).forEach((key) => {
      const lowerKey = key.toLowerCase()
      if (!sensitiveHeaders.includes(lowerKey)) {
        filteredHeaders[key] = clientHeaders[key]
      }
    })

    if (filteredHeaders['anthropic-beta']) {
      filteredHeaders['anthropic-beta'] = stripBetaToken(
        filteredHeaders['anthropic-beta'],
        CONTEXT_1M_BETA
      )
      if (!filteredHeaders['anthropic-beta']) {
        delete filteredHeaders['anthropic-beta']
      }
    }

    return filteredHeaders
  }

  // 🕐 更新最后使用时间
  async _updateLastUsedTime(accountId) {
    try {
      const client = require('../models/redis').getClientSafe()
      const accountKey = `claude_console_account:${accountId}`
      const exists = await client.exists(accountKey)

      if (!exists) {
        logger.debug(`🔎 跳过更新已删除的Claude Console账号最近使用时间: ${accountId}`)
        return
      }

      await client.hset(accountKey, 'lastUsedAt', new Date().toISOString())
    } catch (error) {
      logger.warn(
        `⚠️ Failed to update last used time for Claude Console account ${accountId}:`,
        error.message
      )
    }
  }

  // 🎯 健康检查
  /**
   * 发送非流式Console请求并返回标准化响应
   * 用于重试服务中的多轮重试
   * @param {string} accountId - 账户ID
   * @param {Object} requestBody - 请求体
   * @param {string} apiKeyId - API Key ID
   * @returns {Promise<{status, data, error}>}
   */
  async relayConsoleMessages(accountId, requestBody, _apiKeyId) {
    try {
      // 获取账户信息
      const account = await claudeConsoleAccountService.getAccount(accountId)
      if (!account) {
        return {
          status: 404,
          data: { error: 'account_not_found', message: 'Claude Console account not found' }
        }
      }

      // 检查并发限制
      if (account.maxConcurrentTasks > 0) {
        const requestId = require('uuid').v4()
        const newConcurrency = Number(
          await redis.incrConsoleAccountConcurrency(accountId, requestId, 600)
        )

        if (newConcurrency > account.maxConcurrentTasks) {
          await redis.decrConsoleAccountConcurrency(accountId, requestId)
          return {
            status: 503,
            data: {
              error: 'service_unavailable',
              message: 'Console account concurrency limit reached'
            }
          }
        }
      }

      // 处理模型映射
      let mappedModel = requestBody.model
      if (
        account.supportedModels &&
        typeof account.supportedModels === 'object' &&
        !Array.isArray(account.supportedModels)
      ) {
        const newModel = claudeConsoleAccountService.getMappedModel(
          account.supportedModels,
          requestBody.model
        )
        if (newModel !== requestBody.model) {
          mappedModel = newModel
        }
      }

      // 创建修改后的请求体
      const modifiedRequestBody = {
        ...requestBody,
        model: mappedModel
      }

      // 🔧 修补孤立的 tool_use
      modifiedRequestBody.messages = this._patchOrphanedToolUse(modifiedRequestBody.messages)

      // 🔄 转换 system messages (Console API 不支持 role="system")
      const transformedRequestBody = this._transformSystemMessages(modifiedRequestBody)

      // 创建代理agent
      const proxyAgent = claudeConsoleAccountService._createProxyAgent(account.proxy)

      // 构建API端点
      const cleanUrl = account.apiUrl.replace(/\/$/, '')
      const apiEndpoint = cleanUrl.endsWith('/v1/messages') ? cleanUrl : `${cleanUrl}/v1/messages`

      // 发送请求
      let response
      const requestId = require('uuid').v4()

      try {
        response = await axios({
          method: 'POST',
          url: apiEndpoint,
          data: transformedRequestBody,
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            Authorization: `Bearer ${account.apiKey}`,
            'User-Agent': account.userAgent || this.defaultUserAgent
          },
          timeout: config.requestTimeout || 600000,
          httpAgent: proxyAgent?.http,
          httpsAgent: proxyAgent?.https,
          validateStatus: () => true // 接受所有状态码
        })

        // 返回标准化响应
        if (response.status === 200 || response.status === 201) {
          return {
            status: response.status,
            data: response.data
          }
        } else {
          return {
            status: response.status,
            data: response.data || { error: 'unknown_error', message: 'Unknown error' }
          }
        }
      } catch (error) {
        logger.error(`Failed to relay Console message for account ${accountId}:`, error.message)
        return {
          status: 500,
          data: {
            error: 'internal_error',
            message: error.message
          }
        }
      } finally {
        // 🔒 确保释放并发计数（即使请求失败或异常）
        if (account.maxConcurrentTasks > 0) {
          try {
            await redis.decrConsoleAccountConcurrency(accountId, requestId)
            logger.debug(`🔓 Released concurrency slot for account ${account.name} (${accountId})`)
          } catch (err) {
            logger.error(
              `⚠️ Failed to release concurrency slot for account ${accountId}:`,
              err.message
            )
          }
        }
      }
    } catch (error) {
      logger.error(
        `Unexpected error in relayConsoleMessages for account ${accountId}:`,
        error.message
      )
      return {
        status: 500,
        data: {
          error: 'internal_error',
          message: error.message
        }
      }
    }
  }

  // 🧪 测试账号连接（流式响应，供Admin API使用）
  async testAccountConnection(accountId, responseStream, model = 'claude-haiku-4-5-20251001') {
    try {
      const account = await claudeConsoleAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Account not found')
      }

      logger.info(
        `🧪 Testing Claude Console account connection: ${account.name} (${accountId}), model: ${model}`
      )

      const cleanUrl = account.apiUrl.replace(/\/$/, '')
      const apiUrl = cleanUrl.endsWith('/v1/messages')
        ? cleanUrl
        : `${cleanUrl}/v1/messages?beta=true`

      await sendStreamTestRequest({
        apiUrl,
        authorization: `Bearer ${account.apiKey}`,
        responseStream,
        payload: createClaudeTestPayload(model, { stream: true }),
        proxyAgent: claudeConsoleAccountService._createProxyAgent(account.proxy),
        extraHeaders: account.userAgent ? { 'User-Agent': account.userAgent } : {}
      })
    } catch (error) {
      logger.error(`❌ Test account connection failed:`, error)
      if (!responseStream.headersSent) {
        responseStream.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache'
        })
      }
      if (isStreamWritable(responseStream)) {
        responseStream.write(
          `data: ${JSON.stringify({ type: 'test_complete', success: false, error: error.message })}\n\n`
        )
        responseStream.end()
      }
    }
  }

  // 🧪 非流式测试账号连接（供定时任务使用）
  async testAccountConnectionSync(accountId, model = 'claude-haiku-4-5-20251001') {
    const startTime = Date.now()

    try {
      const account = await claudeConsoleAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Account not found')
      }

      logger.info(
        `🧪 Testing Claude Console account connection (sync): ${account.name} (${accountId})`
      )

      const cleanUrl = account.apiUrl.replace(/\/$/, '')
      const apiUrl = cleanUrl.endsWith('/v1/messages')
        ? cleanUrl
        : `${cleanUrl}/v1/messages?beta=true`

      const payload = createClaudeTestPayload(model, { stream: true })
      const proxyAgent = claudeConsoleAccountService._createProxyAgent(account.proxy)

      const requestConfig = {
        method: 'POST',
        url: apiUrl,
        data: payload,
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'User-Agent': account.userAgent || 'claude-cli/2.0.52 (external, cli)',
          authorization: `Bearer ${account.apiKey}`
        },
        timeout: 30000,
        responseType: 'stream',
        validateStatus: () => true
      }

      if (proxyAgent) {
        requestConfig.httpAgent = proxyAgent
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
      }

      const response = await axios(requestConfig)

      // 收集流式响应
      return new Promise((resolve) => {
        let responseText = ''
        let capturedUsage = null
        let capturedModel = model
        let hasError = false
        let errorMessage = ''
        let buffer = ''

        // 处理非200响应
        if (response.status !== 200) {
          const chunks = []
          response.data.on('data', (chunk) => chunks.push(chunk))
          response.data.on('end', () => {
            const errorData = Buffer.concat(chunks).toString()
            let errorMsg = `API Error: ${response.status}`
            try {
              const json = JSON.parse(errorData)
              errorMsg = json.message || json.error?.message || json.error || errorMsg
            } catch {
              if (errorData.length < 200) {
                errorMsg = errorData || errorMsg
              }
            }
            const latencyMs = Date.now() - startTime
            resolve({
              success: false,
              error: errorMsg,
              latencyMs,
              timestamp: new Date().toISOString()
            })
          })
          response.data.on('error', (err) => {
            const latencyMs = Date.now() - startTime
            resolve({
              success: false,
              error: err.message,
              latencyMs,
              timestamp: new Date().toISOString()
            })
          })
          return
        }

        response.data.on('data', (chunk) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data:')) {
              continue
            }
            const jsonStr = line.substring(5).trim()
            if (!jsonStr || jsonStr === '[DONE]') {
              continue
            }

            try {
              const data = JSON.parse(jsonStr)

              // 提取文本内容
              if (data.type === 'content_block_delta' && data.delta?.text) {
                responseText += data.delta.text
              }
              // 提取 usage 信息
              if (data.type === 'message_delta' && data.usage) {
                capturedUsage = data.usage
              }
              // 提取模型信息
              if (data.type === 'message_start' && data.message?.model) {
                capturedModel = data.message.model
              }
              // 检测错误
              if (data.type === 'error' || data.error) {
                hasError = true
                errorMessage = data.error?.message || data.message || data.error || 'Unknown error'
              }
            } catch {
              // ignore parse errors
            }
          }
        })

        response.data.on('end', () => {
          const latencyMs = Date.now() - startTime

          if (hasError) {
            logger.warn(
              `⚠️ Test completed with error for Claude Console account: ${account.name} - ${errorMessage}`
            )
            resolve({
              success: false,
              error: errorMessage,
              latencyMs,
              timestamp: new Date().toISOString()
            })
            return
          }

          logger.info(
            `✅ Test completed for Claude Console account: ${account.name} (${latencyMs}ms)`
          )

          resolve({
            success: true,
            message: responseText.substring(0, 200), // 截取前200字符
            latencyMs,
            model: capturedModel,
            usage: capturedUsage,
            timestamp: new Date().toISOString()
          })
        })

        response.data.on('error', (err) => {
          const latencyMs = Date.now() - startTime
          resolve({
            success: false,
            error: err.message,
            latencyMs,
            timestamp: new Date().toISOString()
          })
        })
      })
    } catch (error) {
      const latencyMs = Date.now() - startTime
      logger.error(`❌ Test account connection (sync) failed:`, error.message)

      // 提取错误详情
      let errorMessage = error.message
      if (error.response) {
        errorMessage =
          error.response.data?.error?.message || error.response.statusText || error.message
      }

      return {
        success: false,
        error: errorMessage,
        statusCode: error.response?.status,
        latencyMs,
        timestamp: new Date().toISOString()
      }
    }
  }

  async healthCheck() {
    try {
      const accounts = await claudeConsoleAccountService.getAllAccounts()
      const activeAccounts = accounts.filter((acc) => acc.isActive && acc.status === 'active')

      return {
        healthy: activeAccounts.length > 0,
        activeAccounts: activeAccounts.length,
        totalAccounts: accounts.length,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.error('❌ Claude Console Claude health check failed:', error)
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      }
    }
  }
}

module.exports = new ClaudeConsoleRelayService()
