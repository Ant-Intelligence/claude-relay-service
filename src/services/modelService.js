const logger = require('../utils/logger')

/**
 * 模型服务
 * 管理系统支持的 AI 模型列表
 * 与 pricingService 独立，专注于"支持哪些模型"而不是"如何计费"
 */
class ModelService {
  constructor() {
    this.supportedModels = this.getDefaultModels()
    // Claude 模型元数据映射（用于 Anthropic 格式 API）
    this.claudeModelMetadata = this.getClaudeModelMetadata()
  }

  /**
   * 初始化模型服务
   */
  async initialize() {
    const totalModels = Object.values(this.supportedModels).reduce(
      (sum, config) => sum + config.models.length,
      0
    )
    logger.success(`✅ Model service initialized with ${totalModels} models`)
  }

  /**
   * 获取 Claude 模型元数据
   * 用于 Anthropic 官方格式的 /v1/models API
   */
  getClaudeModelMetadata() {
    return {
      // Claude 4.6 系列
      'claude-opus-4-6': {
        display_name: 'Claude 4.6 Opus',
        created_at: '2026-02-05T00:00:00Z'
      },
      'claude-opus-4-6-20260205': {
        display_name: 'Claude 4.6 Opus',
        created_at: '2026-02-05T00:00:00Z'
      },
      'claude-sonnet-4-6': {
        display_name: 'Claude 4.6 Sonnet',
        created_at: '2026-02-18T00:00:00Z'
      },
      'claude-sonnet-4-6-20260218': {
        display_name: 'Claude 4.6 Sonnet',
        created_at: '2026-02-18T00:00:00Z'
      },
      // Claude 4.5 系列
      'claude-opus-4-5-20251101': {
        display_name: 'Claude 4.5 Opus',
        created_at: '2025-11-01T00:00:00Z'
      },
      'claude-sonnet-4-5-20250929': {
        display_name: 'Claude 4.5 Sonnet',
        created_at: '2025-09-29T00:00:00Z'
      },
      'claude-haiku-4-5-20251001': {
        display_name: 'Claude 4.5 Haiku',
        created_at: '2025-10-01T00:00:00Z'
      }
    }
  }

  /**
   * 从模型 ID 中提取日期并生成 created_at
   * @param {string} modelId - 模型 ID (如 claude-sonnet-4-20250514)
   */
  parseCreatedAtFromModelId(modelId) {
    // 尝试匹配模型 ID 末尾的日期格式 YYYYMMDD
    const dateMatch = modelId.match(/(\d{4})(\d{2})(\d{2})$/)
    if (dateMatch) {
      const [, year, month, day] = dateMatch
      return `${year}-${month}-${day}T00:00:00Z`
    }
    // 如果没有匹配到日期，返回当前时间
    return new Date().toISOString()
  }

  /**
   * 从模型 ID 生成 display_name
   * @param {string} modelId - 模型 ID
   */
  generateDisplayName(modelId) {
    // 移除末尾的日期
    const name = modelId.replace(/-\d{8}$/, '')
    const parts = name.split('-')

    if (parts[0] === 'claude' && parts.length >= 3) {
      // 判断命名格式
      const familyNames = ['opus', 'sonnet', 'haiku']
      const secondPart = parts[1].toLowerCase()

      if (familyNames.includes(secondPart)) {
        // 新格式: claude-{family}-{version} 如 claude-sonnet-4-5
        const family = parts[1].charAt(0).toUpperCase() + parts[1].slice(1)
        const versionParts = parts.slice(2).filter((p) => /^\d+$/.test(p))
        const version = versionParts.join('.')
        return `Claude ${version} ${family}`
      } else if (/^\d+$/.test(secondPart)) {
        // 旧格式: claude-{version}-{family} 如 claude-3-5-sonnet
        const versionParts = []
        let familyIndex = -1
        for (let i = 1; i < parts.length; i++) {
          if (/^\d+$/.test(parts[i])) {
            versionParts.push(parts[i])
          } else {
            familyIndex = i
            break
          }
        }
        const version = versionParts.join('.')
        const family =
          familyIndex >= 0
            ? parts[familyIndex].charAt(0).toUpperCase() + parts[familyIndex].slice(1)
            : ''
        return `Claude ${version} ${family}`.trim()
      }
    }

    // 默认：将连字符替换为空格，首字母大写
    return name
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }

  /**
   * 获取支持的模型配置
   */
  getDefaultModels() {
    return {
      claude: {
        provider: 'anthropic',
        description: 'Claude models from Anthropic',
        models: [
          // Claude 4.6 系列
          'claude-opus-4-6',
          'claude-sonnet-4-6',
          // Claude 4.5 系列
          'claude-opus-4-5-20251101',
          'claude-sonnet-4-5-20250929',
          'claude-haiku-4-5-20251001'
        ]
      },
      openai: {
        provider: 'openai',
        description: 'OpenAI GPT models',
        models: [
          // GPT-5.3 系列（最新）
          'gpt-5.3-codex',
          // GPT-5.2 系列
          'gpt-5.2-2025-12-11',
          'gpt-5.2-codex',
          'gpt-5.2-codex-mini',
          'gpt-5.2-codex-max',
          // GPT-5.1 系列
          'gpt-5.1-2025-11-13',
          'gpt-5.1-codex',
          'gpt-5.1-codex-mini',
          'gpt-5.1-codex-max',
          // GPT-5 系列
          'gpt-5',
          'gpt-5-2025-08-07',
          'gpt-5-codex',
          // o 系列推理模型
          'o3',
          'o3-mini',
          'o1',
          'o1-mini',
          'o1-preview',
          // GPT-4o 系列
          'gpt-4o',
          'gpt-4o-2024-11-20',
          'gpt-4o-2024-08-06',
          'gpt-4o-2024-05-13',
          'gpt-4o-mini',
          'gpt-4o-mini-2024-07-18',
          // GPT-4 Turbo 系列
          'gpt-4-turbo',
          'gpt-4-turbo-2024-04-09',
          'gpt-4-turbo-preview',
          // GPT-4 系列
          'gpt-4',
          'gpt-4-0613',
          'gpt-4-32k',
          'gpt-4-32k-0613',
          // GPT-3.5 系列
          'gpt-3.5-turbo',
          'gpt-3.5-turbo-0125',
          'gpt-3.5-turbo-1106',
          'gpt-3.5-turbo-16k'
        ]
      },
      gemini: {
        provider: 'google',
        description: 'Google Gemini models',
        models: [
          // Gemini 3 系列
          'gemini-3-pro-preview',
          'gemini-3-pro-image-preview',
          'gemini-3-flash-preview',
          // Gemini 2.5 系列
          'gemini-2.5-pro',
          'gemini-2.5-flash'
        ]
      }
    }
  }

