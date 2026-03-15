#!/usr/bin/env node
/**
 * 查询指定账户的 Token 使用量和费用统计
 *
 * 用法: node scripts/query-account-usage.js -n <name> [-d <date>] [-r <redis_url>]
 *
 * 参数:
 *   -n, --name         账户名称 (必填，支持模糊匹配)
 *   -d, --date         查询日期 (格式: YYYY-MM-DD，默认: 今天)
 *   -r, --redis        Redis URL (默认: 从环境变量或 redis://localhost:6379)
 *   --all-types        搜索所有账户类型 (默认只搜索 claude 相关)
 *   --json             以 JSON 格式输出
 *   --help             显示帮助
 *
 * 示例:
 *   node scripts/query-account-usage.js -n llm-2-api
 *   node scripts/query-account-usage.js -n llm-2-api -d 2026-03-02
 *   node scripts/query-account-usage.js -n ccplus -r redis://127.0.0.1:6380
 *   node scripts/query-account-usage.js -n myaccount --all-types
 *   ssh -v -N -L 6380:localhost:6379 cc2
 */

const Redis = require('ioredis')
const fs = require('fs')
const path = require('path')

// ========== 账户类型前缀 ==========
const CLAUDE_ACCOUNT_PREFIXES = ['claude:account:', 'claude_console_account:']

const ALL_ACCOUNT_PREFIXES = [
  'claude:account:',
  'claude_console_account:',
  'bedrock_account:',
  'gemini_account:',
  'droid_account:',
  'ccr_account:',
  'openai_responses_account:',
  'azure_openai_account:',
  'openai_account:'
]

// ========== 参数解析 ==========
function buildRedisUrl() {
  if (process.env.REDIS_URL) {
    return process.env.REDIS_URL
  }
  const host = process.env.REDIS_HOST || 'localhost'
  const port = process.env.REDIS_PORT || '6379'
  const password = process.env.REDIS_PASSWORD
  return password ? `redis://:${password}@${host}:${port}` : `redis://${host}:${port}`
}

function parseArgs() {
  const args = process.argv.slice(2)
  const config = {
    name: null,
    date: null,
    redis: buildRedisUrl(),
    allTypes: false,
    json: false
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]
    switch (arg) {
      case '-n':
      case '--name':
        config.name = next
        i++
        break
      case '-d':
      case '--date':
        config.date = next
        i++
        break
      case '-r':
      case '--redis':
        config.redis = next
        i++
        break
      case '--all-types':
        config.allTypes = true
        break
      case '--json':
        config.json = true
        break
      case '--help':
        showHelp()
        process.exit(0)
    }
  }
  return config
}

function showHelp() {
  console.log(`
查询指定账户的 Token 使用量和费用统计

用法: node scripts/query-account-usage.js -n <name> [options]

参数:
  -n, --name         账户名称 (必填，支持模糊匹配)
  -d, --date         查询日期 (格式: YYYY-MM-DD，默认: 今天)
  -r, --redis        Redis URL (默认: 从环境变量或 redis://localhost:6379)
  --all-types        搜索所有账户类型 (默认只搜索 claude 相关)
  --json             以 JSON 格式输出
  --help             显示帮助

示例:
  node scripts/query-account-usage.js -n llm-2-api
  node scripts/query-account-usage.js -n llm-2-api -d 2026-03-02
  node scripts/query-account-usage.js -n ccplus --all-types
  node scripts/query-account-usage.js -n myaccount --json
`)
}

// ========== 时区工具 ==========
const TIMEZONE_OFFSET = parseInt(process.env.TIMEZONE_OFFSET) || 8

function getDateInTimezone(date = new Date()) {
  return new Date(date.getTime() + TIMEZONE_OFFSET * 3600000)
}

function getDateStringInTimezone(date = new Date()) {
  const tz = getDateInTimezone(date)
  return `${tz.getUTCFullYear()}-${String(tz.getUTCMonth() + 1).padStart(2, '0')}-${String(tz.getUTCDate()).padStart(2, '0')}`
}

function validateDateFormat(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(new Date(dateStr))
}

// ========== 定价 ==========
function loadPricing() {
  const candidates = [
    path.join(process.cwd(), 'data', 'model_pricing.json'),
    path.join(process.cwd(), 'resources', 'model-pricing', 'model_prices_and_context_window.json')
  ]
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        // ignore parse error, try next
      }
    }
  }
  return null
}

