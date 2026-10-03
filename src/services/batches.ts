import type {
  AuditEntry,
  ChangeBatch,
  Claim,
  ClaimFact,
  ConflictRecord,
  DomainSnapshot,
  FactConclusion,
  JournalEntry,
  SourceVersionRecord,
  VersionRecord
} from '../types'

let idSeed = 200
export const nextId = (prefix: string) => `${prefix}-${Date.now()}-${idSeed++}`
export const now = () => new Date().toISOString()

export function audit(claimId: string, action: string, operator: string, detail: string): AuditEntry {
  return { id: nextId('AUD'), claimId, action, operator, detail, createdAt: now() }
}

/** 简易校验和：用于核对批次落盘完整性 */
export function checksum(value: unknown): string {
  const text = JSON.stringify(value)
  let hash = 5381
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  return `chk:${hash.toString(16)}`
}

export function takeSnapshot(state: { claims: Claim[]; sourceRegistry: SourceVersionRecord[]; versions: VersionRecord[] }): DomainSnapshot {
  return structuredClone({ claims: state.claims, sourceRegistry: state.sourceRegistry, versions: state.versions })
}

export function activeVersion(registry: SourceVersionRecord[], sourceKey: string): SourceVersionRecord | undefined {
  return registry.filter((item) => item.sourceKey === sourceKey && item.status === '有效').sort((a, b) => b.version - a.version)[0]
}

export function latestVersion(registry: SourceVersionRecord[], sourceKey: string): number {
  return registry.filter((item) => item.sourceKey === sourceKey).reduce((max, item) => Math.max(max, item.version), 0)
}

/** 事实是否具备来源链：至少一条带来源留痕的记录 */
export function hasSourceChain(fact: ClaimFact): boolean {
  const all = [...fact.sources, ...fact.counterSources]
  return all.length > 0 && all.some((source) => source.chainOfCustody.trim().length > 0)
}

/**
 * 来源变更后的结论重算规则（确定性、可解释）：
 * 仅统计未被撤回且已完成核验的来源；待证信息不计入有效支持。
 */
export function deriveConclusion(fact: ClaimFact): { conclusion: FactConclusion; confidence: number; unresolved: string[] } {
  const support = fact.sources.filter((source) => !source.retracted)
  const counter = fact.counterSources.filter((source) => !source.retracted)
  const verified = support.filter((source) => source.kind !== '待证信息')
  const unresolved = fact.unresolved.filter((item) => item !== '来源已变更，结论待重算')
  if (verified.length === 0 && counter.length === 0) {
    return { conclusion: '证据不足', confidence: Math.min(fact.confidence, 30), unresolved: [...unresolved, '有效来源不足，需补充原始证据'] }
  }
  if (verified.length === 0 && counter.length > 0) {
    return { conclusion: '不实', confidence: Math.min(90, 55 + counter.length * 15), unresolved }
  }
  if (counter.length >= verified.length && counter.length > 0) {
    return { conclusion: '部分属实', confidence: 55, unresolved: [...unresolved, '支持与相反证据相持，结论降级'] }
  }
  const confidence = Math.max(40, Math.min(95, 70 + verified.length * 10 - counter.length * 15))
  return { conclusion: '已证实', confidence, unresolved }
}

interface ApplyResult {
  claims: Claim[]
  sourceRegistry: SourceVersionRecord[]
  versions: VersionRecord[]
  extraBatches: ChangeBatch[]
  auditEntries: AuditEntry[]
}

