import axios from 'axios'
import type { Claim } from '../types'
import { publishBlockers } from './batches'

const client = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL || '/api', timeout: 5000 })

export async function loadClaimSnapshot(fallback: Claim[]): Promise<Claim[]> {
  if (!import.meta.env.VITE_API_BASE_URL) return fallback
  try { return (await client.get<Claim[]>('/claims')).data } catch { return fallback }
}

/** 发布前校验：与 store 的发布闸门共用同一套规则 */
export function preflightPublish(claim: Claim) {
  const blocking = publishBlockers(claim)
  return { allowed: blocking.length === 0, blocking }
}