function getModelPrice(pricingData, modelName) {
  if (!pricingData || !modelName) {
    return null
  }

  // 1) exact match
  if (pricingData[modelName]) {
    return pricingData[modelName]
  }

  // 2) fuzzy match (normalize dots/hyphens/underscores)
  const norm = modelName.toLowerCase().replace(/[_\-.]/g, '')
  for (const [key, val] of Object.entries(pricingData)) {
    if (key.includes('/')) {
      continue
    }
    const nk = key.toLowerCase().replace(/[_\-.]/g, '')
    if (nk.includes(norm) || norm.includes(nk)) {
      return val
    }
  }
  return null
}

function calcModelCost(pricing, tokens) {
  const inputPrice = pricing.input_cost_per_token || 0
  const outputPrice = pricing.output_cost_per_token || 0
  let cacheCreatePrice = pricing.cache_creation_input_token_cost
  let cacheReadPrice = pricing.cache_read_input_token_cost

  // Claude fallback multipliers
  if (cacheCreatePrice === undefined) {
    cacheCreatePrice = inputPrice * 1.25
  }
  if (cacheReadPrice === undefined) {
    cacheReadPrice = inputPrice * 0.1
  }

  const inputCost = tokens.inputTokens * inputPrice
  const outputCost = tokens.outputTokens * outputPrice
  const cacheCreateCost = tokens.cacheCreateTokens * (cacheCreatePrice || 0)
  const cacheReadCost = tokens.cacheReadTokens * (cacheReadPrice || 0)

  return {
    inputCost,
    outputCost,
    cacheCreateCost,
    cacheReadCost,
    totalCost: inputCost + outputCost + cacheCreateCost + cacheReadCost,
    pricing: {
      input: inputPrice * 1e6,
      output: outputPrice * 1e6,
      cacheCreate: (cacheCreatePrice || 0) * 1e6,
      cacheRead: (cacheReadPrice || 0) * 1e6
    }
  }
}

// ========== Redis Key 查询 ==========
// 账户 key 数量有限（几十个），直接用 KEYS 比 SCAN 快得多（尤其通过 SSH 隧道时）
// 对于 usage 数据也使用 KEYS，因为单账户的 usage key 数量同样有限
async function fetchKeys(redis, pattern) {
  return redis.keys(pattern)
}

// ========== 格式化 ==========
function fmtNum(n) {
  return n.toLocaleString('en-US')
}

function fmtTokens(n) {
  if (n >= 1e9) {
    return `${(n / 1e9).toFixed(2)}B`
  }
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(1)}M`
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(1)}K`
  }
  return String(n)
}

function fmtCost(c) {
  if (c >= 1) {
    return `$${c.toFixed(2)}`
  }
  if (c >= 0.001) {
    return `$${c.toFixed(4)}`
  }
  return `$${c.toFixed(6)}`
}

function padR(s, len) {
  return String(s).padEnd(len)
}

function padL(s, len) {
  return String(s).padStart(len)
}

// ========== 查找账户 ==========
async function findAccount(redis, name, allTypes) {
  const prefixes = allTypes ? ALL_ACCOUNT_PREFIXES : CLAUDE_ACCOUNT_PREFIXES
  const matches = []
  const nameLower = name.toLowerCase()

  for (const prefix of prefixes) {
    const keys = await fetchKeys(redis, `${prefix}*`)
    if (keys.length === 0) {
      continue
    }

    // Use pipeline to batch hget calls for performance (critical over SSH tunnels)
    const pipeline = redis.pipeline()
    for (const key of keys) {
      pipeline.hget(key, 'name')
    }
    const nameResults = await pipeline.exec()

    // Filter matches, then batch-fetch platform/status for matched keys only
    const matchedIndices = []
    for (let i = 0; i < keys.length; i++) {
      const acctName = nameResults[i]?.[1]
      if (!acctName) {
        continue
      }
      if (acctName.toLowerCase().includes(nameLower)) {
        matchedIndices.push(i)
      }
    }

    if (matchedIndices.length > 0) {
      const detailPipe = redis.pipeline()
      for (const idx of matchedIndices) {
        detailPipe.hmget(keys[idx], 'name', 'platform', 'status')
      }
      const detailResults = await detailPipe.exec()

      for (let j = 0; j < matchedIndices.length; j++) {
        const key = keys[matchedIndices[j]]
        const [acctName, platform, status] = detailResults[j]?.[1] || []
        const id = key.replace(prefix, '')
        matches.push({
          id,
          name: acctName || 'unknown',
          platform: platform || prefix.replace(/_?account:$/, ''),
          status: status || 'unknown',
          key,
          prefix
        })
      }
    }
  }
  return matches
}