/** 应用一个已获准生效的批次，返回新的领域状态（纯函数，不修改入参） */
export function applyBatch(
  state: { claims: Claim[]; sourceRegistry: SourceVersionRecord[]; versions: VersionRecord[] },
  batch: ChangeBatch
): ApplyResult {
  const claims = structuredClone(state.claims)
  const sourceRegistry = structuredClone(state.sourceRegistry)
  const versions = structuredClone(state.versions)
  const extraBatches: ChangeBatch[] = []
  const auditEntries: AuditEntry[] = []

  if (batch.kind === '来源升版' || batch.kind === '来源撤回') {
    const change = batch.payload.sourceChange!
    const retract = batch.kind === '来源撤回'
    const current = activeVersion(sourceRegistry, change.sourceKey)
    if (current) current.status = retract ? '已撤回' : '已升版'
    const record: SourceVersionRecord = {
      id: nextId('SV'),
      sourceKey: change.sourceKey,
      title: change.title,
      version: retract ? current?.version ?? change.baseVersion : change.baseVersion + 1,
      contentHash: change.newHash,
      status: retract ? '已撤回' : '有效',
      note: change.note,
      createdAt: now()
    }
    if (!retract) sourceRegistry.push(record)
    const actionLabel = retract ? '来源撤回' : '来源升版'
    auditEntries.push(audit('-', actionLabel, batch.createdBy, `「${change.title}」${retract ? `V${record.version} 已撤回` : `升版至 V${record.version}`}：${change.note}`))

    const reviewItems: { claimId: string; factId: string; claimVersion: number; reason: string }[] = []
    for (const claim of claims) {
      for (const fact of claim.facts) {
        const hit = [...fact.sources, ...fact.counterSources].some((source) => source.sourceKey === change.sourceKey)
        if (!hit) continue
        const reason = retract ? `来源「${change.title}」V${record.version} 已撤回` : `来源「${change.title}」已升版至 V${record.version}`
        if (claim.status === '已发布') {
          // 已发布版本冻结原样，另开复核批次处理
          reviewItems.push({ claimId: claim.id, factId: fact.id, claimVersion: claim.version, reason })
        } else {
          // 未发布结论立即失效，等待重算
          fact.invalidatedBy = { sourceKey: change.sourceKey, reason: `${reason}，结论失效待重算`, at: now() }
          if (retract) for (const source of [...fact.sources, ...fact.counterSources]) if (source.sourceKey === change.sourceKey) source.retracted = true
          claim.updatedAt = now()
          auditEntries.push(audit(claim.id, '结论失效', '系统', `${fact.id}：${reason}，未发布结论已失效待重算`))
        }
      }
    }
    if (reviewItems.length) {
      extraBatches.push({
        id: nextId('B'),
        kind: '复核批次',
        baseSeq: -1,
        seq: null,
        status: '待提交',
        payload: { reviewItems },
        conflicts: [],
        createdBy: '系统',
        createdAt: now()
      })
      auditEntries.push(audit('-', '开启复核批次', '系统', `${reviewItems.length} 项已发布事实受来源变更影响，另开复核批次，已发布版本保持冻结`))
    }
  }

  if (batch.kind === '复核批次') {
    for (const item of batch.payload.reviewItems ?? []) {
      const claim = claims.find((entry) => entry.id === item.claimId)
      const fact = claim?.facts.find((entry) => entry.id === item.factId)
      if (!claim || !fact) continue
      fact.invalidatedBy = { sourceKey: '', reason: `${item.reason}，复核批次要求重算`, at: now() }
      claim.status = '待编辑复核'
      claim.version += 1
      claim.updatedAt = now()
      versions.unshift({
        id: nextId('V'),
        claimId: claim.id,
        version: claim.version,
        editor: batch.createdBy,
        summary: `复核批次生效：${item.reason}，已发布 V${item.claimVersion} 保持冻结，当前版本转回复核`,
        changedFactIds: [fact.id],
        removedEvidence: [],
        createdAt: now()
      })
      auditEntries.push(audit(claim.id, '复核批次生效', batch.createdBy, `${fact.id}：${item.reason}，主张转回待编辑复核，已发布版本冻结不改`))
    }
  }

  return { claims, sourceRegistry, versions, extraBatches, auditEntries }
}

