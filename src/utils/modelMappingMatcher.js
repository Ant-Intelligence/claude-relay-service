function findMatchingModelEntry(modelMapping, requestedModel) {
  if (!modelMapping || typeof modelMapping !== 'object' || Array.isArray(modelMapping)) {
    return null
  }

  if (!requestedModel || typeof requestedModel !== 'string') {
    return null
  }

  if (Object.prototype.hasOwnProperty.call(modelMapping, requestedModel)) {
    return {
      key: requestedModel,
      value: modelMapping[requestedModel],
      matchType: 'exact'
    }
  }

  const requestedModelLower = requestedModel.toLowerCase()

  for (const [key, value] of Object.entries(modelMapping)) {
    if (typeof key === 'string' && key.toLowerCase() === requestedModelLower) {
      return {
        key,
        value,
        matchType: 'exact'
      }
    }
  }

  let bestPrefixMatch = null

  for (const [key, value] of Object.entries(modelMapping)) {
    if (typeof key !== 'string' || !key.endsWith('*')) {
      continue
    }

    const prefix = key.slice(0, -1)
    if (!prefix) {
      continue
    }

    if (!requestedModelLower.startsWith(prefix.toLowerCase())) {
      continue
    }

    if (!bestPrefixMatch || prefix.length > bestPrefixMatch.prefix.length) {
      bestPrefixMatch = {
        key,
        value,
        prefix,
        matchType: 'prefix'
      }
    }
  }

  return bestPrefixMatch
}

function resolveMappedModel(modelMapping, requestedModel) {
  const match = findMatchingModelEntry(modelMapping, requestedModel)
  if (!match) {
    return requestedModel
  }

  // `gpt-* -> gpt-*` acts as a whitelist/pass-through rule for the matched prefix.
  if (match.matchType === 'prefix' && match.value === match.key) {
    return requestedModel
  }

  return match.value
}

module.exports = {
  findMatchingModelEntry,
  resolveMappedModel
}
