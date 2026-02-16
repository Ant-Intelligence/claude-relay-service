import { apiClient } from '@/config/api'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useApiKeysStore = defineStore('apiKeys', () => {
  // 状态
  const apiKeys = ref([])
  const loading = ref(false)
  const error = ref(null)
  const statsTimeRange = ref('all')
  const sortBy = ref('')
  const sortOrder = ref('asc')

  // 🚀 分页状态
  const pagination = ref({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0
  })

  // Actions

  // 获取API Keys列表（支持分页）
  const fetchApiKeys = async (options = {}) => {
    loading.value = true
    error.value = null
    try {
      const params = {
        page: options.page || pagination.value.page,
        pageSize: options.pageSize || pagination.value.pageSize,
        sortBy: options.sortBy || sortBy.value || 'createdAt',
        sortOrder: options.sortOrder || sortOrder.value || 'desc',
        searchMode: options.searchMode || 'apiKey',
        search: options.search || '',
        status: options.status || 'all',
        permissions: options.permissions || 'all',
        tag: options.tag || '',
        timeRange: options.timeRange || 'all'
      }

      // 添加可选的日期范围参数
      if (options.startDate) {
        params.startDate = options.startDate
      }
      if (options.endDate) {
        params.endDate = options.endDate
      }

      const response = await apiClient.get('/admin/api-keys', { params })

      if (response.success) {
        apiKeys.value = response.data || []
        // 更新分页信息
        if (response.pagination) {
          pagination.value = response.pagination
        }
      } else {
        throw new Error(response.message || '获取API Keys失败')
      }
    } catch (err) {
      error.value = err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  // 🚀 设置页码
  const setPage = async (page) => {
    pagination.value.page = page
    await fetchApiKeys()
  }

  // 🚀 设置每页条数
  const setPageSize = async (pageSize) => {
    pagination.value.pageSize = pageSize
    pagination.value.page = 1 // 重置到第一页
    await fetchApiKeys()
  }

  // 创建API Key
  const createApiKey = async (data) => {
    loading.value = true
    error.value = null
    try {
      const response = await apiClient.post('/admin/api-keys', data)
      if (response.success) {
        await fetchApiKeys()
        return response.data
      } else {
        throw new Error(response.message || '创建API Key失败')
      }
    } catch (err) {
      error.value = err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  // 更新API Key
  const updateApiKey = async (id, data) => {
    loading.value = true
    error.value = null
    try {
      const response = await apiClient.put(`/admin/api-keys/${id}`, data)
      if (response.success) {
        await fetchApiKeys()
        return response
      } else {
        throw new Error(response.message || '更新API Key失败')
      }
    } catch (err) {
      error.value = err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  // 切换API Key状态
  const toggleApiKey = async (id) => {
    loading.value = true
    error.value = null
    try {
      const response = await apiClient.put(`/admin/api-keys/${id}/toggle`)
      if (response.success) {
        await fetchApiKeys()
        return response
      } else {
        throw new Error(response.message || '切换状态失败')
      }
    } catch (err) {
      error.value = err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  // 续期API Key
  const renewApiKey = async (id, data) => {
    loading.value = true
    error.value = null
    try {
      const response = await apiClient.put(`/admin/api-keys/${id}`, data)
      if (response.success) {
        await fetchApiKeys()
        return response
      } else {
        throw new Error(response.message || '续期失败')
      }
    } catch (err) {
      error.value = err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  // 删除API Key
  const deleteApiKey = async (id) => {
    loading.value = true
    error.value = null
    try {
      const response = await apiClient.delete(`/admin/api-keys/${id}`)
      if (response.success) {
        await fetchApiKeys()
        return response
      } else {
        throw new Error(response.message || '删除失败')
      }
    } catch (err) {
      error.value = err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  // 获取API Key统计
  const fetchApiKeyStats = async (id, timeRange = 'all') => {
    try {
      const response = await apiClient.get(`/admin/api-keys/${id}/stats`, {
        params: { timeRange }
      })
      if (response.success) {
        return response.stats
      } else {
        throw new Error(response.message || '获取统计失败')
      }
    } catch (err) {
      // console.error('获取API Key统计失败:', err)
      return null
    }
  }

  // 排序API Keys
  const sortApiKeys = (field) => {
    if (sortBy.value === field) {
      sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortBy.value = field
      sortOrder.value = 'asc'
    }
  }

  // 获取已存在的标签
  const fetchTags = async () => {
    try {
      const response = await apiClient.get('/admin/api-keys/tags')
      if (response.success) {
        return response.data || []
      } else {
        throw new Error(response.message || '获取标签失败')
      }
    } catch (err) {
      // console.error('获取标签失败:', err)
      return []
    }
  }

  // 🚀 获取加油包使用记录
  const fetchBoosterPackRecords = async (keyId, startTime = null, endTime = null) => {
    const params = {}
    if (startTime) params.startTime = startTime
    if (endTime) params.endTime = endTime

    const response = await apiClient.get(`/admin/api-keys/${keyId}/booster-pack/records`, {
      params
    })
    if (response.success) {
      return response.records || []
    } else {
      throw new Error(response.message || '获取加油包使用记录失败')
    }
  }

  // 🚀 获取加油包使用统计
  const fetchBoosterPackStats = async (keyId, groupBy = 'day') => {
    const response = await apiClient.get(`/admin/api-keys/${keyId}/booster-pack/stats`, {
      params: { groupBy }
    })
    if (response.success) {
      return response.stats || null
    } else {
      throw new Error(response.message || '获取加油包统计失败')
    }
  }

  // 🚀 设置/充值加油包金额
  const setBoosterPackAmount = async (keyId, amount) => {
    loading.value = true
    error.value = null
    try {
      const response = await apiClient.put(`/admin/api-keys/${keyId}/booster-pack`, {
        amount: parseFloat(amount)
      })
      if (response.success) {
        await fetchApiKeys()
        return response
      } else {
        throw new Error(response.message || '设置加油包金额失败')
      }
    } catch (err) {
      error.value = err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  // 🚀 重置加油包使用记录
  const resetBoosterPackUsage = async (keyId) => {
    loading.value = true
    error.value = null
    try {
      const response = await apiClient.post(`/admin/api-keys/${keyId}/booster-pack/reset`)
      if (response.success) {
        await fetchApiKeys()
        return response
      } else {
        throw new Error(response.message || '重置加油包使用记录失败')
      }
    } catch (err) {
      error.value = err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  // 💰 重置周限制使用记录
  const resetWeeklyCost = async (keyId) => {
    loading.value = true
    error.value = null
    try {
      const response = await apiClient.post(`/admin/api-keys/${keyId}/weekly-cost/reset`)
      if (response.success) {
        await fetchApiKeys()
        return response
      } else {
        throw new Error(response.message || '重置周限制使用记录失败')
      }
    } catch (err) {
      error.value = err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  // 重置store
  const reset = () => {
    apiKeys.value = []
    loading.value = false
    error.value = null
    statsTimeRange.value = 'all'
    sortBy.value = ''
    sortOrder.value = 'asc'
  }

  return {
    // State
    apiKeys,
    loading,
    error,
    statsTimeRange,
    sortBy,
    sortOrder,
    pagination, // 🚀 新增分页状态

    // Actions
    fetchApiKeys,
    setPage, // 🚀 新增分页方法
    setPageSize, // 🚀 新增分页方法
    createApiKey,
    updateApiKey,
    toggleApiKey,
    renewApiKey,
    deleteApiKey,
    fetchApiKeyStats,
    fetchTags,
    sortApiKeys,
    // 🚀 Booster Pack Actions
    fetchBoosterPackRecords,
    fetchBoosterPackStats,
    setBoosterPackAmount,
    resetBoosterPackUsage,
    // 💰 Weekly Cost Actions
    resetWeeklyCost,
    reset
  }
})
