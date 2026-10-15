// One plain-text presentation shared by channel messages and the detail dialog.
export const DECISION_FIELDS = ['noticeType', 'participation', 'benefits', 'eventTime', 'deadlineText']

export function analysisFields(analysis) {
  const result = analysis?.state === 'ready' ? analysis.result : null
  return {
    analysisState: analysis?.state || 'pending',
    ...Object.fromEntries(DECISION_FIELDS.map(key => [key, typeof result?.[key] === 'string' ? result[key] : ''])),
    summary: result?.summary || '', audience: result?.audience || [],
    where: result?.location || '', notes: result?.notes || [],
  }
}

export function decisionCopy(item) {
  if (item.analysisState === 'waiting_body' && item.bodyStatus) return item.bodyStatus
  if (item.analysisState !== 'ready') {
    return ({
      waiting_body: '正文未抓到，暂时无法整理，请查看原网页。',
      unconfigured: '没有配置api-key，数据整理暂不可用',
      pending: '等待整理，可先查看原文。',
      processing: '正在整理，可先查看原文。',
      failed: '整理失败，可查看原文或稍后重新整理。',
      blocked: '此来源的整理未获授权，可查看原文或在 API 设置中调整。',
    })[item.analysisState] || '整理状态未知，请查看原文。'
  }
  if (!DECISION_FIELDS.every(key => typeof item[key] === 'string' && item[key].trim())) {
    return '旧版整理结果待更新，可先查看原文。'
  }
  const audience = item.audience?.length ? item.audience.join('；') : '原文未说明'
  return `【${item.noticeType}｜${item.participation}】\n面向：${audience}\n要点：${item.summary || '原文未说明'}\n时间：${item.eventTime}${item.where ? `；地点：${item.where}` : ''}\n截止：${item.deadlineText}\n收益：${item.benefits}`
}
