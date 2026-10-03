import axios from 'axios'
import type { Claim } from '../types'

const client = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL || '/api', timeout: 5000 })

export async function loadClaimSnapshot(fallback: Claim[]): Promise<Claim[]> {
  if (!import.meta.env.VITE_API_BASE_URL) return fallback
  try { return (await client.get<Claim[]>('/claims')).data } catch { return fallback }
}

/** 发布阻断项：来源链不完整、结论未解决、来源已撤回等一律拦截 */
export function publishBlockers(claim: Claim): string[] {
  const blocking: string[] = []
  if (claim.status === '待核') blocking.push('旧数据缺少来源链，须先完成核查流程，不能直接发布')
  if (claim.facts.some((fact) => fact.conclusion === '证据不足' && fact.unresolved.length)) blocking.push('仍有证据不足且未解决疑点的事实')
  if (claim.facts.some((fact) => fact.sources.length + fact.counterSources.length === 0)) blocking.push('存在没有来源记录的事实')
  const records = claim.facts.flatMap((fact) => [...fact.sources, ...fact.counterSources])
  if (records.some((source) => !source.contentHash || !source.chainOfCustody)) blocking.push('存在缺少内容哈希或留档说明的来源，来源链不完整')
  if (records.some((source) => source.status === '已撤回')) blocking.push('存在已撤回来源，需先完成复核处理')
  if (claim.facts.flatMap((fact) => fact.sources).some((source) => source.kind === '待证信息')) blocking.push('待证信息尚未完成原始来源核验')
  return blocking
}

export async function preflightPublish(claim: Claim) {
  const blocking = publishBlockers(claim)
  return { allowed: blocking.length === 0, blocking }
}
