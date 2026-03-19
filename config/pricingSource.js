const repository =
  process.env.PRICE_MIRROR_REPO || process.env.GITHUB_REPOSITORY || 'xilu0/sub2api'
const branch = process.env.PRICE_MIRROR_BRANCH || 'cc'
const pricingFileName =
  process.env.PRICE_MIRROR_FILENAME ||
  'backend/resources/model-pricing/model_prices_and_context_window.json'
const hashFileName =
  process.env.PRICE_MIRROR_HASH_FILENAME ||
  'backend/resources/model-pricing/model_prices_and_context_window.sha256'

const baseUrl = process.env.PRICE_MIRROR_BASE_URL
  ? process.env.PRICE_MIRROR_BASE_URL.replace(/\/$/, '')
  : `https://raw.githubusercontent.com/${repository}/${branch}`

module.exports = {
  pricingFileName,
  hashFileName,
  pricingUrl:
    process.env.PRICE_MIRROR_JSON_URL || `${baseUrl}/${pricingFileName}`,
  hashUrl: process.env.PRICE_MIRROR_HASH_URL || `${baseUrl}/${hashFileName}`
}
