import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { seedAudit, seedBatches, seedClaims, seedJournal, seedRegistry, seedSnapshots, seedVersions } from '../data/seed'
import { applyBatch, audit, checksum, computeConflicts, deriveConclusion, migrateLegacy, nextId, now, publishBlockers, takeSnapshot } from '../services/batches'
import type { AuditEntry, ChangeBatch, Claim, ClaimAnnotation, ClaimFact, DomainSnapshot, FactConclusion, JournalEntry, PublishedSnapshot, SourceRecord, SourceVersionRecord, VersionRecord } from '../types'

const PERSIST_KEY = 'gsb68:fact-check-workbench'

export interface CommitResult {
  ok: boolean
  message: string
  conflict?: boolean
}

interface ClaimState {
  claims: Claim[]
  versions: VersionRecord[]
  audit: AuditEntry[]
  sourceRegistry: SourceVersionRecord[]
  batches: ChangeBatch[]
  journal: JournalEntry[]
  journalSeq: number
  snapshots: PublishedSnapshot[]
  /** 最后一个完整批次的基线快照，写入失败后从这里恢复 */
  baseline: DomainSnapshot
  /** 故障注入：开启后下一次批次提交在写入中段失败 */
  injectFailure: boolean
  keyword: string
  status: Claim['status'] | '全部'
  setKeyword: (value: string) => void
  setStatus: (value: Claim['status'] | '全部') => void
  addClaim: (input: { title: string; summary: string; reporter: string; priority: Claim['priority'] }) => Claim
  updateFact: (claimId: string, factId: string, patch: Partial<ClaimFact>) => void
  addFact: (claimId: string, text: string) => void
  addAnnotation: (claimId: string, factId: string, annotation: Omit<ClaimAnnotation, 'id' | 'createdAt' | 'resolved'>) => void
  resolveAnnotation: (claimId: string, factId: string, annotationId: string) => void
  addSource: (claimId: string, factId: string, source: Omit<SourceRecord, 'id' | 'capturedAt' | 'version' | 'sourceKey'>, counter: boolean) => void
  transitionClaim: (claimId: string, status: Claim['status'], note: string) => CommitResult
  /** 来源升版/撤回：登记注册表并级联，未发布结论失效、已发布冻结另开复核批次 */
  submitSourceChange: (kind: '来源升版' | '来源撤回', change: { sourceKey: string; title: string; newHash: string; note: string }, operator: string) => Promise<CommitResult>
  /** 提交批次：先到先生效；baseSeq 已推进的晚到批次转冲突待复核 */
  commitBatch: (batchId: string) => Promise<CommitResult>
  /** 冲突复核：保留当前值，或把冲突值作为新批次重新提交 */
  resolveBatch: (batchId: string, mode: '保留当前值' | '采用冲突值') => Promise<CommitResult>
  /** 来源变更后重算失效结论 */
  recomputeFact: (claimId: string, factId: string, operator: string) => void
  /** 写入失败后：截断不完整日志，从最后一个完整批次恢复，失败批次重置待重试 */
  recoverJournal: () => CommitResult
  setInjectFailure: (value: boolean) => void
  reset: () => void
}

const editable = (claim?: Claim): claim is Claim => !!claim && claim.status !== '已发布'

