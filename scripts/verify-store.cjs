/* 一次性验证脚本：驱动 store 验证四条规则（构建后由 node 执行） */
const storage = () => {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size }
  }
}
globalThis.localStorage = storage()
globalThis.sessionStorage = storage()

const { useClaimStore, windowId } = require('./useClaimStore.cjs')

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures += 1; console.log(`  ✗ ${name} ${extra}`) }
}
const store = () => useClaimStore.getState()
const claim = (id) => store().claims.find((c) => c.id === id)
const fact = (cid, fid) => claim(cid).facts.find((f) => f.id === fid)

console.log('规则1a：来源升版 → 未发布结论失效重算')
let r = store().upgradeSource('FC-260929-01', 'F-1', 'S-1', { contentHash: 'sha256:new...v2', chainOfCustody: '新版留档', note: '官方更新' })
check('升版成功', r.ok, r.message)
check('旧版本标记已升版', fact('FC-260929-01', 'F-1').sources.find((s) => s.id === 'S-1').status === '已升版')
check('新版本V2已入链', fact('FC-260929-01', 'F-1').sources.some((s) => s.version === 2 && s.status === '有效' && s.contentHash === 'sha256:new...v2'))
check('结论失效为证据不足', fact('FC-260929-01', 'F-1').conclusion === '证据不足')
check('置信度被重算拉低', fact('FC-260929-01', 'F-1').confidence < 98)
check('疑点登记重新核验', fact('FC-260929-01', 'F-1').unresolved.some((u) => u.includes('需重新核验')))
check('待编辑复核退回核查中', claim('FC-260929-01').status === '核查中')
check('生成失效重算版本记录', store().versions.some((v) => v.claimId === 'FC-260929-01' && v.kind === '失效重算'))
check('审计记录结论失效重算', store().audit.some((a) => a.action === '结论失效重算' && a.claimId === 'FC-260929-01'))

console.log('规则1b：来源撤回 → 已发布版本冻结原样并另开复核批次')
const before = JSON.parse(JSON.stringify(claim('FC-260928-03')))
r = store().retractSource('FC-260928-03', 'F-4', 'S-5', '水质周报数据更正撤回')
check('撤回成功', r.ok, r.message)
check('已发布主张保持冻结原样', JSON.stringify(claim('FC-260928-03')) === JSON.stringify(before))
check('复核批次已开启且引用冻结版本', store().reviewBatches.some((b) => b.claimId === 'FC-260928-03' && b.status === '待复核' && b.frozenVersion === 3 && b.trigger === '来源撤回'))
check('冻结快照已留档', store().versions.some((v) => v.claimId === 'FC-260928-03' && v.kind === '冻结' && v.snapshot && v.snapshot.status === '已发布'))
const rb = store().reviewBatches.find((b) => b.claimId === 'FC-260928-03' && b.status === '待复核')
store().resolveReviewBatch(rb.id, '退回重核')
check('退回重核后主张回到核查中', claim('FC-260928-03').status === '核查中')
check('退回后来源标记已撤回', fact('FC-260928-03', 'F-4').sources.find((s) => s.id === 'S-5').status === '已撤回')
check('退回后结论失效重算', fact('FC-260928-03', 'F-4').conclusion === '证据不足')
check('复核批次已结案', store().reviewBatches.find((b) => b.id === rb.id).status === '已结案')

console.log('规则2：并发提交同一批次，先到生效、晚到保留冲突值')
const v0 = claim('FC-260929-01').version
r = store().submitBatch({ claimId: 'FC-260929-01', baseVersion: v0, note: '窗口A', mutations: [{ factId: 'F-3', patch: { conclusion: '部分属实', confidence: 55 } }], windowId: 'W-AAAA' })
check('先到批次生效', r.ok && claim('FC-260929-01').version === v0 + 1, r.message)
check('先到修改已应用', fact('FC-260929-01', 'F-3').conclusion === '部分属实')
r = store().submitBatch({ claimId: 'FC-260929-01', baseVersion: v0, note: '窗口B晚到', mutations: [{ factId: 'F-3', patch: { conclusion: '不实', confidence: 20 } }], windowId: 'W-BBBB' })
check('晚到批次判为冲突', !r.ok && r.conflict === true, r.message)
check('先到值不被覆盖', fact('FC-260929-01', 'F-3').conclusion === '部分属实' && fact('FC-260929-01', 'F-3').confidence === 55)
const cb = store().batches.find((b) => b.windowId === 'W-BBBB')
check('冲突值保留待复核', cb && cb.status === '冲突待复核' && cb.mutations[0].patch.conclusion === '不实')
store().resolveConflictBatch(cb.id, '采纳')
check('复核采纳后冲突值生效', fact('FC-260929-01', 'F-3').conclusion === '不实' && store().batches.find((b) => b.id === cb.id).status === '已采纳')

console.log('规则3：写入失败 → 从最后一个完整批次恢复重试')
const v1 = claim('FC-260929-01').version
const snapshotF1 = JSON.stringify(fact('FC-260929-01', 'F-2'))
store().armWriteFailureDrill()
r = store().submitBatch({ claimId: 'FC-260929-01', baseVersion: v1, note: '会失败的批次', mutations: [{ factId: 'F-2', patch: { confidence: 1 } }], windowId: 'W-CCCC' })
check('写入失败被报告', !r.ok && r.failed === true, r.message)
check('状态恢复到最后完整批次', JSON.stringify(fact('FC-260929-01', 'F-2')) === snapshotF1 && claim('FC-260929-01').version === v1)
const fb = store().batches.find((b) => b.note === '会失败的批次')
check('失败批次保留可重试', fb && fb.status === '写入失败')
r = store().retryFailedBatch(fb.id)
check('重试后恢复写入', r.ok && fact('FC-260929-01', 'F-2').confidence === 1 && claim('FC-260929-01').version === v1 + 1, r.message)
check('重试批次标记已生效', store().batches.find((b) => b.id === fb.id).status === '已生效')

console.log('规则4：旧数据升级 → 无来源链主张进入待核，不能直接发布')
check('种子旧数据主张为待核', claim('FC-260926-02').status === '待核')
r = store().transitionClaim('FC-260926-02', '已发布', '尝试直接发布')
check('待核不能直接发布', !r.ok && r.message.includes('不能直接发布'), r.message)
check('状态未被改动', claim('FC-260926-02').status === '待核')
r = store().transitionClaim('FC-260926-02', '核查中', '开始补核')
check('待核可转入核查流程', r.ok && claim('FC-260926-02').status === '核查中')
const legacy = { claims: [{ id: 'FC-OLD', title: '旧主张', summary: '', reporter: 'x', editor: 'e', status: '已发布', priority: '中', createdAt: '', updatedAt: '', version: 7, facts: [{ id: 'F-9', text: 't', conclusion: '已证实', confidence: 90, unresolved: [], sources: [{ id: 'S-9', title: 't', url: 'u', publisher: 'p', publishedAt: '', capturedAt: '', kind: '二次来源', chainOfCustody: '', contentHash: '', version: 1 }], counterSources: [], annotations: [] }] }], versions: [], audit: [] }
const migrated = useClaimStore.persist.getOptions().migrate(legacy, 0)
check('迁移后来源补默认状态', migrated.claims[0].facts[0].sources[0].status === '有效')
check('迁移后缺来源链的已发布主张转入待核', migrated.claims[0].status === '待核')
check('迁移写入审计', migrated.audit.some((a) => a.action === '旧数据升级' && a.claimId === 'FC-OLD'))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
