export type ClaimStatus = '待核' | '核查中' | '待编辑复核' | '已发布' | '已撤回'
export type FactConclusion = '已证实' | '部分属实' | '证据不足' | '不实'
export type EvidenceKind = '原始证据' | '二次来源' | '待证信息'
export type SourceStatus = '有效' | '已升版' | '已撤回'

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
  status: SourceStatus
  supersededBy?: string
  retractReason?: string
}

export interface ClaimAnnotation {
  id: string
  author: string
  role: '记者' | '编辑' | '事实核查员'
  content: string
  createdAt: string
  resolved: boolean
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
  facts: ClaimFact[]
}

/** 一次批次提交中对单条事实的修改 */
export interface FactMutation {
  factId: string
  patch: Partial<Pick<ClaimFact, 'conclusion' | 'confidence' | 'unresolved'>>
}

export type BatchStatus = '已生效' | '冲突待复核' | '写入失败' | '已采纳' | '已放弃'

/** 编辑批次：两个窗口提交同一批次时先到者生效，晚到者保留冲突值 */
export interface BatchCommit {
  id: string
  seq: number
  claimId: string
  windowId: string
  baseVersion: number
  note: string
  mutations: FactMutation[]
  status: BatchStatus
  createdAt: string
  resolvedAt?: string
}

export type ReviewTrigger = '来源升版' | '来源撤回'

/** 来源改动命中已发布主张时另开的复核批次，发布版本保持冻结 */
export interface ReviewBatch {
  id: string
  claimId: string
  factIds: string[]
  trigger: ReviewTrigger
  sourceId: string
  sourceTitle: string
  sourceUrl: string
  frozenVersion: number
  pendingUpgrade?: { contentHash: string; chainOfCustody: string; note: string }
  retractReason?: string
  status: '待复核' | '已结案'
  resolution?: '维持发布' | '退回重核' | '撤回主张'
  createdAt: string
  resolvedAt?: string
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
  kind?: '编辑' | '发布' | '冻结' | '失效重算'
  /** 发布或冻结时的完整快照，原样保留不随后续编辑变化 */
  snapshot?: Claim
}

export interface AuditEntry {
  id: string
  claimId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}