/** 晚到批次与当前状态的差异：保留冲突值等待复核 */
export function computeConflicts(
  batch: ChangeBatch,
  state: { claims: Claim[]; sourceRegistry: SourceVersionRecord[] }
): ConflictRecord[] {
  const conflicts: ConflictRecord[] = []
  if (batch.kind === '来源升版' || batch.kind === '来源撤回') {
    const change = batch.payload.sourceChange!
    const current = activeVersion(state.sourceRegistry, change.sourceKey)
    const currentVersion = current?.version ?? latestVersion(state.sourceRegistry, change.sourceKey)
    if (currentVersion !== change.baseVersion) {
      conflicts.push({
        id: nextId('CF'),
        claimId: '-',
        field: '来源版本',
        attemptedValue: `基于 V${change.baseVersion} ${batch.kind === '来源撤回' ? '撤回' : `升版（${change.newHash}）`}`,
        currentValue: `注册表当前 V${currentVersion}（${current?.contentHash ?? '无有效版本'}）`
      })
    }
  }
  if (batch.kind === '复核批次') {
    for (const item of batch.payload.reviewItems ?? []) {
      const claim = state.claims.find((entry) => entry.id === item.claimId)
      if (claim && claim.version !== item.claimVersion) {
        conflicts.push({
          id: nextId('CF'),
          claimId: claim.id,
          factId: item.factId,
          field: '主张版本',
          attemptedValue: `基于 V${item.claimVersion} 复核`,
          currentValue: `当前已推进至 V${claim.version}`
        })
      }
    }
  }
  return conflicts
}

/** 从全部主张的来源记录重建注册表（迁移与初始化共用） */
export function buildRegistry(claims: Claim[]): SourceVersionRecord[] {
  const registry: SourceVersionRecord[] = []
  const seen = new Set<string>()
  for (const claim of claims) {
    for (const fact of claim.facts) {
      for (const source of [...fact.sources, ...fact.counterSources]) {
        const key = `${source.sourceKey}#${source.version}`
        if (seen.has(key)) continue
        seen.add(key)
        registry.push({
          id: nextId('SV'),
          sourceKey: source.sourceKey,
          title: source.title,
          version: source.version,
          contentHash: source.contentHash,
          status: '有效',
          note: '初始登记',
          createdAt: source.capturedAt
        })
      }
    }
  }
  return registry
}

/** 旧数据升级：补齐来源身份；没有来源链的主张进入待核，不能直接发布 */
export function migrateLegacy(state: { claims: Claim[] }): { claims: Claim[]; sourceRegistry: SourceVersionRecord[]; auditEntries: AuditEntry[] } {
  const claims = structuredClone(state.claims)
  const auditEntries: AuditEntry[] = []
  for (const claim of claims) {
    for (const fact of claim.facts) {
      for (const source of [...fact.sources, ...fact.counterSources]) {
        if (!source.sourceKey) source.sourceKey = source.url
      }
    }
    const chained = claim.facts.length > 0 && claim.facts.every(hasSourceChain)
    if (!chained && claim.status !== '已发布' && claim.status !== '已撤回') {
      claim.status = '待核'
      claim.migratedFromLegacy = true
      auditEntries.push(audit(claim.id, '数据迁移', '系统', '旧数据缺少来源链，转入待核，补齐来源链前不能直接发布'))
    }
  }
  return { claims, sourceRegistry: buildRegistry(claims), auditEntries }
}

/** 发布闸门：返回阻断原因列表 */
export function publishBlockers(claim: Claim): string[] {
  const blocking: string[] = []
  if (claim.status === '待核') blocking.push('迁移数据处于待核状态，须先完成来源链核验')
  if (claim.migratedFromLegacy) blocking.push('旧数据迁移主张，需确认来源链后才能发布')
  if (claim.facts.length === 0) blocking.push('至少需要一项可验证事实')
  if (claim.facts.some((fact) => !hasSourceChain(fact))) blocking.push('存在没有来源链的事实')
  if (claim.facts.some((fact) => fact.invalidatedBy)) blocking.push('存在来源变更后未重算的结论')
  if (claim.facts.some((fact) => fact.conclusion === '证据不足' && fact.unresolved.length)) blocking.push('仍有证据不足且未解决疑点的事实')
  if (claim.facts.flatMap((fact) => fact.sources).some((source) => source.kind === '待证信息' && !source.retracted)) blocking.push('待证信息尚未完成原始来源核验')
  if (!claim.editor) blocking.push('缺少编辑复核人')
  return blocking
}

export function incompleteTail(journal: JournalEntry[]): boolean {
  return journal.some((entry) => !entry.complete)
}
