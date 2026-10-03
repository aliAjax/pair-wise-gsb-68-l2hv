import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { StateStorage } from 'zustand/middleware'
import { seedAudit, seedClaims, seedVersions } from '../data/seed'
import { publishBlockers } from '../services/api'
import type { AuditEntry, BatchCommit, Claim, ClaimAnnotation, ClaimFact, FactMutation, ReviewBatch, SourceRecord, VersionRecord } from '../types'

interface ClaimState {
  claims: Claim[]
  versions: VersionRecord[]
  audit: AuditEntry[]
  batches: BatchCommit[]
  reviewBatches: ReviewBatch[]
  batchSeq: number
  failNextCommit: boolean
  keyword: string
  status: Claim['status'] | '全部'
  setKeyword: (value: string) => void
  setStatus: (value: Claim['status'] | '全部') => void
  addClaim: (input: { title: string; summary: string; reporter: string; priority: Claim['priority'] }) => Claim
  addFact: (claimId: string, text: string) => void
  addAnnotation: (claimId: string, factId: string, annotation: Omit<ClaimAnnotation, 'id' | 'createdAt' | 'resolved'>) => void
  resolveAnnotation: (claimId: string, factId: string, annotationId: string) => void
  addSource: (claimId: string, factId: string, source: Omit<SourceRecord, 'id' | 'capturedAt' | 'version' | 'status'>, counter: boolean) => void
  submitBatch: (input: { claimId: string; baseVersion: number; note: string; mutations: FactMutation[]; windowId: string }) => { ok: boolean; conflict?: boolean; failed?: boolean; message: string }
  retryFailedBatch: (batchId: string) => { ok: boolean; conflict?: boolean; message: string }
  resolveConflictBatch: (batchId: string, decision: '采纳' | '放弃') => void
  upgradeSource: (claimId: string, factId: string, sourceId: string, input: { contentHash: string; chainOfCustody: string; note: string }) => { ok: boolean; message: string }
  retractSource: (claimId: string, factId: string, sourceId: string, reason: string) => { ok: boolean; message: string }
  resolveReviewBatch: (batchId: string, resolution: '维持发布' | '退回重核' | '撤回主张') => void
  transitionClaim: (claimId: string, status: Claim['status'], note: string) => { ok: boolean; message: string }
  armWriteFailureDrill: () => void
  reset: () => void
}

