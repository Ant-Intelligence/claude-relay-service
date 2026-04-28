const express = require('express')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')
const serviceRatesService = require('../../services/serviceRatesService')

const router = express.Router()

// GET /admin/service-rates — full config (admin payload, includes updatedBy)
router.get('/service-rates', authenticateAdmin, async (req, res) => {
  try {
    const config = await serviceRatesService.getRates()
    return res.json({ success: true, data: config })
  } catch (error) {
    logger.error('Failed to load service rates:', error)
    return res.status(500).json({ error: 'Failed to load service rates', message: error.message })
  }
})

// PUT /admin/service-rates — replace global rates
router.put('/service-rates', authenticateAdmin, async (req, res) => {
  try {
    const { rates, baseService } = req.body || {}
    if (!rates || typeof rates !== 'object') {
      return res
        .status(400)
        .json({ error: 'Invalid payload', message: '`rates` must be an object' })
    }
    const adminUsername = req.admin?.username || req.user?.username || 'admin'
    const saved = await serviceRatesService.saveRates({ rates, baseService, adminUsername })
    logger.info(`✅ Service rates updated by ${adminUsername}`)
    return res.json({ success: true, data: saved })
  } catch (error) {
    logger.error('Failed to save service rates:', error)
    return res.status(400).json({ error: 'Failed to save service rates', message: error.message })
  }
})

// GET /admin/service-rates/services — list of supported services with current rates
router.get('/service-rates/services', authenticateAdmin, async (req, res) => {
  try {
    const config = await serviceRatesService.getRates()
    const list = serviceRatesService.getServiceList(config)
    return res.json({ success: true, data: list })
  } catch (error) {
    logger.error('Failed to load service list:', error)
    return res.status(500).json({ error: 'Failed to load service list', message: error.message })
  }
})

module.exports = router
