const {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand
} = require('@aws-sdk/client-bedrock-runtime')
const { fromEnv } = require('@aws-sdk/credential-providers')
const logger = require('../utils/logger')
const config = require('../../config/config')

class BedrockRelayService {
  constructor() {
    this.defaultRegion = process.env.AWS_REGION || config.bedrock?.defaultRegion || 'us-east-1'
    this.smallFastModelRegion =
      process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION || this.defaultRegion

    // 默认模型配置
    this.defaultModel = process.env.ANTHROPIC_MODEL || 'us.anthropic.claude-sonnet-4-20250514-v1:0'
    this.defaultSmallModel =
      process.env.ANTHROPIC_SMALL_FAST_MODEL || 'us.anthropic.claude-3-5-haiku-20241022-v1:0'

    // Token配置 — 仅作为客户端未指定 max_tokens 时的回退默认值，不用于截断
    this.maxOutputTokens = parseInt(process.env.BEDROCK_MAX_OUTPUT_TOKENS) || 128000
    this.enablePromptCaching = process.env.DISABLE_PROMPT_CACHING !== '1'

    // 创建Bedrock客户端
    this.clients = new Map() // 缓存不同区域的客户端
  }

  // 获取或创建Bedrock客户端
  _getBedrockClient(region = null, bedrockAccount = null) {
    const targetRegion = region || this.defaultRegion
    const clientKey = `${targetRegion}-${bedrockAccount?.id || 'default'}`

    if (this.clients.has(clientKey)) {
      return this.clients.get(clientKey)
    }

    const clientConfig = {
      region: targetRegion,
      requestHandler: {
        requestTimeout: config.requestTimeout || 600000,
        connectionTimeout: 10000
      }
    }

    // 如果账户配置了特定的AWS凭证，使用它们
    if (bedrockAccount?.awsCredentials) {
      clientConfig.credentials = {
        accessKeyId: bedrockAccount.awsCredentials.accessKeyId,
        secretAccessKey: bedrockAccount.awsCredentials.secretAccessKey,
        sessionToken: bedrockAccount.awsCredentials.sessionToken
      }
    } else if (bedrockAccount?.bearerToken) {
      // Bedrock API Key (ABSK) 模式：需要通过 middleware 注入 Bearer Token，
      // 因为 BedrockRuntimeClient 默认使用 SigV4 签名，不支持 token 配置
      // 使用占位凭证防止 "Could not load credentials" 错误
      clientConfig.credentials = {
        accessKeyId: 'BEDROCK_API_KEY_PLACEHOLDER',
        secretAccessKey: 'BEDROCK_API_KEY_PLACEHOLDER'
      }
      logger.debug(`🔑 使用 Bearer Token 认证 - 账户: ${bedrockAccount.name || 'unknown'}`)
    } else {
      // 检查是否有环境变量凭证
      if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        clientConfig.credentials = fromEnv()
      } else {
        throw new Error(
          'AWS凭证未配置。请在Bedrock账户中配置AWS访问密钥，或设置环境变量AWS_ACCESS_KEY_ID和AWS_SECRET_ACCESS_KEY'
        )
      }
    }

    const client = new BedrockRuntimeClient(clientConfig)

    // Bedrock API Key (ABSK) 模式：在 finalizeRequest 阶段替换 Authorization header
    if (bedrockAccount?.bearerToken) {
      const { bearerToken } = bedrockAccount
      client.middlewareStack.add(
        (next) => async (args) => {
          for (const key of Object.keys(args.request.headers)) {
            if (key.toLowerCase() === 'authorization') {
              delete args.request.headers[key]
            }
          }
          args.request.headers['Authorization'] = `Bearer ${bearerToken}`
          delete args.request.headers['x-amz-date']
          delete args.request.headers['x-amz-security-token']
          delete args.request.headers['x-amz-content-sha256']
          return next(args)
        },
        { step: 'finalizeRequest', name: 'bedrockBearerTokenAuth', override: true, priority: 'low' }
      )
      logger.debug(`🔑 Bearer Token middleware 已注入 - 账户: ${bedrockAccount.name || 'unknown'}`)
    }

    this.clients.set(clientKey, client)