let idSeed = 100
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${idSeed++}`
const now = () => new Date().toISOString()

/** 当前窗口标识：区分同一批次的并发提交方 */
export const windowId = (() => {
  const cached = sessionStorage.getItem('gsb68:window')
  if (cached) return cached
  const id = `W-${Math.random().toString(36).slice(2, 6)}`
  sessionStorage.setItem('gsb68:window', id)
  return id
})()

const STORAGE_NAME = 'gsb68:fact-check-workbench'
const BACKUP_KEY = `${STORAGE_NAME}:last-complete`

/**
 * 带批次日志的存储：每次写入先留旧值，新值校验完整后落档为"最后一个完整批次"；
 * 写入失败回滚到旧值，读取到损坏数据时从最后一个完整批次恢复。
 */
const journaledStorage: StateStorage = {
  getItem: (name) => {
    const raw = localStorage.getItem(name)
    if (!raw) return null
    try {
      JSON.parse(raw)
      return raw
    } catch {
      return localStorage.getItem(BACKUP_KEY)
    }
  },
  setItem: (name, value) => {
    const previous = localStorage.getItem(name)
    try {
      localStorage.setItem(name, value)
      JSON.parse(value)
      localStorage.setItem(BACKUP_KEY, value)
    } catch (error) {
      if (previous !== null) {
        try { localStorage.setItem(name, previous) } catch { /* 存储不可用，等待下次加载恢复 */ }
      } else {
        localStorage.removeItem(name)
      }
      throw error
    }
  },
  removeItem: (name) => { localStorage.removeItem(name); localStorage.removeItem(BACKUP_KEY) }
}

function audit(claimId: string, action: string, operator: string, detail: string): AuditEntry {
  return { id: nextId('AUD'), claimId, action, operator, detail, createdAt: now() }
}

/** 结论失效重算：回到证据不足，按剩余有效来源重算置信度并登记疑点 */
function invalidateFact(fact: ClaimFact, sourceTitle: string, trigger: string): ClaimFact {
  const support = fact.sources.filter((item) => item.status === '有效').reduce((score, item) => score + (item.kind === '原始证据' ? 25 : item.kind === '二次来源' ? 15 : 5), 0)
  const counter = fact.counterSources.filter((item) => item.status === '有效').length * 10
  const marker = `来源${trigger}：${sourceTitle}，需重新核验`
  return {
    ...fact,
    conclusion: '证据不足',
    confidence: Math.max(5, Math.min(60, support - counter || 10)),
    unresolved: fact.unresolved.includes(marker) ? fact.unresolved : [...fact.unresolved, marker]
  }
}

/** 应用一批事实修改，返回新主张数组与变更事实编号 */
function applyMutations(claims: Claim[], claimId: string, mutations: FactMutation[]): { claims: Claim[]; changedFactIds: string[] } {
  const changedFactIds: string[] = []
  const next = claims.map((claim) => {
    if (claim.id !== claimId) return claim
    const facts = claim.facts.map((fact) => {
      const mutation = mutations.find((item) => item.factId === fact.id)
      if (!mutation) return fact
      changedFactIds.push(fact.id)
      const patch = { ...mutation.patch }
      if (patch.conclusion && patch.conclusion !== '证据不足' && (patch.unresolved ?? fact.unresolved).length) {
        patch.confidence = Math.min(patch.confidence ?? fact.confidence, 75)
      }
      return { ...fact, ...patch }
    })
    return { ...claim, facts, version: claim.version + 1, updatedAt: now() }
  })
  return { claims: next, changedFactIds }
}

/** 收集引用了同一来源（按公开地址识别）的事实 */
function affectedFacts(claim: Claim, sourceUrl: string): ClaimFact[] {
  return claim.facts.filter((fact) => [...fact.sources, ...fact.counterSources].some((record) => record.url === sourceUrl))
}

export const useClaimStore = create<ClaimState>()(persist((set, get) => ({
  claims: seedClaims,
  versions: seedVersions,
  audit: seedAudit,
  batches: [],
  reviewBatches: [],
  batchSeq: 0,
  failNextCommit: false,
  keyword: '',
  status: '全部',
  setKeyword: (keyword) => set({ keyword }),
  setStatus: (status) => set({ status }),
  addClaim: (input) => {
    const created = now()
    const claim: Claim = { id: nextId('FC'), ...input, editor: '宋卓', status: '核查中', createdAt: created, updatedAt: created, version: 1, facts: [] }
    set((state) => ({ claims: [claim, ...state.claims], audit: [audit(claim.id, '建立核查主张', input.reporter, input.summary), ...state.audit] }))
    return claim
  },
  addFact: (claimId, text) => set((state) => {
    const claim = state.claims.find((item) => item.id === claimId)
    if (!claim || !text.trim() || claim.status === '已发布' || claim.status === '已撤回') return state
    claim.facts.push({ id: nextId('F'), text, conclusion: '证据不足', confidence: 30, unresolved: ['尚未关联来源'], sources: [], counterSources: [], annotations: [] })
    claim.version += 1
    claim.updatedAt = now()
    return { claims: [...state.claims], audit: [audit(claimId, '拆分可验证事实', claim.reporter, text), ...state.audit] }
  }),
  addAnnotation: (claimId, factId, input) => set((state) => {
    const claim = state.claims.find((item) => item.id === claimId)
    const fact = claim?.facts.find((item) => item.id === factId)
    if (!claim || !fact) return state
    fact.annotations.unshift({ ...input, id: nextId('N'), createdAt: now(), resolved: false })
    return { claims: [...state.claims], audit: [audit(claimId, '添加批注', input.author, input.content), ...state.audit] }
  }),
  resolveAnnotation: (claimId, factId, annotationId) => set((state) => {
    const claim = state.claims.find((item) => item.id === claimId)
    const annotation = claim?.facts.find((item) => item.id === factId)?.annotations.find((item) => item.id === annotationId)
    if (!claim || !annotation) return state
    annotation.resolved = true
    return { claims: [...state.claims], audit: [audit(claimId, '解决批注', '当前用户', annotation.content), ...state.audit] }
  }),
  addSource: (claimId, factId, input, counter) => set((state) => {
    const claim = state.claims.find((item) => item.id === claimId)
    const fact = claim?.facts.find((item) => item.id === factId)
    if (!claim || !fact || claim.status === '已发布' || claim.status === '已撤回') return state
    const list = counter ? fact.counterSources : fact.sources
    const sameTitle = list.filter((item) => item.title === input.title).length
    const source: SourceRecord = { ...input, id: nextId(counter ? 'C' : 'S'), capturedAt: now(), version: sameTitle + 1, status: '有效' }
    list.unshift(source)
    claim.version += 1
    claim.updatedAt = now()
    return { claims: [...state.claims], audit: [audit(claimId, counter ? '保留相反证据' : '关联来源', '当前用户', input.title), ...state.audit] }
  }),
  submitBatch: (input) => {
    const state = get()
    const claim = state.claims.find((item) => item.id === input.claimId)
    if (!claim) return { ok: false, message: '主张不存在' }
    if (claim.status === '已发布' || claim.status === '已撤回') return { ok: false, message: '该版本已冻结，请通过复核批次处理' }
    if (!input.mutations.length) return { ok: false, message: '批次为空，没有需要提交的修改' }
    const seq = state.batchSeq + 1
    const batch: BatchCommit = { id: nextId('B'), seq, claimId: input.claimId, windowId: input.windowId, baseVersion: input.baseVersion, note: input.note, mutations: input.mutations, status: '已生效', createdAt: now() }
    if (claim.version !== input.baseVersion) {
      // 晚到的提交：先到批次已生效，保留冲突值等复核
      set({
        batches: [{ ...batch, status: '冲突待复核' }, ...state.batches],
        batchSeq: seq,
        audit: [audit(input.claimId, '批次冲突', input.windowId, `基于V${input.baseVersion}提交，当前已到V${claim.version}，冲突值保留待复核`), ...state.audit]
      })
      return { ok: false, conflict: true, message: '该主张已被先到的提交更新，您的修改已保留为冲突值待复核' }
    }
    const before = structuredClone({ claims: state.claims, versions: state.versions, audit: state.audit, batches: state.batches })
    try {
      if (state.failNextCommit) throw new Error('演练：模拟写入失败')
      const { claims, changedFactIds } = applyMutations(state.claims, input.claimId, input.mutations)
      const version: VersionRecord = { id: nextId('V'), claimId: input.claimId, version: claim.version + 1, editor: '当前用户', summary: input.note || `批次${batch.id}提交`, changedFactIds, removedEvidence: [], createdAt: now(), kind: '编辑' }
      set({
        claims,
        versions: [version, ...state.versions],
        audit: [audit(input.claimId, '批次提交', input.windowId, `${input.mutations.length}项事实更新，V${claim.version}→V${claim.version + 1}`), ...state.audit],
        batches: [batch, ...state.batches],
        batchSeq: seq,
        failNextCommit: false
      })
      return { ok: true, message: `批次${batch.id}已生效，进入V${claim.version + 1}` }
    } catch {
      // 写入失败：从最后一个完整批次恢复，批次保留为可重试
      try {
        set({ ...before, batches: [{ ...batch, status: '写入失败' }, ...before.batches], batchSeq: seq, failNextCommit: false })
      } catch { /* 存储不可用，下次加载时从最后一个完整批次恢复 */ }
      return { ok: false, failed: true, message: '写入失败，已从最后一个完整批次恢复，可在复核队列重试' }
    }
  },
  retryFailedBatch: (batchId) => {
    const state = get()
    const batch = state.batches.find((item) => item.id === batchId && item.status === '写入失败')
    if (!batch) return { ok: false, message: '失败批次不存在或已处理' }
    const claim = state.claims.find((item) => item.id === batch.claimId)
    if (!claim) return { ok: false, message: '主张不存在' }
    if (claim.version !== batch.baseVersion) {
      set({
        batches: state.batches.map((item) => item.id === batchId ? { ...item, status: '冲突待复核' as const } : item),
        audit: [audit(batch.claimId, '批次重试转冲突', batch.windowId, `恢复期间版本已到V${claim.version}，批次${batch.id}转为冲突待复核`), ...state.audit]
      })
      return { ok: false, conflict: true, message: '恢复期间版本已更新，批次转为冲突待复核' }
    }
    try {
      if (state.failNextCommit) throw new Error('演练：模拟写入失败')
      const { claims, changedFactIds } = applyMutations(state.claims, batch.claimId, batch.mutations)
      const version: VersionRecord = { id: nextId('V'), claimId: batch.claimId, version: claim.version + 1, editor: '当前用户', summary: `重试批次${batch.id}：${batch.note || '恢复写入'}`, changedFactIds, removedEvidence: [], createdAt: now(), kind: '编辑' }
      set({
        claims,
        versions: [version, ...state.versions],
        batches: state.batches.map((item) => item.id === batchId ? { ...item, status: '已生效' as const, resolvedAt: now() } : item),
        audit: [audit(batch.claimId, '失败批次重试成功', batch.windowId, `批次${batch.id}恢复写入，进入V${claim.version + 1}`), ...state.audit],
        failNextCommit: false
      })
      return { ok: true, message: `批次${batch.id}已恢复写入` }
    } catch {
      set({ failNextCommit: false })
      return { ok: false, message: '重试仍失败，批次保留待重试' }
    }
  },
  resolveConflictBatch: (batchId, decision) => set((state) => {
    const batch = state.batches.find((item) => item.id === batchId && item.status === '冲突待复核')
    if (!batch) return state
    if (decision === '放弃') {
      return {
        batches: state.batches.map((item) => item.id === batchId ? { ...item, status: '已放弃' as const, resolvedAt: now() } : item),
        audit: [audit(batch.claimId, '冲突批次放弃', '当前用户', `批次${batch.id}冲突值已放弃，保留当前生效值`), ...state.audit]
      }
    }
    const claim = state.claims.find((item) => item.id === batch.claimId)
    if (!claim || claim.status === '已发布' || claim.status === '已撤回') return state
    const { claims, changedFactIds } = applyMutations(state.claims, batch.claimId, batch.mutations)
    const version: VersionRecord = { id: nextId('V'), claimId: batch.claimId, version: claim.version + 1, editor: '当前用户', summary: `采纳冲突批次${batch.id}的保留值`, changedFactIds, removedEvidence: [], createdAt: now(), kind: '编辑' }
    return {
      claims,
      versions: [version, ...state.versions],
      batches: state.batches.map((item) => item.id === batchId ? { ...item, status: '已采纳' as const, resolvedAt: now() } : item),
      audit: [audit(batch.claimId, '冲突批次采纳', '当前用户', `批次${batch.id}冲突值经复核后生效，进入V${claim.version + 1}`), ...state.audit]
    }
  }),
  upgradeSource: (claimId, factId, sourceId, input) => {
    const state = get()
    const claim = state.claims.find((item) => item.id === claimId)
    const fact = claim?.facts.find((item) => item.id === factId)
    const source = fact && [...fact.sources, ...fact.counterSources].find((item) => item.id === sourceId)
    if (!claim || !fact || !source) return { ok: false, message: '来源不存在' }
    if (source.status !== '有效') return { ok: false, message: '仅有效来源可升版' }
    const created = now()
    const newSource: SourceRecord = { ...source, id: nextId('S'), version: source.version + 1, contentHash: input.contentHash || source.contentHash, chainOfCustody: input.chainOfCustody || source.chainOfCustody, capturedAt: created, status: '有效', supersededBy: undefined, retractReason: undefined }
    const newBatches: ReviewBatch[] = []
    const newVersions: VersionRecord[] = []
    const newAudit: AuditEntry[] = []
    let frozen = 0
    let recomputed = 0
    const claims = state.claims.map((item) => {
      const affected = affectedFacts(item, source.url)
      if (!affected.length) return item
      if (item.status === '已发布') {
        // 已发布版本冻结原样，另开复核批次
        frozen += 1
        newBatches.push({ id: nextId('RB'), claimId: item.id, factIds: affected.map((entry) => entry.id), trigger: '来源升版', sourceId, sourceTitle: source.title, sourceUrl: source.url, frozenVersion: item.version, pendingUpgrade: input, status: '待复核', createdAt: created })
        newVersions.push({ id: nextId('V'), claimId: item.id, version: item.version, editor: '系统', summary: `来源「${source.title}」升版，发布版本V${item.version}冻结留档`, changedFactIds: affected.map((entry) => entry.id), removedEvidence: [], createdAt: created, kind: '冻结', snapshot: structuredClone(item) })
        newAudit.push(audit(item.id, '发布版本冻结', '系统', `来源升版，V${item.version}冻结原样并开启复核批次`))
        return item
      }
      // 未发布：替换来源版本，结论失效重算
      recomputed += 1
      const isOwner = item.id === claimId
      const facts = item.facts.map((entry) => {
        if (!affected.some((target) => target.id === entry.id)) return entry
        const markStale = (list: SourceRecord[]) => list.map((record) => record.url === source.url && record.status === '有效' ? { ...record, status: '已升版' as const, supersededBy: newSource.id } : record)
        let next: ClaimFact = { ...entry, sources: markStale(entry.sources), counterSources: markStale(entry.counterSources) }
        if (isOwner) {
          const counter = entry.counterSources.some((record) => record.id === sourceId)
          next = counter ? { ...next, counterSources: [newSource, ...next.counterSources] } : { ...next, sources: [newSource, ...next.sources] }
        }
        return invalidateFact(next, source.title, '升版')
      })
      newVersions.push({ id: nextId('V'), claimId: item.id, version: item.version + 1, editor: '系统', summary: `来源「${source.title}」升版至V${newSource.version}，相关结论失效重算`, changedFactIds: affected.map((entry) => entry.id), removedEvidence: [], createdAt: created, kind: '失效重算' })
      newAudit.push(audit(item.id, '结论失效重算', '系统', `来源升版，${affected.length}项事实结论失效待重新核验`))
      return { ...item, facts, status: item.status === '待编辑复核' ? '核查中' as const : item.status, version: item.version + 1, updatedAt: created }
    })
    newAudit.push(audit(claimId, '来源升版', '当前用户', `「${source.title}」升版至V${newSource.version}${input.note ? `：${input.note}` : ''}`))
    set({ claims, reviewBatches: [...newBatches, ...state.reviewBatches], versions: [...newVersions, ...state.versions], audit: [...newAudit, ...state.audit] })
    return { ok: true, message: `已升版至V${newSource.version}：${recomputed}个未发布主张结论失效重算，${frozen}个已发布主张冻结并开启复核批次` }
  },
  retractSource: (claimId, factId, sourceId, reason) => {
    const state = get()
    const claim = state.claims.find((item) => item.id === claimId)
    const fact = claim?.facts.find((item) => item.id === factId)
    const source = fact && [...fact.sources, ...fact.counterSources].find((item) => item.id === sourceId)
    if (!claim || !fact || !source) return { ok: false, message: '来源不存在' }
    if (source.status !== '有效') return { ok: false, message: '仅有效来源可撤回' }
    if (!reason.trim()) return { ok: false, message: '请填写撤回原因' }
    const created = now()
    const newBatches: ReviewBatch[] = []
    const newVersions: VersionRecord[] = []
    const newAudit: AuditEntry[] = []
    let frozen = 0
    let recomputed = 0
    const claims = state.claims.map((item) => {
      const affected = affectedFacts(item, source.url)
      if (!affected.length) return item
      if (item.status === '已发布') {
        frozen += 1
        newBatches.push({ id: nextId('RB'), claimId: item.id, factIds: affected.map((entry) => entry.id), trigger: '来源撤回', sourceId, sourceTitle: source.title, sourceUrl: source.url, frozenVersion: item.version, retractReason: reason, status: '待复核', createdAt: created })
        newVersions.push({ id: nextId('V'), claimId: item.id, version: item.version, editor: '系统', summary: `来源「${source.title}」被撤回，发布版本V${item.version}冻结留档`, changedFactIds: affected.map((entry) => entry.id), removedEvidence: [], createdAt: created, kind: '冻结', snapshot: structuredClone(item) })
        newAudit.push(audit(item.id, '发布版本冻结', '系统', `来源撤回，V${item.version}冻结原样并开启复核批次`))
        return item
      }
      recomputed += 1
      const facts = item.facts.map((entry) => {
        if (!affected.some((target) => target.id === entry.id)) return entry
        const markRetracted = (list: SourceRecord[]) => list.map((record) => record.url === source.url && record.status === '有效' ? { ...record, status: '已撤回' as const, retractReason: reason } : record)
        return invalidateFact({ ...entry, sources: markRetracted(entry.sources), counterSources: markRetracted(entry.counterSources) }, source.title, '撤回')
      })
      newVersions.push({ id: nextId('V'), claimId: item.id, version: item.version + 1, editor: '系统', summary: `来源「${source.title}」被撤回，相关结论失效重算`, changedFactIds: affected.map((entry) => entry.id), removedEvidence: [], createdAt: created, kind: '失效重算' })
      newAudit.push(audit(item.id, '结论失效重算', '系统', `来源撤回，${affected.length}项事实结论失效待重新核验`))
      return { ...item, facts, status: item.status === '待编辑复核' ? '核查中' as const : item.status, version: item.version + 1, updatedAt: created }
    })
    newAudit.push(audit(claimId, '来源撤回', '当前用户', `「${source.title}」撤回：${reason}`))
    set({ claims, reviewBatches: [...newBatches, ...state.reviewBatches], versions: [...newVersions, ...state.versions], audit: [...newAudit, ...state.audit] })
    return { ok: true, message: `来源已撤回：${recomputed}个未发布主张结论失效重算，${frozen}个已发布主张冻结并开启复核批次` }
  },
  resolveReviewBatch: (batchId, resolution) => set((state) => {
    const batch = state.reviewBatches.find((item) => item.id === batchId && item.status === '待复核')
    const claim = batch && state.claims.find((item) => item.id === batch.claimId)
    if (!batch || !claim) return state
    const resolved = now()
    const close = { status: '已结案' as const, resolution, resolvedAt: resolved }
    if (resolution === '维持发布') {
      return {
        reviewBatches: state.reviewBatches.map((item) => item.id === batchId ? { ...item, ...close } : item),
        audit: [audit(claim.id, '复核批次结案', '当前用户', `来源${batch.trigger}经复核不影响V${batch.frozenVersion}结论，维持发布`), ...state.audit]
      }
    }
    if (resolution === '撤回主张') {
      const claims = state.claims.map((item) => item.id === claim.id ? { ...item, status: '已撤回' as const, version: item.version + 1, updatedAt: resolved } : item)
      const version: VersionRecord = { id: nextId('V'), claimId: claim.id, version: claim.version + 1, editor: '当前用户', summary: `复核批次${batch.id}结案：来源${batch.trigger}，主张撤回`, changedFactIds: batch.factIds, removedEvidence: [], createdAt: resolved, kind: '编辑' }
      return {
        claims,
        versions: [version, ...state.versions],
        reviewBatches: state.reviewBatches.map((item) => item.id === batchId ? { ...item, ...close } : item),
        audit: [audit(claim.id, '复核批次结案', '当前用户', `来源${batch.trigger}成立，主张已撤回`), ...state.audit]
      }
    }
    // 退回重核：解冻并应用挂起的来源变更，结论失效重算
    const claims = state.claims.map((item) => {
      if (item.id !== claim.id) return item
      const facts = item.facts.map((entry) => {
        if (!batch.factIds.includes(entry.id)) return entry
        let next: ClaimFact = entry
        if (batch.trigger === '来源升版' && batch.pendingUpgrade) {
          const old = [...entry.sources, ...entry.counterSources].find((record) => record.id === batch.sourceId)
          if (!old) return entry
          const renewed: SourceRecord = { ...old, id: nextId('S'), version: old.version + 1, contentHash: batch.pendingUpgrade.contentHash || old.contentHash, chainOfCustody: batch.pendingUpgrade.chainOfCustody || old.chainOfCustody, capturedAt: resolved, status: '有效', supersededBy: undefined, retractReason: undefined }
          const markStale = (list: SourceRecord[]) => list.map((record) => record.url === batch.sourceUrl && record.status === '有效' ? { ...record, status: '已升版' as const, supersededBy: renewed.id } : record)
          const stale = { ...entry, sources: markStale(entry.sources), counterSources: markStale(entry.counterSources) }
          const counter = entry.counterSources.some((record) => record.id === batch.sourceId)
          next = counter ? { ...stale, counterSources: [renewed, ...stale.counterSources] } : { ...stale, sources: [renewed, ...stale.sources] }
        } else {
          const markRetracted = (list: SourceRecord[]) => list.map((record) => record.url === batch.sourceUrl && record.status === '有效' ? { ...record, status: '已撤回' as const, retractReason: batch.retractReason } : record)
          next = { ...entry, sources: markRetracted(entry.sources), counterSources: markRetracted(entry.counterSources) }
        }
        return invalidateFact(next, batch.sourceTitle, batch.trigger.replace('来源', ''))
      })
      return { ...item, facts, status: '核查中' as const, version: item.version + 1, updatedAt: resolved }
    })
    const version: VersionRecord = { id: nextId('V'), claimId: claim.id, version: claim.version + 1, editor: '当前用户', summary: `复核批次${batch.id}结案：退回重核，来源${batch.trigger}已应用，结论失效重算`, changedFactIds: batch.factIds, removedEvidence: [], createdAt: resolved, kind: '失效重算' }
    return {
      claims,
      versions: [version, ...state.versions],
      reviewBatches: state.reviewBatches.map((item) => item.id === batchId ? { ...item, ...close } : item),
      audit: [audit(claim.id, '复核批次结案', '当前用户', `退回重核：来源${batch.trigger}已应用，相关结论失效重算`), ...state.audit]
    }
  }),
  transitionClaim: (claimId, status, note) => {
    const state = get()
    const claim = state.claims.find((item) => item.id === claimId)
    if (!claim) return { ok: false, message: '主张不存在' }
    if (status === '待编辑复核' && claim.facts.length === 0) return { ok: false, message: '至少需要一项可验证事实' }
    if (status === '已发布') {
      const blocking = publishBlockers(claim)
      if (blocking.length) return { ok: false, message: blocking[0] }
      if (!claim.editor) return { ok: false, message: '缺少编辑复核人' }
    }
    const updated = now()
    const next: Claim = { ...claim, status, version: claim.version + 1, updatedAt: updated }
    const version: VersionRecord = {
      id: nextId('V'), claimId, version: next.version, editor: claim.editor || '当前用户', summary: note, changedFactIds: [], removedEvidence: [], createdAt: updated,
      kind: status === '已发布' ? '发布' : '编辑',
      snapshot: status === '已发布' ? structuredClone(next) : undefined
    }
    set((current) => ({ claims: current.claims.map((item) => item.id === claimId ? next : item), versions: [version, ...current.versions], audit: [audit(claimId, `状态流转：${status}`, '当前用户', note), ...current.audit] }))
    return { ok: true, message: `已流转至${status}` }
  },
  armWriteFailureDrill: () => set({ failNextCommit: true }),
  reset: () => set({ claims: structuredClone(seedClaims), versions: structuredClone(seedVersions), audit: structuredClone(seedAudit), batches: [], reviewBatches: [], batchSeq: 0, failNextCommit: false, keyword: '', status: '全部' })
}), {
  name: STORAGE_NAME,
  version: 2,
  storage: createJSONStorage(() => journaledStorage),
  partialize: (state) => ({ claims: state.claims, versions: state.versions, audit: state.audit, batches: state.batches, reviewBatches: state.reviewBatches, batchSeq: state.batchSeq, keyword: state.keyword, status: state.status }),
  migrate: (persisted, version) => {
    // 旧数据升级：补齐来源状态；没有来源链的主张先进入待核，不能直接发布
    const state = (persisted ?? {}) as { claims?: Claim[]; versions?: VersionRecord[]; audit?: AuditEntry[]; batches?: BatchCommit[]; reviewBatches?: ReviewBatch[]; batchSeq?: number; keyword?: string; status?: ClaimState['status'] }
    const audit = state.audit ?? []
    let claims = state.claims ?? structuredClone(seedClaims)
    if (version < 2) {
      const migrationAudit: AuditEntry[] = []
      claims = claims.map((claim) => {
        const facts = claim.facts.map((fact) => ({
          ...fact,
          sources: fact.sources.map((source) => ({ ...source, status: source.status ?? ('有效' as const) })),
          counterSources: fact.counterSources.map((source) => ({ ...source, status: source.status ?? ('有效' as const) }))
        }))
        const chained = facts.length > 0 && facts.every((fact) => {
          const records = [...fact.sources, ...fact.counterSources]
          return records.length > 0 && records.every((source) => source.contentHash && source.chainOfCustody)
        })
        if (!chained && (claim.status === '已发布' || claim.status === '待编辑复核')) {
          migrationAudit.push({ id: nextId('AUD'), claimId: claim.id, action: '旧数据升级', operator: '系统', detail: '缺少来源链，转入待核，不能直接发布', createdAt: now() })
          return { ...claim, facts, status: '待核' as const }
        }
        return { ...claim, facts }
      })
      audit.unshift(...migrationAudit)
    }
    return {
      claims,
      versions: state.versions ?? structuredClone(seedVersions),
      audit,
      batches: state.batches ?? [],
      reviewBatches: state.reviewBatches ?? [],
      batchSeq: state.batchSeq ?? 0,
      keyword: state.keyword ?? '',
      status: state.status ?? '全部'
    }
  }
}))

export const conclusionColor: Record<ClaimFact['conclusion'], string> = {
  已证实: 'green',
  部分属实: 'yellow',
  证据不足: 'orange',
  不实: 'red'
}