// ========== 查询使用量 ==========
async function queryUsage(redis, accountId, date) {
  // 日汇总
  const dailyData = await redis.hgetall(`account_usage:daily:${accountId}:${date}`)

  // 模型级别日汇总
  const modelDailyKeys = await fetchKeys(redis, `account_usage:model:daily:${accountId}:*:${date}`)
  const modelUsage = []
  if (modelDailyKeys.length > 0) {
    const modelPipe = redis.pipeline()
    for (const key of modelDailyKeys) {
      modelPipe.hgetall(key)
    }
    const modelResults = await modelPipe.exec()
    for (let i = 0; i < modelDailyKeys.length; i++) {
      const parts = modelDailyKeys[i].split(':')
      const model = parts.slice(4, -1).join(':')
      const data = modelResults[i]?.[1] || {}
      modelUsage.push({
        model,
        inputTokens: parseInt(data.inputTokens) || 0,
        outputTokens: parseInt(data.outputTokens) || 0,
        cacheCreateTokens: parseInt(data.cacheCreateTokens) || 0,
        cacheReadTokens: parseInt(data.cacheReadTokens) || 0,
        allTokens: parseInt(data.allTokens) || 0,
        requests: parseInt(data.requests) || 0
      })
    }
  }

  // 小时级别
  const hourlyKeys = (await fetchKeys(redis, `account_usage:hourly:${accountId}:${date}:*`)).sort()
  const hourlyUsage = []
  if (hourlyKeys.length > 0) {
    const hourPipe = redis.pipeline()
    for (const key of hourlyKeys) {
      hourPipe.hgetall(key)
    }
    const hourResults = await hourPipe.exec()
    for (let i = 0; i < hourlyKeys.length; i++) {
      const hour = hourlyKeys[i].split(':').pop()
      const data = hourResults[i]?.[1] || {}
      hourlyUsage.push({
        hour: `${hour.padStart(2, '0')}:00`,
        inputTokens: parseInt(data.inputTokens) || 0,
        outputTokens: parseInt(data.outputTokens) || 0,
        cacheCreateTokens: parseInt(data.cacheCreateTokens) || 0,
        cacheReadTokens: parseInt(data.cacheReadTokens) || 0,
        allTokens: parseInt(data.allTokens) || 0,
        requests: parseInt(data.requests) || 0
      })
    }
  }

  // 累计总量
  const totalData = await redis.hgetall(`account_usage:${accountId}`)

  return {
    daily: {
      inputTokens: parseInt(dailyData.inputTokens) || 0,
      outputTokens: parseInt(dailyData.outputTokens) || 0,
      cacheCreateTokens: parseInt(dailyData.cacheCreateTokens) || 0,
      cacheReadTokens: parseInt(dailyData.cacheReadTokens) || 0,
      allTokens: parseInt(dailyData.allTokens) || 0,
      requests: parseInt(dailyData.requests) || 0
    },
    models: modelUsage.sort((a, b) => b.allTokens - a.allTokens),
    hourly: hourlyUsage,
    cumulative: {
      totalInputTokens: parseInt(totalData.totalInputTokens) || 0,
      totalOutputTokens: parseInt(totalData.totalOutputTokens) || 0,
      totalCacheCreateTokens: parseInt(totalData.totalCacheCreateTokens) || 0,
      totalCacheReadTokens: parseInt(totalData.totalCacheReadTokens) || 0,
      totalAllTokens: parseInt(totalData.totalAllTokens) || 0,
      totalRequests: parseInt(totalData.totalRequests) || 0
    }
  }
}

