#!/usr/bin/env node

/**
 * Redis 小时级 usage key 批量清理脚本
 *
 * 清理目标（按优先级）：
 *   1. usage:*:model:hourly:*      ~52,000 keys  (API Key 模型小时统计)
 *   2. usage:hourly:*              ~30,000 keys  (API Key 小时统计)
 *   3. usage:cost:hourly:*         ~42,000 keys  (小时费用统计)
 *   4. account_usage:hourly:*       (账户小时统计)
 *   5. account_usage:model:hourly:* ~5,600 keys  (账户模型小时统计)
 *   6. fmt_claude_req:*             ~2,400 keys  (请求格式缓存，无TTL)
 *   7. usage:model:hourly:*         (全局模型小时统计)
 *
 * 用法：
 *   node scripts/cleanup-redis-hourly.js                          # 干跑（只统计不删）
 *   node scripts/cleanup-redis-hourly.js --execute                 # 实际执行删除
 *   node scripts/cleanup-redis-hourly.js --port=6380               # 指定端口（SSH 端口转发）
 *   node scripts/cleanup-redis-hourly.js --port=6380 --execute     # 指定端口 + 执行删除
 *   node scripts/cleanup-redis-hourly.js --execute --batch=500     # 自定义批次大小
 *
 * SSH 端口转发示例：
 *   ssh -L 6380:localhost:6379 cc2 -N &
 *   node scripts/cleanup-redis-hourly.js --port=6380               # 干跑确认
 *   node scripts/cleanup-redis-hourly.js --port=6380 --execute     # 执行删除
 *
 * 安全说明：
 *   - 默认干跑模式，必须显式传 --execute 才会删除
 *   - 执行前会打印 sample key 供人工确认
 *   - 使用 SCAN + pipeline DEL，不阻塞 Redis
 *   - 每批之间暂停 50ms，避免 CPU 突刺
 *   - 只删除 hourly 和临时缓存 key，不影响 daily/monthly 统计
 */

const Redis = require('ioredis')
const readline = require('readline')

// 解析参数
const args = process.argv.slice(2)
const dryRun = !args.includes('--execute')
const batchArg = args.find((a) => a.startsWith('--batch='))
const portArg = args.find((a) => a.startsWith('--port='))
const hostArg = args.find((a) => a.startsWith('--host='))
const passArg = args.find((a) => a.startsWith('--password='))
const BATCH_SIZE = batchArg ? parseInt(batchArg.split('=')[1]) : 200
const PAUSE_MS = 50

// 要清理的 key 模式（只匹配 hourly 统计和临时缓存，不会碰 daily/monthly/账户/限流数据）
const PATTERNS = [
  { pattern: 'usage:*:model:hourly:*', desc: 'API Key 模型小时统计' },
  { pattern: 'usage:hourly:*', desc: 'API Key 小时统计' },
  { pattern: 'usage:cost:hourly:*', desc: '小时费用统计' },
  { pattern: 'account_usage:hourly:*', desc: '账户小时统计' },
  { pattern: 'account_usage:model:hourly:*', desc: '账户模型小时统计' },
  { pattern: 'usage:model:hourly:*', desc: '全局模型小时统计' },
  { pattern: 'fmt_claude_req:*', desc: '请求格式缓存（无TTL）' }
]

// 安全校验：这些 key 前缀绝对不能删除
const PROTECTED_PREFIXES = [
  'apikey:',
  'claude:account:',
  'claude_account:',
  'claude_console_account:',
  'gemini_account:',
  'bedrock_account:',
  'openai_responses_account:',
  'azure_openai_account:',
  'droid:account:',
  'ccr_account:',
  'user:',
  'admin:',
  'session:',
  'rate_limit:',
  'usage:cost:daily:',
  'usage:cost:monthly:',
  'usage:cost:weekly:',
  'usage:cost:total:',
  'usage:daily:',
  'usage:monthly:',
  'usage:booster:',
  'account_usage:daily:',
  'account_usage:monthly:'
]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProtectedKey(key) {
  return PROTECTED_PREFIXES.some((prefix) => key.startsWith(prefix))
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes')
    })
  })
}

async function preflightCheck(client, pattern, _desc) {
  const [, sampleKeys] = await client.scan('0', 'MATCH', pattern, 'COUNT', 5)
  const count = sampleKeys.length

  if (count === 0) {
    console.log(`  (无匹配 key)`)
    return { safe: true, count: 0 }
  }

  // 安全校验：确认 sample key 不属于受保护的前缀
  for (const key of sampleKeys) {
    if (isProtectedKey(key)) {
      console.error(`  ❌ 安全校验失败！模式 "${pattern}" 匹配到受保护的 key: ${key}`)
      return { safe: false, count }
    }
  }

  console.log(`  样本 key (前 ${count} 个):`)
  for (const key of sampleKeys) {
    const ttl = await client.ttl(key)
    const ttlStr = ttl === -1 ? '无TTL(永久)' : ttl === -2 ? '已过期' : `${ttl}s`
    console.log(`    ${key}  [TTL: ${ttlStr}]`)
  }

  return { safe: true, count }
}

