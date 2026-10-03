/* 冒烟测试：验证批次/失效/冲突/恢复/迁移五条链路（node + localStorage 垫片） */
const store: Record<string, string> = {}
const localStorageShim = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = String(value) },
  removeItem: (key: string) => { delete store[key] },
  clear: () => { for (const key of Object.keys(store)) delete store[key] },
  key: () => null,
  get length() { return Object.keys(store).length }
}
;(globalThis as any).localStorage = localStorageShim
;(globalThis as any).window = globalThis
;(globalThis as any).window.addEventListener = () => {}

const { useClaimStore } = await import('../src/store/useClaimStore')
const { migrateLegacy } = await import('../src/services/batches')

let failures = 0
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ✓ ${name}`)
  else { failures++; console.log(`  ✗ ${name} ${detail}`) }
}
const state = () => useClaimStore.getState()

console.log('1. 来源升版级联')
const result1 = await state().submitSourceChange('来源升版', { sourceKey: 'https://example.gov.cn/report/2025-1102', title: '一期工程环境影响报告表', newHash: 'sha256:NEW...v2', note: '官网发布修订版' }, '测试')
check('升版批次生效', result1.ok, result1.message)
const after = state().claims.find((c) => c.id === 'FC-260929-01')!
const f1 = after.facts.find((f) => f.id === 'F-1')!
check('未发布主张结论失效', !!f1.invalidatedBy)
check('失效事实结论未被改写', f1.conclusion === '已证实')
check('未被引用的已发布主张不受影响', !state().batches.some((b) => b.kind === '复核批次'))
const result1b = await state().submitSourceChange('来源升版', { sourceKey: 'https://example.gov.cn/food/inspect-37', title: '校园食品安全抽检结果公示（第37期）', newHash: 'sha256:FOOD...v2', note: '监管部门发布勘误版' }, '测试')
check('已发布主张来源升版批次生效', result1b.ok, result1b.message)
const published = state().claims.find((c) => c.id === 'FC-260927-02')!
check('已发布主张不被触碰', !published.facts.some((f) => f.invalidatedBy) && published.status === '已发布')
const reviewBatch = state().batches.find((b) => b.kind === '复核批次' && b.status === '待提交')
check('已发布主张另开复核批次', !!reviewBatch)
const reviewCommit = await state().commitBatch(reviewBatch!.id)
check('复核批次可提交生效', reviewCommit.ok, reviewCommit.message)
const afterReview = state().claims.find((c) => c.id === 'FC-260927-02')!
check('复核批次生效后主张转回复核', afterReview.status === '待编辑复核' && afterReview.facts.some((f) => f.invalidatedBy))
check('冻结快照仍保持发布原样', state().snapshots.find((s) => s.claimId === 'FC-260927-02')!.snapshot.status === '已发布')
check('日志序号推进', state().journalSeq === 3)

console.log('2. 并发提交：先到先生效，晚到保留冲突值')
// 模拟两个窗口：各自基于同一 baseSeq 暂存批次
const baseSeq = state().journalSeq
const mkBatch = (id: string) => ({ id, kind: '来源升版' as const, baseSeq, seq: null, status: '待提交' as const, payload: { sourceChange: { sourceKey: 'https://example.com/tender/8821', title: '项目设备采购公告', baseVersion: 2, newHash: `sha256:${id}`, note: '并发测试' } }, conflicts: [], createdBy: id, createdAt: new Date().toISOString() })
useClaimStore.setState((s) => ({ batches: [mkBatch('B-win-A'), mkBatch('B-win-B'), ...s.batches] }))
const rA = await state().commitBatch('B-win-A')
const rB = await state().commitBatch('B-win-B')
check('先到批次生效', rA.ok, rA.message)
check('晚到批次转冲突', !rB.ok && rB.conflict === true, rB.message)
const conflictBatch = state().batches.find((b) => b.id === 'B-win-B')!
check('冲突值已保留', conflictBatch.status === '冲突待复核' && conflictBatch.conflicts.length > 0)
const rResolve = await state().resolveBatch('B-win-B', '采用冲突值')
check('采用冲突值重新提交生效', rResolve.ok, rResolve.message)
check('原冲突批次标记已解决', state().batches.find((b) => b.id === 'B-win-B')!.status === '已解决')

console.log('3. 写入失败恢复重试')
state().setInjectFailure(true)
const fail = await state().submitSourceChange('来源撤回', { sourceKey: 'https://example.gov.cn/water/0928', title: '市供水水质周报', newHash: '', note: '监管部门撤回周报' }, '测试')
check('注入故障导致写入失败', !fail.ok, fail.message)
check('日志留下不完整尾部', state().journal.some((e) => !e.complete))
const failedBatch = state().batches.find((b) => b.status === '写入失败')
check('批次标记写入失败', !!failedBatch)
const recover = state().recoverJournal()
check('恢复成功', recover.ok, recover.message)
check('不完整尾部已截断', state().journal.every((e) => e.complete))
check('失败批次重置待提交', state().batches.find((b) => b.id === failedBatch!.id)!.status === '待提交')
const retry = await state().commitBatch(failedBatch!.id)
check('恢复后重试生效', retry.ok, retry.message)
const water = state().claims.find((c) => c.id === 'FC-260928-03')!
check('撤回后未发布结论失效', water.facts.some((f) => f.invalidatedBy))

console.log('4. 失效结论重算')
const target = water.facts.find((f) => f.invalidatedBy)!
state().recomputeFact(water.id, target.id, '测试')
const recomputed = state().claims.find((c) => c.id === water.id)!.facts.find((f) => f.id === target.id)!
check('重算清除失效标记', !recomputed.invalidatedBy)
check('撤回来源不再计入结论', recomputed.conclusion !== '已证实', `结论=${recomputed.conclusion}`)
check('重算写入版本记录', state().versions.some((v) => v.claimId === water.id && v.summary.includes('重算')))

console.log('5. 迁移：无来源链主张进入待核，不能直接发布')
const legacy = state().claims.find((c) => c.id === 'FC-LEGACY-07')!
check('旧数据主张处于待核', legacy.status === '待核')
const directPublish = state().transitionClaim(legacy.id, '已发布', '尝试直接发布')
check('待核不能直接发布', !directPublish.ok, directPublish.message)
const migrated = migrateLegacy({ claims: [{ ...structuredClone(legacy), id: 'FC-OLD-1', status: '核查中' as const }] })
check('迁移函数将无来源链主张转入待核', migrated.claims[0].status === '待核')
check('迁移补建来源注册表', Array.isArray(migrated.sourceRegistry))

console.log('6. 发布闸门与冻结')
const pending = state().claims.find((c) => c.id === 'FC-260929-01')!
const blocked = state().transitionClaim(pending.id, '已发布', '尝试带失效结论发布')
check('失效结论未重算时拦截发布', !blocked.ok, blocked.message)
// 重算复核批次标记的失效结论后重新发布
const back = state().claims.find((c) => c.id === 'FC-260927-02')!
for (const fact of back.facts.filter((f) => f.invalidatedBy)) state().recomputeFact(back.id, fact.id, '测试')
const republish = state().transitionClaim(back.id, '已发布', '复核完成后重新发布')
check('重算后可重新发布', republish.ok, republish.message)
const frozenTransition = state().transitionClaim(back.id, '核查中', '尝试回退已发布')
check('已发布版本冻结不可回退', !frozenTransition.ok, frozenTransition.message)
const snaps = state().snapshots.filter((s) => s.claimId === 'FC-260927-02')
check('每次发布各留一份冻结快照', snaps.length === 2, `快照数=${snaps.length}`)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