// ========== 输出 ==========
function printReport(account, date, usage, pricingData) {
  const SEP = '─'.repeat(90)
  const DSEP = '═'.repeat(90)

  console.log()
  console.log(DSEP)
  console.log(`  Account Usage Report`)
  console.log(DSEP)
  console.log(`  Account:   ${account.name}`)
  console.log(`  ID:        ${account.id}`)
  console.log(`  Platform:  ${account.platform}`)
  console.log(`  Status:    ${account.status}`)
  console.log(`  Date:      ${date}`)
  console.log(SEP)

  // === Daily Summary ===
  const d = usage.daily
  if (d.requests === 0) {
    console.log(`\n  No usage data found for ${date}.\n`)
    printCumulative(usage.cumulative)
    return
  }

  console.log(`\n  [Daily Summary]`)
  console.log(`    Requests:             ${fmtNum(d.requests)}`)
  console.log(
    `    Input Tokens:         ${padL(fmtNum(d.inputTokens), 15)}  (${fmtTokens(d.inputTokens)})`
  )
  console.log(
    `    Output Tokens:        ${padL(fmtNum(d.outputTokens), 15)}  (${fmtTokens(d.outputTokens)})`
  )
  console.log(
    `    Cache Create Tokens:  ${padL(fmtNum(d.cacheCreateTokens), 15)}  (${fmtTokens(d.cacheCreateTokens)})`
  )
  console.log(
    `    Cache Read Tokens:    ${padL(fmtNum(d.cacheReadTokens), 15)}  (${fmtTokens(d.cacheReadTokens)})`
  )
  console.log(
    `    All Tokens:           ${padL(fmtNum(d.allTokens), 15)}  (${fmtTokens(d.allTokens)})`
  )

  // Calculate total daily cost
  let totalDailyCost = 0
  const modelCosts = []

  for (const m of usage.models) {
    const pricing = getModelPrice(pricingData, m.model)
    if (pricing) {
      const cost = calcModelCost(pricing, m)
      totalDailyCost += cost.totalCost
      modelCosts.push({ ...m, cost })
    } else {
      modelCosts.push({ ...m, cost: null })
    }
  }

  console.log(`    ────────────────────────────────`)
  console.log(`    Total Cost:           ${padL(fmtCost(totalDailyCost), 15)}`)

  // === Cost Breakdown ===
  if (modelCosts.length > 0 && pricingData) {
    let totalInput = 0,
      totalOutput = 0,
      totalCC = 0,
      totalCR = 0
    for (const mc of modelCosts) {
      if (mc.cost) {
        totalInput += mc.cost.inputCost
        totalOutput += mc.cost.outputCost
        totalCC += mc.cost.cacheCreateCost
        totalCR += mc.cost.cacheReadCost
      }
    }
    console.log(`\n  [Cost Breakdown]`)
    console.log(
      `    Input Cost:           ${padL(fmtCost(totalInput), 15)}  (${((totalInput / totalDailyCost) * 100).toFixed(1)}%)`
    )
    console.log(
      `    Output Cost:          ${padL(fmtCost(totalOutput), 15)}  (${((totalOutput / totalDailyCost) * 100).toFixed(1)}%)`
    )
    console.log(
      `    Cache Create Cost:    ${padL(fmtCost(totalCC), 15)}  (${((totalCC / totalDailyCost) * 100).toFixed(1)}%)`
    )
    console.log(
      `    Cache Read Cost:      ${padL(fmtCost(totalCR), 15)}  (${((totalCR / totalDailyCost) * 100).toFixed(1)}%)`
    )
  }

  // === Per-Model ===
  if (modelCosts.length > 0) {
    // Sort by cost desc
    modelCosts.sort((a, b) => (b.cost?.totalCost || 0) - (a.cost?.totalCost || 0))

    console.log(`\n  [Per-Model Breakdown]`)
    console.log(SEP)

    const hModel = padR('Model', 32)
    const hReq = padL('Requests', 9)
    const hInput = padL('Input', 10)
    const hOutput = padL('Output', 10)
    const hCCreate = padL('CacheCreate', 12)
    const hCRead = padL('CacheRead', 12)
    const hCost = padL('Cost', 12)
    const hShare = padL('Share', 7)
    console.log(`  ${hModel}${hReq}${hInput}${hOutput}${hCCreate}${hCRead}${hCost}${hShare}`)
    console.log(SEP)

    for (const mc of modelCosts) {
      const model = padR(mc.model, 32)
      const req = padL(fmtNum(mc.requests), 9)
      const inp = padL(fmtTokens(mc.inputTokens), 10)
      const out = padL(fmtTokens(mc.outputTokens), 10)
      const cc = padL(fmtTokens(mc.cacheCreateTokens), 12)
      const cr = padL(fmtTokens(mc.cacheReadTokens), 12)
      const cost = mc.cost ? padL(fmtCost(mc.cost.totalCost), 12) : padL('N/A', 12)
      const share =
        mc.cost && totalDailyCost > 0
          ? padL(`${((mc.cost.totalCost / totalDailyCost) * 100).toFixed(1)}%`, 7)
          : padL('-', 7)
      console.log(`  ${model}${req}${inp}${out}${cc}${cr}${cost}${share}`)
    }

    console.log(SEP)
    const totModel = padR('TOTAL', 32)
    const totReq = padL(fmtNum(d.requests), 9)
    const totInp = padL(fmtTokens(d.inputTokens), 10)
    const totOut = padL(fmtTokens(d.outputTokens), 10)
    const totCC = padL(fmtTokens(d.cacheCreateTokens), 12)
    const totCR = padL(fmtTokens(d.cacheReadTokens), 12)
    const totCost = padL(fmtCost(totalDailyCost), 12)
    console.log(
      `  ${totModel}${totReq}${totInp}${totOut}${totCC}${totCR}${totCost}${padL('100%', 7)}`
    )

    // === Per-Model Detail (pricing) ===
    console.log(`\n  [Model Pricing Detail]`)
    console.log(SEP)
    const pH = `  ${padR('Model', 32)}${padL('$/MTok In', 10)}${padL('$/MTok Out', 11)}${padL('$/MTok CC', 11)}${padL('$/MTok CR', 11)}${padL('In Cost', 11)}${padL('Out Cost', 11)}${padL('CC Cost', 11)}${padL('CR Cost', 11)}`
    console.log(pH)
    console.log(SEP)
    for (const mc of modelCosts) {
      if (!mc.cost) {
        continue
      }
      const p = mc.cost.pricing
      const line = `  ${padR(mc.model, 32)}${padL(`$${p.input.toFixed(2)}`, 10)}${padL(`$${p.output.toFixed(2)}`, 11)}${padL(`$${p.cacheCreate.toFixed(2)}`, 11)}${padL(`$${p.cacheRead.toFixed(2)}`, 11)}${padL(fmtCost(mc.cost.inputCost), 11)}${padL(fmtCost(mc.cost.outputCost), 11)}${padL(fmtCost(mc.cost.cacheCreateCost), 11)}${padL(fmtCost(mc.cost.cacheReadCost), 11)}`
      console.log(line)
    }
  }

  // === Hourly ===
  if (usage.hourly.length > 0) {
    console.log(`\n  [Hourly Distribution] (UTC+${TIMEZONE_OFFSET})`)
    console.log(SEP)
    const hH = `  ${padR('Hour', 8)}${padL('Requests', 10)}${padL('Input', 12)}${padL('Output', 12)}${padL('CacheCreate', 14)}${padL('CacheRead', 14)}${padL('All Tokens', 14)}`
    console.log(hH)
    console.log(SEP)
    for (const h of usage.hourly) {
      console.log(
        `  ${padR(h.hour, 8)}${padL(fmtNum(h.requests), 10)}${padL(fmtTokens(h.inputTokens), 12)}${padL(fmtTokens(h.outputTokens), 12)}${padL(fmtTokens(h.cacheCreateTokens), 14)}${padL(fmtTokens(h.cacheReadTokens), 14)}${padL(fmtTokens(h.allTokens), 14)}`
      )
    }
  }

  // === Cache Efficiency ===
  if (d.cacheCreateTokens > 0 || d.cacheReadTokens > 0) {
    const ratio =
      d.cacheCreateTokens > 0 ? (d.cacheReadTokens / d.cacheCreateTokens).toFixed(2) : 'N/A'
    console.log(`\n  [Cache Efficiency]`)
    console.log(`    Cache Read/Write Ratio:  ${ratio}:1`)
    console.log(`    Cache Create Tokens:     ${fmtTokens(d.cacheCreateTokens)}`)
    console.log(`    Cache Read Tokens:       ${fmtTokens(d.cacheReadTokens)}`)
  }

  // === Cumulative ===
  printCumulative(usage.cumulative)

  console.log()
  console.log(DSEP)
}