async function scanAndDelete(client, pattern, desc, isDryRun) {
  let cursor = '0'
  let totalFound = 0
  let totalDeleted = 0
  let protectedSkipped = 0

  console.log(`\n🔍 扫描: ${pattern} (${desc})`)

  do {
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', BATCH_SIZE)
    cursor = nextCursor
    totalFound += keys.length

    if (keys.length > 0) {
      // 二次安全过滤：逐 key 检查
      const safeKeys = []
      for (const key of keys) {
        if (isProtectedKey(key)) {
          protectedSkipped++
          console.warn(`  ⚠️ 跳过受保护的 key: ${key}`)
        } else {
          safeKeys.push(key)
        }
      }

      if (safeKeys.length > 0) {
        if (isDryRun) {
          totalDeleted += safeKeys.length
        } else {
          const pipeline = client.pipeline()
          safeKeys.forEach((key) => pipeline.del(key))
          const results = await pipeline.exec()
          const deleted = results.filter(([err, val]) => !err && val > 0).length
          totalDeleted += deleted
        }
      }
    }

    // 每批之间暂停，避免 CPU 突刺
    if (keys.length > 0) {
      await sleep(PAUSE_MS)
    }

    // 进度显示（每 5000 个 key 输出一次）
    if (totalFound > 0 && totalFound % 5000 < BATCH_SIZE) {
      console.log(
        `  ... 已扫描 ${totalFound} keys, ${isDryRun ? '将删除' : '已删除'} ${totalDeleted}`
      )
    }
  } while (cursor !== '0')

  console.log(
    `  ✅ 完成: 共 ${totalFound} keys, ${isDryRun ? '将删除' : '已删除'} ${totalDeleted} keys${
      protectedSkipped > 0 ? `, 跳过受保护 key: ${protectedSkipped}` : ''
    }`
  )
  return { found: totalFound, deleted: totalDeleted }
}

async function main() {
  console.log('='.repeat(60))
  console.log('Redis Hourly Key 清理工具')
  console.log(`模式: ${dryRun ? '🔍 干跑（只统计不删除）' : '🗑️  执行删除'}`)
  console.log(`批次大小: ${BATCH_SIZE}, 批间暂停: ${PAUSE_MS}ms`)
  console.log('='.repeat(60))

  // Redis 连接配置（优先命令行参数 > 环境变量 > 配置文件）
  const cliHost = hostArg ? hostArg.split('=')[1] : null
  const cliPort = portArg ? parseInt(portArg.split('=')[1]) : null
  const cliPassword = passArg ? passArg.split('=')[1] : null

  let redisConfig
  if (cliHost || cliPort || cliPassword) {
    // 使用命令行参数
    redisConfig = {
      host: cliHost || 'localhost',
      port: cliPort || 6379,
      password: cliPassword || undefined
    }
  } else {
    // 尝试从配置文件读取
    try {
      const config = require('../config/config')
      redisConfig = {
        host: config.redis?.host || process.env.REDIS_HOST || 'localhost',
        port: config.redis?.port || process.env.REDIS_PORT || 6379,
        password: config.redis?.password || process.env.REDIS_PASSWORD || undefined
      }
    } catch {
      redisConfig = {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || undefined
      }
    }
  }

  console.log(`\n连接 Redis: ${redisConfig.host}:${redisConfig.port}`)
  const client = new Redis({
    ...redisConfig,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    lazyConnect: true
  })

  try {
    await client.connect()
    await client.ping()
    const dbsize = await client.dbsize()
    const memInfo = await client.info('memory')
    const memMatch = memInfo.match(/used_memory_human:(\S+)/)
    console.log(`✅ Redis 连接成功, key 总数: ${dbsize}, 内存: ${memMatch ? memMatch[1] : '未知'}`)

    // ========== 预检阶段：展示 sample key 并做安全校验 ==========
    console.log(`\n${'-'.repeat(60)}`)
    console.log('📋 预检：每个模式的样本 key')
    console.log('-'.repeat(60))

    let allSafe = true
    for (const { pattern, desc } of PATTERNS) {
      console.log(`\n  模式: ${pattern} (${desc})`)
      const { safe } = await preflightCheck(client, pattern, desc)
      if (!safe) {
        allSafe = false
      }
    }

    if (!allSafe) {
      console.error('\n❌ 安全校验未通过，终止执行！')
      process.exit(1)
    }

    // 非干跑模式需要确认
    if (!dryRun) {
      console.log(`\n${'-'.repeat(60)}`)
      const ok = await confirm('⚠️  确认要删除以上匹配的 key 吗？(y/N) ')
      if (!ok) {
        console.log('已取消。')
        process.exit(0)
      }
    }

    // ========== 执行阶段 ==========
    let grandTotalFound = 0
    let grandTotalDeleted = 0

    for (const { pattern, desc } of PATTERNS) {
      const { found, deleted } = await scanAndDelete(client, pattern, desc, dryRun)
      grandTotalFound += found
      grandTotalDeleted += deleted
    }

    console.log(`\n${'='.repeat(60)}`)
    console.log('📊 汇总:')
    console.log(`  扫描到: ${grandTotalFound} keys`)
    console.log(`  ${dryRun ? '将删除' : '已删除'}: ${grandTotalDeleted} keys`)

    const dbsizeAfter = await client.dbsize()
    console.log(`  当前 key 总数: ${dbsizeAfter}`)
    if (!dryRun) {
      console.log(`  减少: ${dbsize - dbsizeAfter} keys`)
    }

    if (dryRun) {
      console.log('\n💡 确认无误后，执行:')
      if (cliPort) {
        console.log(`   node scripts/cleanup-redis-hourly.js --port=${cliPort} --execute`)
      } else {
        console.log('   node scripts/cleanup-redis-hourly.js --execute')
      }
    }
  } catch (error) {
    console.error('❌ 执行失败:', error.message)
    process.exit(1)
  } finally {
    await client.quit()
  }
}

main()