    logger.debug(
      `🔧 Created Bedrock client for region: ${targetRegion}, account: ${bedrockAccount?.name || 'default'}`
    )
    return client
  }

  // 处理非流式请求
  async handleNonStreamRequest(requestBody, bedrockAccount = null) {
    try {
      const modelId = this._selectModel(requestBody, bedrockAccount)
      const region = this._selectRegion(modelId, bedrockAccount)
      const client = this._getBedrockClient(region, bedrockAccount)

      // 转换请求格式为Bedrock格式
      const bedrockPayload = this._convertToBedrockFormat(requestBody)

      const command = new InvokeModelCommand({
        modelId,
        body: JSON.stringify(bedrockPayload),
        contentType: 'application/json',
        accept: 'application/json'
      })

      logger.debug(`🚀 Bedrock非流式请求 - 模型: ${modelId}, 区域: ${region}`)

      const startTime = Date.now()
      const response = await client.send(command)
      const duration = Date.now() - startTime

      // 解析响应
      const responseBody = JSON.parse(new TextDecoder().decode(response.body))
      const claudeResponse = this._convertFromBedrockFormat(responseBody)

      logger.info(`✅ Bedrock请求完成 - 模型: ${modelId}, 耗时: ${duration}ms`)

      return {
        success: true,
        data: claudeResponse,
        usage: claudeResponse.usage,
        model: modelId,
        duration
      }
    } catch (error) {
      logger.error('❌ Bedrock非流式请求失败:', error)
      throw this._handleBedrockError(error)
    }
  }

  // 处理流式请求
  async handleStreamRequest(requestBody, bedrockAccount = null, res) {
    try {
      const modelId = this._selectModel(requestBody, bedrockAccount)
      const region = this._selectRegion(modelId, bedrockAccount)
      const client = this._getBedrockClient(region, bedrockAccount)

      // 转换请求格式为Bedrock格式
      const bedrockPayload = this._convertToBedrockFormat(requestBody)

      const command = new InvokeModelWithResponseStreamCommand({
        modelId,
        body: JSON.stringify(bedrockPayload),
        contentType: 'application/json',
        accept: 'application/json'
      })

      logger.debug(`🌊 Bedrock流式请求 - 模型: ${modelId}, 区域: ${region}`)

      const startTime = Date.now()
      const response = await client.send(command)

      // 设置SSE响应头
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      })

      let totalUsage = null
      let isFirstChunk = true

      // 处理流式响应
      for await (const chunk of response.body) {
        if (chunk.chunk) {
          const chunkData = JSON.parse(new TextDecoder().decode(chunk.chunk.bytes))
          const claudeEvent = this._convertBedrockStreamToClaudeFormat(chunkData, isFirstChunk)

          if (claudeEvent) {
            // 发送SSE事件
            res.write(`event: ${claudeEvent.type}\n`)
            res.write(`data: ${JSON.stringify(claudeEvent.data)}\n\n`)

            // 提取使用统计
            if (claudeEvent.type === 'message_stop' && claudeEvent.data.usage) {
              totalUsage = claudeEvent.data.usage
            }

            isFirstChunk = false
          }
        }
      }

      const duration = Date.now() - startTime
      logger.info(`✅ Bedrock流式请求完成 - 模型: ${modelId}, 耗时: ${duration}ms`)

      // 发送结束事件
      res.write('event: done\n')
      res.write('data: [DONE]\n\n')
      res.end()

      return {
        success: true,
        usage: totalUsage,
        model: modelId,
        duration
      }
    } catch (error) {
      logger.error('❌ Bedrock流式请求失败:', error)

      const bedrockError = this._handleBedrockError(error)

      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/event-stream' })
        }
        if (!res.writableEnded) {
          res.write('event: error\n')
          res.write(`data: ${JSON.stringify({ error: bedrockError.message })}\n\n`)
          res.end()
        }
      } catch (writeError) {
        logger.error('❌ Failed to write error response:', writeError.message)
        if (!res.writableEnded) {
          res.end()
        }
      }

      throw bedrockError
    }
  }

  // 选择使用的模型
  _selectModel(requestBody, bedrockAccount) {
    let selectedModel

    // 优先使用账户配置的模型
    if (bedrockAccount?.defaultModel) {
      selectedModel = bedrockAccount.defaultModel
      logger.info(`🎯 使用账户配置的模型: ${selectedModel}`, {
        metadata: { source: 'account', accountId: bedrockAccount.id }
      })
    }
    // 检查请求中指定的模型
    else if (requestBody.model) {
      selectedModel = requestBody.model
      logger.info(`🎯 使用请求指定的模型: ${selectedModel}`, { metadata: { source: 'request' } })
    }
    // 使用默认模型
    else {
      selectedModel = this.defaultModel
      logger.info(`🎯 使用系统默认模型: ${selectedModel}`, { metadata: { source: 'default' } })
    }

    // 如果是标准Claude模型名，需要映射为Bedrock格式
    const bedrockModel = this._mapToBedrockModel(selectedModel)
    if (bedrockModel !== selectedModel) {
      logger.info(`🔄 模型映射: ${selectedModel} → ${bedrockModel}`, {
        metadata: { originalModel: selectedModel, bedrockModel }
      })
    }

    return bedrockModel
  }

  // 将Bedrock模型名反向映射为标准Claude格式
  // 客户端（如 Claude Code）依赖标准模型名来判定上下文窗口大小，
  // 若收到 Bedrock 格式名称则可能使用保守默认值，导致过早触发 "Context limit reached"。
  _mapFromBedrockModel(bedrockModelId) {
    if (!bedrockModelId) {
      return bedrockModelId
    }
    if (!bedrockModelId.includes('.anthropic.') && !bedrockModelId.startsWith('anthropic.')) {
      return bedrockModelId
    }
    const match = bedrockModelId.match(/(?:.*\.)?anthropic\.(claude-.+?)(?:-v\d+)?(?::\d+)?$/)
    if (match) {
      return match[1]
    }
    return bedrockModelId
  }

  // 将标准Claude模型名映射为Bedrock格式
  _mapToBedrockModel(modelName) {
    // 标准Claude模型名到Bedrock模型名的映射表
    const modelMapping = {
      // Claude Sonnet 4
      'claude-sonnet-4': 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      'claude-sonnet-4-20250514': 'us.anthropic.claude-sonnet-4-20250514-v1:0',

      // Claude Opus 4.1
      'claude-opus-4': 'us.anthropic.claude-opus-4-1-20250805-v1:0',
      'claude-opus-4-1': 'us.anthropic.claude-opus-4-1-20250805-v1:0',
      'claude-opus-4-1-20250805': 'us.anthropic.claude-opus-4-1-20250805-v1:0',

      // Claude 3.7 Sonnet
      'claude-3-7-sonnet': 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
      'claude-3-7-sonnet-20250219': 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',

      // Claude 3.5 Sonnet v2
      'claude-3-5-sonnet': 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      'claude-3-5-sonnet-20241022': 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',

      // Claude 3.5 Haiku
      'claude-3-5-haiku': 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
      'claude-3-5-haiku-20241022': 'us.anthropic.claude-3-5-haiku-20241022-v1:0',

      // Claude 3 Sonnet
      'claude-3-sonnet': 'us.anthropic.claude-3-sonnet-20240229-v1:0',
      'claude-3-sonnet-20240229': 'us.anthropic.claude-3-sonnet-20240229-v1:0',

      // Claude 3 Haiku
      'claude-3-haiku': 'us.anthropic.claude-3-haiku-20240307-v1:0',
      'claude-3-haiku-20240307': 'us.anthropic.claude-3-haiku-20240307-v1:0'
    }

    // 如果已经是Bedrock格式，直接返回
    // Bedrock模型格式：{region}.anthropic.{model-name} 或 anthropic.{model-name}
    if (modelName.includes('.anthropic.') || modelName.startsWith('anthropic.')) {
      return modelName
    }

    // 查找映射
    const mappedModel = modelMapping[modelName]
    if (mappedModel) {
      return mappedModel
    }

    // 如果没有找到映射，返回原始模型名（可能会导致错误，但保持向后兼容）
    logger.warn(`⚠️ 未找到模型映射: ${modelName}，使用原始模型名`, {
      metadata: { originalModel: modelName }
    })
    return modelName
  }

  // 选择使用的区域
  _selectRegion(modelId, bedrockAccount) {
    // 优先使用账户配置的区域
    if (bedrockAccount?.region) {
      return bedrockAccount.region
    }

    // 对于小模型，使用专门的区域配置
    if (modelId.includes('haiku')) {
      return this.smallFastModelRegion
    }

    return this.defaultRegion
  }

  // 转换Claude格式请求到Bedrock格式
  _convertToBedrockFormat(requestBody) {
    // 透传客户端的 max_tokens，仅在未指定时使用默认值作为回退
    const maxTokens = requestBody.max_tokens || this.maxOutputTokens

    const bedrockPayload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      messages: requestBody.messages || []
    }

    // 添加系统提示词
    if (requestBody.system) {
      bedrockPayload.system = requestBody.system
    }

    // 添加其他参数
    if (requestBody.temperature !== undefined) {
      bedrockPayload.temperature = requestBody.temperature
    }

    if (requestBody.top_p !== undefined) {
      bedrockPayload.top_p = requestBody.top_p
    }

    if (requestBody.top_k !== undefined) {
      bedrockPayload.top_k = requestBody.top_k
    }

    if (requestBody.stop_sequences) {
      bedrockPayload.stop_sequences = requestBody.stop_sequences
    }

    // 工具调用支持
    if (requestBody.tools) {
      bedrockPayload.tools = requestBody.tools
    }

    if (requestBody.tool_choice) {
      bedrockPayload.tool_choice = requestBody.tool_choice
    }

    // Extended thinking 支持
    // Bedrock 只支持 "enabled" / "disabled"，不支持 "adaptive"
    // adaptive 模式不要求 budget_tokens，但 Bedrock enabled 必须有
    if (requestBody.thinking) {
      bedrockPayload.thinking = { ...requestBody.thinking }
      if (bedrockPayload.thinking.type === 'adaptive') {
        bedrockPayload.thinking.type = 'enabled'
        if (!bedrockPayload.thinking.budget_tokens) {
          bedrockPayload.thinking.budget_tokens = maxTokens - 1
        }
      }
    }

    // metadata 透传
    if (requestBody.metadata) {
      bedrockPayload.metadata = requestBody.metadata
    }

    return bedrockPayload
  }

  // 转换Bedrock响应到Claude格式
  _convertFromBedrockFormat(bedrockResponse) {
    return {
      id: `msg_${Date.now()}_bedrock`,
      type: 'message',
      role: 'assistant',
      content: bedrockResponse.content || [],
      model: this._mapFromBedrockModel(bedrockResponse.model) || this.defaultModel,
      stop_reason: bedrockResponse.stop_reason || 'end_turn',
      stop_sequence: bedrockResponse.stop_sequence || null,
      usage: bedrockResponse.usage || {
        input_tokens: 0,
        output_tokens: 0
      }
    }
  }

  // 转换Bedrock流事件到Claude SSE格式
  _convertBedrockStreamToClaudeFormat(bedrockChunk) {
    if (bedrockChunk.type === 'message_start') {
      const upstreamModel = bedrockChunk.message?.model
      return {
        type: 'message_start',
        data: {
          type: 'message',
          id: `msg_${Date.now()}_bedrock`,
          role: 'assistant',
          content: [],
          model: this._mapFromBedrockModel(upstreamModel) || this.defaultModel,
          stop_reason: null,
          stop_sequence: null,
          usage: bedrockChunk.message?.usage || { input_tokens: 0, output_tokens: 0 }
        }
      }
    }

    if (bedrockChunk.type === 'content_block_delta') {
      return {
        type: 'content_block_delta',
        data: {
          index: bedrockChunk.index || 0,
          delta: bedrockChunk.delta || {}
        }
      }
    }

    if (bedrockChunk.type === 'message_delta') {
      return {
        type: 'message_delta',
        data: {
          delta: bedrockChunk.delta || {},
          usage: bedrockChunk.usage || {}
        }
      }
    }

    if (bedrockChunk.type === 'message_stop') {
      return {
        type: 'message_stop',
        data: {
          usage: bedrockChunk.usage || {}
        }
      }
    }

    return null
  }

  // 处理Bedrock错误
  _handleBedrockError(error) {
    const errorMessage = error.message || 'Unknown Bedrock error'

    if (error.name === 'ValidationException') {
      return new Error(`Bedrock参数验证失败: ${errorMessage}`)
    }

    if (error.name === 'ThrottlingException') {
      return new Error('Bedrock请求限流，请稍后重试')
    }

    if (error.name === 'AccessDeniedException') {
      return new Error('Bedrock访问被拒绝，请检查IAM权限')
    }

    if (error.name === 'ModelNotReadyException') {
      return new Error('Bedrock模型未就绪，请稍后重试')
    }

    return new Error(`Bedrock服务错误: ${errorMessage}`)
  }

  // 获取可用模型列表
  async getAvailableModels(bedrockAccount = null) {
    try {
      const region = bedrockAccount?.region || this.defaultRegion

      // Bedrock暂不支持列出推理配置文件的API，返回预定义的模型列表
      const models = [
        {
          id: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
          name: 'Claude Sonnet 4',
          provider: 'anthropic',
          type: 'bedrock'
        },
        {
          id: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
          name: 'Claude Opus 4.1',
          provider: 'anthropic',
          type: 'bedrock'
        },
        {
          id: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
          name: 'Claude 3.7 Sonnet',
          provider: 'anthropic',
          type: 'bedrock'
        },
        {
          id: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
          name: 'Claude 3.5 Sonnet v2',
          provider: 'anthropic',
          type: 'bedrock'
        },
        {
          id: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
          name: 'Claude 3.5 Haiku',
          provider: 'anthropic',
          type: 'bedrock'
        }
      ]

      logger.debug(`📋 返回Bedrock可用模型 ${models.length} 个, 区域: ${region}`)
      return models
    } catch (error) {
      logger.error('❌ 获取Bedrock模型列表失败:', error)
      return []
    }
  }
}

module.exports = new BedrockRelayService()