function printCumulative(cum) {
  if (cum.totalRequests > 0) {
    console.log(`\n  [Cumulative (All Time)]`)
    console.log(`    Total Requests:       ${fmtNum(cum.totalRequests)}`)
    console.log(`    Total Input Tokens:   ${fmtTokens(cum.totalInputTokens)}`)
    console.log(`    Total Output Tokens:  ${fmtTokens(cum.totalOutputTokens)}`)
    console.log(`    Total Cache Create:   ${fmtTokens(cum.totalCacheCreateTokens)}`)
    console.log(`    Total Cache Read:     ${fmtTokens(cum.totalCacheReadTokens)}`)
    console.log(`    Total All Tokens:     ${fmtTokens(cum.totalAllTokens)}`)
  }
}

function printJson(account, date, usage, pricingData) {
  const modelCosts = usage.models.map((m) => {
    const pricing = getModelPrice(pricingData, m.model)
    const cost = pricing ? calcModelCost(pricing, m) : null
    return { ...m, cost }
  })

  const totalCost = modelCosts.reduce((sum, mc) => sum + (mc.cost?.totalCost || 0), 0)

  const output = {
    account: {
      name: account.name,
      id: account.id,
      platform: account.platform,
      status: account.status
    },
    date,
    daily: { ...usage.daily, totalCost },
    models: modelCosts.map((mc) => ({
      model: mc.model,
      requests: mc.requests,
      inputTokens: mc.inputTokens,
      outputTokens: mc.outputTokens,
      cacheCreateTokens: mc.cacheCreateTokens,
      cacheReadTokens: mc.cacheReadTokens,
      allTokens: mc.allTokens,
      cost: mc.cost
        ? {
            inputCost: mc.cost.inputCost,
            outputCost: mc.cost.outputCost,
            cacheCreateCost: mc.cost.cacheCreateCost,
            cacheReadCost: mc.cost.cacheReadCost,
            totalCost: mc.cost.totalCost,
            pricing: mc.cost.pricing
          }
        : null
    })),
    hourly: usage.hourly,
    cumulative: usage.cumulative
  }

  console.log(JSON.stringify(output, null, 2))
}

