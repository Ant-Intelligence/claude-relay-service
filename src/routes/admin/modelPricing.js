const express = require('express')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')
const pricingService = require('../../services/pricingService')

const router = express.Router()

// GET /admin/models/pricing — full in-memory pricing catalog (pass-through)
router.get('/models/pricing', authenticateAdmin, async (req, res) => {
  try {
    if (!pricingService.pricingData || Object.keys(pricingService.pricingData).length === 0) {
      await pricingService.loadPricingData()
    }
    return res.json({ success: true, data: pricingService.pricingData || {} })
  } catch (error) {
    logger.error('Failed to load model pricing catalog:', error)
    return res.status(500).json({ error: 'Failed to load model pricing', message: error.message })
  }
})

// GET /admin/models/pricing/status — pricing service status (in-memory only, never throws)
router.get('/models/pricing/status', authenticateAdmin, async (req, res) => {
  try {
    return res.json({ success: true, data: pricingService.getStatus() })
  } catch (error) {
    logger.error('Failed to load pricing status:', error)
    return res.status(500).json({ error: 'Failed to load pricing status', message: error.message })
  }
})

// POST /admin/models/pricing/refresh — manually re-download upstream pricing JSON
router.post('/models/pricing/refresh', authenticateAdmin, async (req, res) => {
  const adminUsername = req.admin?.username || req.user?.username || 'admin'
  try {
    const result = await pricingService.forceUpdate()
    if (result?.success) {
      logger.info(`✅ Pricing data refreshed by ${adminUsername} — ${result.message}`)
    } else {
      logger.warn(
        `⚠️ Pricing refresh by ${adminUsername} fell back to bundled data — ${result?.message || 'unknown reason'}`
      )
    }
    return res.json({
      success: !!result?.success,
      message: result?.message || 'Pricing refresh completed'
    })
  } catch (error) {
    logger.error('❌ Pricing refresh failed:', error)
    return res.status(500).json({ error: 'Failed to refresh pricing', message: error.message })
  }
})

module.exports = router
