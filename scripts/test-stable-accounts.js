/**
 * 稳定账户类型功能测试脚本
 *
 * 使用本地已有的两个 Console 账号（cc-club, pin-cc-new）测试稳定账户调度逻辑。
 * 测试完成后还原所有修改。
 */

require('dotenv').config()
const redis = require('../src/models/redis')
const unifiedClaudeScheduler = require('../src/services/unifiedClaudeScheduler')

// 颜色输出
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`
}

const pass = (msg) => console.log(c.green(`  ✅ PASS: ${msg}`))
const fail = (msg) => console.log(c.red(`  ❌ FAIL: ${msg}`))
const info = (msg) => console.log(c.blue(`  ℹ  ${msg}`))
const section = (msg) => console.log(c.bold(c.yellow(`\n=== ${msg} ===`)))

// 账号 ID（来自截图）
const CC_CLUB_ID = '59b7d8a0-eab2-46cd-8695-45951fd75e62'
const PIN_CC_ID = '3593c920-c174-40fd-9ae5-2d633832297d'

const STABLE_KEY = `claude_console_account:${CC_CLUB_ID}`
const _SHARED_KEY = `claude_console_account:${PIN_CC_ID}`
const SESSION_PREFIX = 'unified_claude_session_mapping:'
const STABLE_SESSIONS_KEY = `stable_account_sessions:${CC_CLUB_ID}`

const testSessionHashes = []
let originalAccountType = null

async function setup() {
  section('Setup: 将 cc-club 设置为 stable 账号 (maxStableSessions=1, stableInactivityMinutes=1)')

  const client = redis.getClientSafe()

  // 备份原始 accountType
  originalAccountType = await client.hget(STABLE_KEY, 'accountType')
  info(`cc-club 原始 accountType: ${originalAccountType}`)

  // 设置为 stable
  await client.hset(STABLE_KEY, 'accountType', 'stable')
  await client.hset(STABLE_KEY, 'maxStableSessions', '1')
  await client.hset(STABLE_KEY, 'stableInactivityMinutes', '1')

  const newType = await client.hget(STABLE_KEY, 'accountType')
  const maxSessions = await client.hget(STABLE_KEY, 'maxStableSessions')
  const inactivity = await client.hget(STABLE_KEY, 'stableInactivityMinutes')
  pass(
    `cc-club 已设置为 stable (accountType=${newType}, maxStableSessions=${maxSessions}, stableInactivityMinutes=${inactivity})`
  )

  // 清理可能残留的测试会话数据
  await client.del(STABLE_SESSIONS_KEY)
  const existingKeys = await client.keys(`${SESSION_PREFIX}test_stable_*`)
  if (existingKeys.length > 0) {
    await client.del(...existingKeys)
  }
}

async function runTests() {
  const client = redis.getClientSafe()
  let allPassed = true

  // ─────────────────────────────────────────────────────────────────
  section('Test 1: _countActiveStableSessionSlots — 空集合时返回 0')
  // ─────────────────────────────────────────────────────────────────
  {
    const count = await unifiedClaudeScheduler._countActiveStableSessionSlots(CC_CLUB_ID, 1)
    if (count === 0) {
      pass(`无会话时活跃槽数量 = ${count}`)
    } else {
      fail(`期望 0，实际 ${count}`)
      allPassed = false
    }
  }

  // ─────────────────────────────────────────────────────────────────
  section('Test 2: _addToStableAccountSessions + _countActiveStableSessionSlots — 新会话占用 1 槽')
  // ─────────────────────────────────────────────────────────────────
  {
    const sessionHash = `test_stable_h1_${Date.now()}`
    testSessionHashes.push(sessionHash)

    // 创建活跃的会话映射（lastActivity = 现在）
    await unifiedClaudeScheduler._setSessionMapping(sessionHash, CC_CLUB_ID, 'claude-console')
    await unifiedClaudeScheduler._addToStableAccountSessions(CC_CLUB_ID, sessionHash)

    const count = await unifiedClaudeScheduler._countActiveStableSessionSlots(CC_CLUB_ID, 1)
    if (count === 1) {
      pass(`添加 1 个活跃会话后，活跃槽数量 = ${count}`)
    } else {
      fail(`期望 1，实际 ${count}`)
      allPassed = false
    }

    // 验证 Redis Set 内容
    const members = await client.smembers(STABLE_SESSIONS_KEY)
    if (members.includes(sessionHash)) {
      pass(`稳定账户反向索引包含会话 ${sessionHash.slice(-8)}...`)
    } else {
      fail(`反向索引中未找到会话 ${sessionHash.slice(-8)}...`)
      allPassed = false
    }
  }

  // ─────────────────────────────────────────────────────────────────
  section('Test 3: _countActiveStableSessionSlots — 超过不活跃阈值时槽变为可用（但会话仍在索引中）')
  // ─────────────────────────────────────────────────────────────────
  {
    const sessionHash = `test_stable_h2_old_${Date.now()}`
    testSessionHashes.push(sessionHash)

    // 人为设置 lastActivity = 2 分钟前（超过 1 分钟阈值）
    const oldTime = Date.now() - 2 * 60 * 1000
    const ttlSeconds = 3600
    await client.setex(
      `${SESSION_PREFIX}${sessionHash}`,
      ttlSeconds,
      JSON.stringify({
        accountId: CC_CLUB_ID,
        accountType: 'claude-console',
        lastActivity: oldTime
      })
    )
    await client.sadd(STABLE_SESSIONS_KEY, sessionHash)

    // 现在稳定账户有 2 个会话：1 个活跃 + 1 个不活跃（但 Redis key 仍存在）
    // _countActiveStableSessionSlots 只计算活跃的，应该是 1（只有 Test 2 的那个）
    const count = await unifiedClaudeScheduler._countActiveStableSessionSlots(CC_CLUB_ID, 1)
    if (count === 1) {
      pass(`含 1 个不活跃会话时，活跃槽数量仍 = ${count}（不活跃会话不计入容量）`)
    } else {
      fail(`期望 1，实际 ${count}`)
      allPassed = false
    }

    // 懒惰清理只在 Redis key 不存在（TTL 过期）时触发，不活跃但 key 仍存在的会话保留在索引中
    // 这是正确行为：不活跃的会话可能随时重新激活
    const members = await client.smembers(STABLE_SESSIONS_KEY)
    if (members.includes(sessionHash)) {
      pass(`不活跃会话的 Redis key 仍存在，正确保留在反向索引中（未被懒惰清理）`)
    } else {
      fail(`不活跃会话不应被清理（其 Redis key 未过期），但已从索引中消失`)
      allPassed = false
    }

    // 验证懒惰清理：当 Redis key 不存在时才清理——模拟 TTL 过期场景
    const phantomHash = `test_stable_phantom_${Date.now()}`
    testSessionHashes.push(phantomHash)
    // 只添加到 Set，不创建对应的 Redis mapping key（模拟 TTL 已过期）
    await client.sadd(STABLE_SESSIONS_KEY, phantomHash)
    const countWithPhantom = await unifiedClaudeScheduler._countActiveStableSessionSlots(
      CC_CLUB_ID,
      1
    )
    const membersAfter = await client.smembers(STABLE_SESSIONS_KEY)
    if (!membersAfter.includes(phantomHash)) {
      pass(`Redis key 不存在的幽灵会话被懒惰清理从反向索引移除 (count=${countWithPhantom})`)
    } else {
      fail(`幽灵会话（无 Redis key）未被懒惰清理`)
      allPassed = false
    }
  }

  // ─────────────────────────────────────────────────────────────────
  section('Test 4: _removeFromStableAccountSessions — 移除指定会话，其他不受影响')
  // ─────────────────────────────────────────────────────────────────
  {
    // 添加第二个活跃会话
    const sessionH3 = `test_stable_h3_${Date.now()}`
    testSessionHashes.push(sessionH3)
    await unifiedClaudeScheduler._setSessionMapping(sessionH3, CC_CLUB_ID, 'claude-console')
    await unifiedClaudeScheduler._addToStableAccountSessions(CC_CLUB_ID, sessionH3)

    // 当前应有 2 个活跃会话（Test 2 的 h1 + 这里的 h3）
    const countBefore = await unifiedClaudeScheduler._countActiveStableSessionSlots(CC_CLUB_ID, 1)
    info(`移除前活跃槽数量 = ${countBefore}`)

    // 移除 h3
    await unifiedClaudeScheduler._removeFromStableAccountSessions(CC_CLUB_ID, sessionH3)

    const countAfter = await unifiedClaudeScheduler._countActiveStableSessionSlots(CC_CLUB_ID, 1)
    if (countAfter === countBefore - 1) {
      pass(`移除 h3 后活跃槽数量从 ${countBefore} 降至 ${countAfter}`)
    } else {
      fail(`期望 ${countBefore - 1}，实际 ${countAfter}`)
      allPassed = false
    }

    // 验证 Set 键在最后一个会话移除后被删除（SCARD=0 时 DEL）
    // First remove the remaining session
    const members = await client.smembers(STABLE_SESSIONS_KEY)
    info(`当前反向索引成员: [${members.map((h) => h.slice(-8)).join(', ')}]`)
    for (const h of members) {
      await unifiedClaudeScheduler._removeFromStableAccountSessions(CC_CLUB_ID, h)
    }
    const keyExists = await client.exists(STABLE_SESSIONS_KEY)
    if (keyExists === 0) {
      pass(`所有会话移除后，stable_account_sessions 键已被自动删除`)
    } else {
      fail(`键仍然存在（期望已被删除）`)
      allPassed = false
    }
  }

  // ─────────────────────────────────────────────────────────────────
  section('Test 5: _updateSessionActivity — 刷新 lastActivity 时间戳')
  // ─────────────────────────────────────────────────────────────────
  {
    const sessionHash = `test_stable_h5_${Date.now()}`
    testSessionHashes.push(sessionHash)

    // 创建一个"旧"会话（lastActivity = 2 分钟前）
    const oldTime = Date.now() - 2 * 60 * 1000
    const ttlSeconds = 3600
    await client.setex(
      `${SESSION_PREFIX}${sessionHash}`,
      ttlSeconds,
      JSON.stringify({
        accountId: CC_CLUB_ID,
        accountType: 'claude-console',
        lastActivity: oldTime
      })
    )
    await client.sadd(STABLE_SESSIONS_KEY, sessionHash)

    // 验证初始状态：该会话不活跃（超过 1 分钟阈值）
    const countBefore = await unifiedClaudeScheduler._countActiveStableSessionSlots(CC_CLUB_ID, 1)
    info(`更新前（旧会话）活跃槽数量 = ${countBefore}`)

    // 调用 _updateSessionActivity 刷新
    const mapping = await unifiedClaudeScheduler._getSessionMapping(sessionHash)
    if (mapping) {
      await unifiedClaudeScheduler._updateSessionActivity(sessionHash, mapping)
      const countAfter = await unifiedClaudeScheduler._countActiveStableSessionSlots(CC_CLUB_ID, 1)
      if (countAfter > countBefore) {
        pass(
          `_updateSessionActivity 刷新后活跃槽数量从 ${countBefore} 升至 ${countAfter}（会话重新激活）`
        )
      } else {
        fail(`期望活跃数增加，实际 before=${countBefore} after=${countAfter}`)
        allPassed = false
      }
    } else {
      fail('无法读取会话映射进行更新测试')
      allPassed = false
    }

    // 清理
    await client.del(STABLE_SESSIONS_KEY)
  }

  // ─────────────────────────────────────────────────────────────────
  section('Test 6: _getAllAvailableAccounts — 稳定账户出现在候选列表中（槽未满）')
  // ─────────────────────────────────────────────────────────────────
  {
    // 确保无活跃会话
    await client.del(STABLE_SESSIONS_KEY)

    const accounts = await unifiedClaudeScheduler._getAllAvailableAccounts(
      'claude-sonnet-4-5-20250929',
      null
    )

    const ccClub = accounts.find((a) => a.accountId === CC_CLUB_ID)
    if (ccClub) {
      pass(`稳定账户 cc-club (${CC_CLUB_ID.slice(0, 8)}...) 出现在候选列表中（槽未满时可调度）`)
    } else {
      fail(`稳定账户 cc-club 未出现在候选列表中`)
      allPassed = false
      // 输出候选列表供调试
      info(`候选账号: ${accounts.map((a) => a.accountId.slice(0, 8)).join(', ')}`)
    }
  }

  // ─────────────────────────────────────────────────────────────────
  section('Test 7: _getAllAvailableAccounts — 槽已满时稳定账户被排除')
  // ─────────────────────────────────────────────────────────────────
  {
    // 填满唯一的 1 个槽
    const sessionFull = `test_stable_full_${Date.now()}`
    testSessionHashes.push(sessionFull)
    await unifiedClaudeScheduler._setSessionMapping(sessionFull, CC_CLUB_ID, 'claude-console')
    await unifiedClaudeScheduler._addToStableAccountSessions(CC_CLUB_ID, sessionFull)

    const accounts = await unifiedClaudeScheduler._getAllAvailableAccounts(
      'claude-sonnet-4-5-20250929',
      null
    )

    const ccClub = accounts.find((a) => a.accountId === CC_CLUB_ID)
    if (!ccClub) {
      pass(`稳定账户 cc-club 槽已满（1/1），被正确排除出候选列表`)
    } else {
      fail(`稳定账户 cc-club 槽已满但仍出现在候选列表中`)
      allPassed = false
    }

    // pin-cc-new 仍应可用（shared 账号不受影响）
    const pinCc = accounts.find((a) => a.accountId === PIN_CC_ID)
    if (pinCc) {
      pass(`共享账号 pin-cc-new 仍在候选列表中（不受稳定账户槽限制影响）`)
    } else {
      info(`共享账号 pin-cc-new 不在候选列表（可能因其他原因不可用，非测试失败）`)
    }
  }

  return allPassed
}

async function cleanup() {
  section('Cleanup: 还原账号设置并清理测试数据')
  const client = redis.getClientSafe()

  // 还原 cc-club 的 accountType
  await client.hset(STABLE_KEY, 'accountType', originalAccountType || 'shared')
  await client.hdel(STABLE_KEY, 'maxStableSessions')
  await client.hdel(STABLE_KEY, 'stableInactivityMinutes')
  pass(`cc-club accountType 已还原为 ${originalAccountType || 'shared'}`)

  // 清理测试会话映射
  const sessionKeys = testSessionHashes.map((h) => `${SESSION_PREFIX}${h}`)
  if (sessionKeys.length > 0) {
    await client.del(...sessionKeys)
  }
  await client.del(STABLE_SESSIONS_KEY)
  pass(`已清理 ${testSessionHashes.length} 个测试会话映射`)
}

async function main() {
  console.log(c.bold('\n🧪 稳定账户调度功能测试\n'))

  try {
    await redis.connect()
    info('Redis 已连接')

    await setup()
    const allPassed = await runTests()
    await cleanup()

    console.log()
    if (allPassed) {
      console.log(c.green(c.bold('🎉 所有测试通过！稳定账户调度功能工作正常。')))
    } else {
      console.log(c.red(c.bold('💥 部分测试失败，请检查上面的错误信息。')))
      process.exit(1)
    }
  } catch (err) {
    console.error(c.red(`\n❌ 测试执行出错: ${err.message}`))
    console.error(err.stack)

    // 尽力清理
    try {
      await cleanup()
    } catch (cleanupErr) {
      console.error(c.yellow(`清理时出错: ${cleanupErr.message}`))
    }

    process.exit(1)
  } finally {
    try {
      await redis.disconnect()
    } catch (_e) {
      /* ignore */
    }
    process.exit(0)
  }
}

main()