// ========== 主流程 ==========
async function main() {
  const config = parseArgs()

  if (!config.name) {
    console.error('❌ Error: account name is required (-n)')
    console.error('   Use --help for usage info')
    process.exit(1)
  }

  if (!config.date) {
    config.date = getDateStringInTimezone()
  }

  if (!validateDateFormat(config.date)) {
    console.error(`❌ Error: invalid date format (${config.date}), use YYYY-MM-DD`)
    process.exit(1)
  }

  // Load pricing
  const pricingData = loadPricing()
  if (!pricingData && !config.json) {
    console.warn('⚠️  No pricing data found, cost calculation will be unavailable')
  }

  let redis
  try {
    redis = new Redis(config.redis, { maxRetriesPerRequest: 3, retryDelayOnFailover: 100 })

    if (!config.json) {
      console.log(`🔗 Redis: ${config.redis.replace(/:([^:@]+)@/, ':***@')}`)
      console.log(`🔍 Searching for account: "${config.name}"...`)
    }

    const accounts = await findAccount(redis, config.name, config.allTypes)

    if (accounts.length === 0) {
      console.error(`❌ No account found matching "${config.name}"`)
      if (!config.allTypes) {
        console.error('   Tip: use --all-types to search non-Claude accounts')
      }
      process.exit(1)
    }

    if (accounts.length > 1 && !config.json) {
      console.log(`\n📋 Found ${accounts.length} matching accounts:\n`)
      for (let i = 0; i < accounts.length; i++) {
        console.log(
          `  [${i + 1}] ${accounts[i].name} (${accounts[i].platform}) - ${accounts[i].status}`
        )
      }
      console.log(`\n  Querying all ${accounts.length} accounts...\n`)
    }

    for (const account of accounts) {
      if (!config.json && accounts.length <= 1) {
        console.log(`✅ Found: ${account.name} (${account.platform})`)
      }

      const usage = await queryUsage(redis, account.id, config.date)

      if (config.json) {
        printJson(account, config.date, usage, pricingData)
      } else {
        printReport(account, config.date, usage, pricingData)
      }
    }
  } catch (err) {
    console.error(`❌ Error: ${err.message}`)
    process.exit(1)
  } finally {
    if (redis) {
      await redis.quit()
    }
  }
}

main().catch((err) => {
  console.error(`❌ Fatal: ${err.message}`)
  process.exit(1)
})