  /**
   * 获取所有支持的模型（OpenAI API 格式）
   */
  getAllModels() {
    const models = []
    const now = Math.floor(Date.now() / 1000)

    for (const [_service, config] of Object.entries(this.supportedModels)) {
      for (const modelId of config.models) {
        models.push({
          id: modelId,
          object: 'model',
          created: now,
          owned_by: config.provider
        })
      }
    }

    return models.sort((a, b) => {
      // 先按 provider 排序，再按 model id 排序
      if (a.owned_by !== b.owned_by) {
        return a.owned_by.localeCompare(b.owned_by)
      }
      return a.id.localeCompare(b.id)
    })
  }

  /**
   * 获取 Claude 模型列表（Anthropic 官方 API 格式）
   * @param {Object} options - 分页选项
   * @param {number} options.limit - 返回的最大模型数 (默认 20, 最大 100)
   * @param {string} options.after_id - 返回此 ID 之后的模型
   * @param {string} options.before_id - 返回此 ID 之前的模型
   * @returns {Object} Anthropic 格式的模型列表响应
   */
  getClaudeModelsAnthropic(options = {}) {
    const { limit = 20, after_id = null, before_id = null } = options
    const maxLimit = Math.min(Math.max(1, limit), 100) // 限制在 1-100 之间

    // 获取所有 Claude 模型并按 ID 排序
    const claudeModels = this.supportedModels.claude.models
      .map((modelId) => {
        const metadata = this.claudeModelMetadata[modelId]
        return {
          id: modelId,
          created_at: metadata?.created_at || this.parseCreatedAtFromModelId(modelId),
          display_name: metadata?.display_name || this.generateDisplayName(modelId),
          type: 'model'
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))

    // 应用分页过滤
    let filteredModels = claudeModels
    let startIndex = 0
    let endIndex = claudeModels.length

    if (after_id) {
      const afterIndex = claudeModels.findIndex((m) => m.id === after_id)
      if (afterIndex !== -1) {
        startIndex = afterIndex + 1
      }
    }

    if (before_id) {
      const beforeIndex = claudeModels.findIndex((m) => m.id === before_id)
      if (beforeIndex !== -1) {
        endIndex = beforeIndex
      }
    }

    filteredModels = claudeModels.slice(startIndex, endIndex)

    // 应用 limit
    const paginatedModels = filteredModels.slice(0, maxLimit)
    const hasMore = filteredModels.length > maxLimit

    return {
      data: paginatedModels,
      first_id: paginatedModels.length > 0 ? paginatedModels[0].id : null,
      has_more: hasMore,
      last_id: paginatedModels.length > 0 ? paginatedModels[paginatedModels.length - 1].id : null
    }
  }

  /**
   * 获取单个 Claude 模型信息（Anthropic 官方 API 格式）
   * @param {string} modelId - 模型 ID
   * @returns {Object|null} 模型信息或 null
   */
  getClaudeModelAnthropic(modelId) {
    if (!this.supportedModels.claude.models.includes(modelId)) {
      return null
    }

    const metadata = this.claudeModelMetadata[modelId]
    return {
      id: modelId,
      created_at: metadata?.created_at || this.parseCreatedAtFromModelId(modelId),
      display_name: metadata?.display_name || this.generateDisplayName(modelId),
      type: 'model'
    }
  }

  /**
   * 按 provider 获取模型
   * @param {string} provider - 'anthropic', 'openai', 'google' 等
   */
  getModelsByProvider(provider) {
    return this.getAllModels().filter((m) => m.owned_by === provider)
  }

  /**
   * 检查模型是否被支持
   * @param {string} modelId - 模型 ID
   */
  isModelSupported(modelId) {
    if (!modelId) {
      return false
    }
    return this.getAllModels().some((m) => m.id === modelId)
  }

  /**
   * 获取模型的 provider
   * @param {string} modelId - 模型 ID
   */
  getModelProvider(modelId) {
    const model = this.getAllModels().find((m) => m.id === modelId)
    return model ? model.owned_by : null
  }

  /**
   * 获取服务状态
   */
  getStatus() {
    const totalModels = Object.values(this.supportedModels).reduce(
      (sum, config) => sum + config.models.length,
      0
    )

    return {
      initialized: true,
      totalModels,
      providers: Object.keys(this.supportedModels)
    }
  }

  /**
   * 清理资源（保留接口兼容性）
   */
  cleanup() {
    logger.debug('📋 Model service cleanup (no-op)')
  }
}

module.exports = new ModelService()