export const useClaimStore = create<ClaimState>()(persist((set, get) => ({
  claims: structuredClone(seedClaims),
  versions: structuredClone(seedVersions),
  audit: structuredClone(seedAudit),
  sourceRegistry: structuredClone(seedRegistry),
  batches: structuredClone(seedBatches),
  journal: structuredClone(seedJournal),
  journalSeq: 0,
  snapshots: structuredClone(seedSnapshots),
  baseline: { claims: structuredClone(seedClaims), sourceRegistry: structuredClone(seedRegistry), versions: structuredClone(seedVersions) },
  injectFailure: false,
  keyword: '',
  status: '全部',
  setKeyword: (keyword) => set({ keyword }),
  setStatus: (status) => set({ status }),
  addClaim: (input) => {
    const timestamp = now()
    const claim: Claim = { id: nextId('FC'), ...input, editor: '宋卓', status: '核查中', createdAt: timestamp, updatedAt: timestamp, version: 1, facts: [] }
    set((state) => ({ claims: [claim, ...state.claims], audit: [audit(claim.id, '建立核查主张', input.reporter, input.summary), ...state.audit] }))
    return claim
  },
  addFact: (claimId, text) => set((state) => {
    const claim = state.claims.find((item) => item.id === claimId)
    if (!editable(claim) || !text.trim()) return state
    claim.facts.push({ id: nextId('F'), text, conclusion: '证据不足', confidence: 30, unresolved: ['尚未关联来源'], sources: [], counterSources: [], annotations: [] })
    claim.version += 1
    claim.updatedAt = now()
    return { claims: [...state.claims], audit: [audit(claimId, '拆分可验证事实', claim.reporter, text), ...state.audit] }
  }),
  updateFact: (claimId, factId, patch) => set((state) => {
    const claim = state.claims.find((item) => item.id === claimId)
    const fact = claim?.facts.find((item) => item.id === factId)
    if (!editable(claim) || !fact) return state
    if (patch.conclusion && patch.conclusion !== '证据不足' && fact.unresolved.length) {
      patch.confidence = Math.min(patch.confidence ?? fact.confidence, 75)
    }
    Object.assign(fact, patch)
    claim.version += 1
    claim.updatedAt = now()
    return { claims: [...state.claims], audit: [audit(claimId, '更新事实结论', '当前用户', `${fact.text}：${fact.conclusion}`), ...state.audit] }
  }),
  addAnnotation: (claimId, factId, input) => set((state) => {
    const claim = state.claims.find((item) => item.id === claimId)
    const fact = claim?.facts.find((item) => item.id === factId)
    if (!editable(claim) || !fact) return state
    fact.annotations.unshift({ ...input, id: nextId('N'), createdAt: now(), resolved: false })
    return { claims: [...state.claims], audit: [audit(claimId, '添加批注', input.author, input.content), ...state.audit] }
  }),
  resolveAnnotation: (claimId, factId, annotationId) => set((state) => {
    const claim = state.claims.find((item) => item.id === claimId)
    const annotation = claim?.facts.find((item) => item.id === factId)?.annotations.find((item) => item.id === annotationId)
    if (!editable(claim) || !annotation) return state
    annotation.resolved = true
    return { claims: [...state.claims], audit: [audit(claimId, '解决批注', '当前用户', annotation.content), ...state.audit] }
  }),
  addSource: (claimId, factId, input, counter) => set((state) => {
    const claim = state.claims.find((item) => item.id === claimId)
    const fact = claim?.facts.find((item) => item.id === factId)
    if (!editable(claim) || !fact) return state
    const list = counter ? fact.counterSources : fact.sources
    const sameTitle = list.filter((item) => item.title === input.title).length
    const source: SourceRecord = { ...input, id: nextId(counter ? 'C' : 'S'), sourceKey: input.url, capturedAt: now(), version: sameTitle + 1 }
    list.unshift(source)
    if (!state.sourceRegistry.some((item) => item.sourceKey === source.sourceKey)) {
      state.sourceRegistry.push({ id: nextId('SV'), sourceKey: source.sourceKey, title: source.title, version: source.version, contentHash: source.contentHash, status: '有效', note: '关联证据时登记', createdAt: now() })
    }
    claim.version += 1
    claim.updatedAt = now()
    return { claims: [...state.claims], sourceRegistry: [...state.sourceRegistry], audit: [audit(claimId, counter ? '保留相反证据' : '关联来源', '当前用户', input.title), ...state.audit] }
  }),
  transitionClaim: (claimId, status, note) => {
    const state = get()
    const claim = state.claims.find((item) => item.id === claimId)
    if (!claim) return { ok: false, message: '主张不存在' }
    if (claim.status === '已发布') return { ok: false, message: '已发布版本已冻结，变更须通过复核批次' }
    if (status === '待编辑复核' && claim.facts.length === 0) return { ok: false, message: '至少需要一项可验证事实' }
    if (status === '已发布') {
      const blocking = publishBlockers(claim)
      if (blocking.length) return { ok: false, message: `发布被拦截：${blocking[0]}` }
    }
    const timestamp = now()
    claim.status = status
    claim.version += 1
    claim.updatedAt = timestamp
    const version: VersionRecord = { id: nextId('V'), claimId, version: claim.version, editor: claim.editor || '当前用户', summary: note, changedFactIds: [], removedEvidence: [], createdAt: timestamp }
    const entries = [audit(claimId, `状态流转：${status}`, '当前用户', note)]
    let snapshots = state.snapshots
    if (status === '已发布') {
      // 发布即冻结快照，之后的来源升版/撤回不回写该版本
      snapshots = [{ id: nextId('PS'), claimId, version: claim.version, frozenAt: timestamp, snapshot: structuredClone(claim) }, ...state.snapshots]
      entries.unshift(audit(claimId, '发布冻结', '当前用户', `V${claim.version} 已发布并冻结快照，后续来源变更另开复核批次`))
    }
    set((current) => ({ claims: [...current.claims], versions: [version, ...current.versions], snapshots, audit: [...entries, ...current.audit] }))
    return { ok: true, message: `已流转至${status}` }
  },
  submitSourceChange: async (kind, change, operator) => {
    const state = get()
    const active = state.sourceRegistry.filter((item) => item.sourceKey === change.sourceKey && item.status !== '已撤回').sort((a, b) => b.version - a.version)[0]
    if (!active) return { ok: false, message: '来源未登记或已撤回' }
    const batch: ChangeBatch = {
      id: nextId('B'),
      kind,
      baseSeq: state.journalSeq,
      seq: null,
      status: '待提交',
      payload: { sourceChange: { sourceKey: change.sourceKey, title: change.title, baseVersion: active.version, newHash: change.newHash, note: change.note } },
      conflicts: [],
      createdBy: operator,
      createdAt: now()
    }
    set((current) => ({ batches: [batch, ...current.batches] }))
    return get().commitBatch(batch.id)
  },
  commitBatch: async (batchId) => {
    // 提交前对齐其他窗口已落盘的日志序号，保证“同一批次先到先生效”
    await useClaimStore.persist.rehydrate()
    const state = get()
    const batch = state.batches.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在' }
    if (batch.status !== '待提交') return { ok: false, message: `批次当前为「${batch.status}」，不能重复提交` }
    if (batch.baseSeq !== state.journalSeq) {
      // 晚到：不覆盖先生效批次，保留冲突值等复核
      const conflicts = computeConflicts(batch, state)
      set((current) => ({
        batches: current.batches.map((item) => (item.id === batchId ? { ...item, status: '冲突待复核' as const, conflicts } : item)),
        audit: [audit('-', '批次冲突', batch.createdBy, `${batch.id} 晚于其他提交到达，已保留冲突值待复核（${conflicts.length} 项冲突）`), ...current.audit]
      }))
      return { ok: false, conflict: true, message: '已有其他窗口的批次先生效，本批次转为冲突待复核' }
    }
    const seq = state.journalSeq + 1
    if (state.injectFailure) {
      // 故障注入：写入中段失败，日志留下不完整尾部，等待恢复重试
      const broken: JournalEntry = { seq, batchId, kind: batch.kind, complete: false, checksum: '', createdAt: now() }
      set((current) => ({
        injectFailure: false,
        journal: [...current.journal, broken],
        batches: current.batches.map((item) => (item.id === batchId ? { ...item, status: '写入失败' as const } : item)),
        audit: [audit('-', '写入失败', '系统', `${batch.id} 写入中断，日志序号 #${seq} 未完整落盘，需从最后一个完整批次恢复重试`), ...current.audit]
      }))
      return { ok: false, message: `写入中断：批次 #${seq} 未完整落盘，请到批次中心恢复重试` }
    }
    const applied = applyBatch(state, batch)
    const entry: JournalEntry = {
      seq,
      batchId,
      kind: batch.kind,
      complete: true,
      checksum: checksum({ claims: applied.claims, sourceRegistry: applied.sourceRegistry }),
      createdAt: now(),
      snapshot: takeSnapshot(applied)
    }
    const extraBatches = applied.extraBatches.map((item) => ({ ...item, baseSeq: seq }))
    set((current) => ({
      claims: applied.claims,
      sourceRegistry: applied.sourceRegistry,
      versions: applied.versions,
      journalSeq: seq,
      journal: [...current.journal, entry],
      batches: [...current.batches.map((item) => (item.id === batchId ? { ...item, status: '已生效' as const, seq } : item)), ...extraBatches],
      audit: [...applied.auditEntries, audit('-', '批次生效', batch.createdBy, `${batch.id}（${batch.kind}）作为批次 #${seq} 生效，校验 ${entry.checksum}`), ...current.audit]
    }))
    return { ok: true, message: `批次 #${seq} 已生效${extraBatches.length ? '，已为已发布主张另开复核批次' : ''}` }
  },
  resolveBatch: async (batchId, mode) => {
    const state = get()
    const batch = state.batches.find((item) => item.id === batchId)
    if (!batch || batch.status !== '冲突待复核') return { ok: false, message: '批次不在冲突待复核状态' }
    if (mode === '保留当前值') {
      set((current) => ({
        batches: current.batches.map((item) => (item.id === batchId ? { ...item, status: '已解决' as const } : item)),
        audit: [audit('-', '冲突解决', '当前用户', `${batch.id} 保留当前值，冲突值留档不再提交`), ...current.audit]
      }))
      return { ok: true, message: '已保留当前值，冲突值留档' }
    }
    // 采用冲突值：以当前日志序号为基线另开新批次提交，不覆盖历史
    const retry: ChangeBatch = { ...structuredClone(batch), id: nextId('B'), baseSeq: state.journalSeq, seq: null, status: '待提交', conflicts: [], createdAt: now() }
    set((current) => ({
      batches: [retry, ...current.batches.map((item) => (item.id === batchId ? { ...item, status: '已解决' as const } : item))],
      audit: [audit('-', '冲突解决', '当前用户', `${batch.id} 采用冲突值，另开 ${retry.id} 基于当前状态重新提交`), ...current.audit]
    }))
    return get().commitBatch(retry.id)
  },
  recomputeFact: (claimId, factId, operator) => set((state) => {
    const claim = state.claims.find((item) => item.id === claimId)
    const fact = claim?.facts.find((item) => item.id === factId)
    if (!editable(claim) || !fact || !fact.invalidatedBy) return state
    // 留档记录同步到注册表最新有效版本；被撤回来源保留记录但标记失效
    for (const source of [...fact.sources, ...fact.counterSources]) {
      const active = state.sourceRegistry.filter((item) => item.sourceKey === source.sourceKey && item.status === '有效').sort((a, b) => b.version - a.version)[0]
      const retracted = state.sourceRegistry.some((item) => item.sourceKey === source.sourceKey && item.status === '已撤回') && !active
      if (retracted) source.retracted = true
      else if (active && active.version > source.version) {
        source.supersededBy = `V${active.version}`
        source.version = active.version
        source.contentHash = active.contentHash
      }
    }
    const derived = deriveConclusion(fact)
    fact.conclusion = derived.conclusion
    fact.confidence = derived.confidence
    fact.unresolved = derived.unresolved
    const reason = fact.invalidatedBy.reason
    delete fact.invalidatedBy
    claim.version += 1
    claim.updatedAt = now()
    const version: VersionRecord = { id: nextId('V'), claimId, version: claim.version, editor: operator, summary: `来源变更后重算结论：${reason}`, changedFactIds: [factId], removedEvidence: [], createdAt: claim.updatedAt }
    return {
      claims: [...state.claims],
      versions: [version, ...state.versions],
      audit: [audit(claimId, '结论重算', operator, `${factId} 重算为「${fact.conclusion}」（置信度 ${fact.confidence}%）：${reason}`), ...state.audit]
    }
  }),
  recoverJournal: () => {
    const state = get()
    const lastComplete = [...state.journal].filter((entry) => entry.complete).sort((a, b) => b.seq - a.seq)[0]
    const snapshot = lastComplete?.snapshot ?? state.baseline
    const recoveredSeq = lastComplete?.seq ?? 0
    const resetBatches = state.batches.filter((item) => item.status === '写入失败' || (item.seq !== null && item.seq > recoveredSeq)).length
    set({
      claims: structuredClone(snapshot.claims),
      sourceRegistry: structuredClone(snapshot.sourceRegistry),
      versions: structuredClone(snapshot.versions),
      journalSeq: recoveredSeq,
      journal: state.journal.filter((entry) => entry.complete && entry.seq <= recoveredSeq),
      batches: state.batches.map((item) => (item.status === '写入失败' || (item.seq !== null && item.seq > recoveredSeq) ? { ...item, status: '待提交' as const, seq: null } : item)),
      audit: [audit('-', '故障恢复', '系统', `从最后一个完整批次 #${recoveredSeq} 恢复，${resetBatches} 个批次重置为待提交可重试`), ...state.audit]
    })
    return { ok: true, message: `已恢复到最后一个完整批次 #${recoveredSeq}，${resetBatches} 个批次可重试` }
  },
  setInjectFailure: (injectFailure) => set({ injectFailure }),
  reset: () => set({
    claims: structuredClone(seedClaims),
    versions: structuredClone(seedVersions),
    audit: structuredClone(seedAudit),
    sourceRegistry: structuredClone(seedRegistry),
    batches: structuredClone(seedBatches),
    journal: structuredClone(seedJournal),
    journalSeq: 0,
    snapshots: structuredClone(seedSnapshots),
    baseline: { claims: structuredClone(seedClaims), sourceRegistry: structuredClone(seedRegistry), versions: structuredClone(seedVersions) },
    injectFailure: false,
    keyword: '',
    status: '全部'
  })
}), {
  name: PERSIST_KEY,
  version: 2,
  migrate: (persisted, version) => {
    // 旧数据升级：没有来源链的主张先进入待核，不能直接发布
    const state = persisted as Partial<ClaimState>
    if (version < 2) {
      const migrated = migrateLegacy({ claims: (state.claims as Claim[]) ?? structuredClone(seedClaims) })
      return {
        ...state,
        claims: migrated.claims,
        sourceRegistry: migrated.sourceRegistry,
        audit: [...migrated.auditEntries, ...((state.audit as AuditEntry[]) ?? [])],
        batches: [],
        journal: [],
        journalSeq: 0,
        snapshots: [],
        baseline: { claims: structuredClone(migrated.claims), sourceRegistry: structuredClone(migrated.sourceRegistry), versions: structuredClone((state.versions as VersionRecord[]) ?? []) },
        injectFailure: false
      }
    }
    return state
  }
}))

// 多窗口联动：其他窗口提交批次后，本窗口重新水合，晚到提交自然转为冲突
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === PERSIST_KEY) void useClaimStore.persist.rehydrate()
  })
}

export const conclusionColor: Record<FactConclusion, string> = {
  已证实: 'green',
  部分属实: 'yellow',
  证据不足: 'orange',
  不实: 'red'
}

export const statusColor: Record<Claim['status'], string> = {
  待核: 'purple',
  核查中: 'orange',
  待编辑复核: 'orange',
  已发布: 'green',
  已撤回: 'red'
}
