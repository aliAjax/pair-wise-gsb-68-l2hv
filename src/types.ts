export type ClaimStatus = '待核' | '核查中' | '待编辑复核' | '已发布' | '已撤回'
export type FactConclusion = '已证实' | '部分属实' | '证据不足' | '不实'
export type EvidenceKind = '原始证据' | '二次来源' | '待证信息'

export interface SourceRecord {
  id: string
  title: string
  url: string
  publisher: string
  publishedAt: string
  capturedAt: string
  kind: EvidenceKind
  chainOfCustody: string
  contentHash: string
  version: number
  /** 来源身份（同一来源跨版本不变），取公开地址 */
  sourceKey: string
  /** 该留档版本已被来源方撤回 */
  retracted?: boolean
  supersededBy?: string
}

/** 来源注册表：同一 sourceKey 的版本序列，升版/撤回在此登记 */
export interface SourceVersionRecord {
  id: string
  sourceKey: string
  title: string
  version: number
  contentHash: string
  status: '有效' | '已升版' | '已撤回'
  note: string
  createdAt: string
}

export interface ClaimAnnotation {
  id: string
  author: string
  role: '记者' | '编辑' | '事实核查员'
  content: string
  createdAt: string
  resolved: boolean
}

export interface FactInvalidation {
  sourceKey: string
  reason: string
  at: string
}

export interface ClaimFact {
  id: string
  text: string
  conclusion: FactConclusion
  confidence: number
  unresolved: string[]
  sources: SourceRecord[]
  counterSources: SourceRecord[]
  annotations: ClaimAnnotation[]
  /** 来源升版/撤回后结论失效，需重算后才可发布 */
  invalidatedBy?: FactInvalidation
}

export interface Claim {
  id: string
  title: string
  summary: string
  reporter: string
  editor: string
  status: ClaimStatus
  priority: '低' | '中' | '高'
  createdAt: string
  updatedAt: string
  version: number
  /** 旧数据迁移而来且缺少来源链，先待核、不能直接发布 */
  migratedFromLegacy?: boolean
  facts: ClaimFact[]
}

export interface VersionRecord {
  id: string
  claimId: string
  version: number
  editor: string
  summary: string
  changedFactIds: string[]
  removedEvidence: string[]
  createdAt: string
}

/** 已发布版本的冻结快照，来源变更不回写 */
export interface PublishedSnapshot {
  id: string
  claimId: string
  version: number
  frozenAt: string
  snapshot: Claim
}

export interface AuditEntry {
  id: string
  claimId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}

export type BatchKind = '来源升版' | '来源撤回' | '复核批次'
export type BatchStatus = '待提交' | '已生效' | '冲突待复核' | '已解决' | '写入失败'

export interface SourceChangePayload {
  sourceKey: string
  title: string
  baseVersion: number
  newHash: string
  note: string
}

export interface ReviewItem {
  claimId: string
  factId: string
  claimVersion: number
  reason: string
}

export interface BatchPayload {
  sourceChange?: SourceChangePayload
  reviewItems?: ReviewItem[]
}

export interface ConflictRecord {
  id: string
  claimId: string
  factId?: string
  field: string
  attemptedValue: string
  currentValue: string
}

export interface ChangeBatch {
  id: string
  kind: BatchKind
  /** 提交时与日志序号比对：不一致则先到者生效、本批次转冲突 */
  baseSeq: number
  seq: number | null
  status: BatchStatus
  payload: BatchPayload
  conflicts: ConflictRecord[]
  createdBy: string
  createdAt: string
  committedAt?: string
}

export interface DomainSnapshot {
  claims: Claim[]
  sourceRegistry: SourceVersionRecord[]
  versions: VersionRecord[]
}

/** 写入日志：complete=false 的尾部记录代表写入中断，恢复时截断 */
export interface JournalEntry {
  seq: number
  batchId: string
  kind: BatchKind
  complete: boolean
  checksum: string
  createdAt: string
  snapshot?: DomainSnapshot
}
