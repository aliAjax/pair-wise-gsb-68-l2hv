import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Badge, Box, Button, Divider, Flex, FormControl, FormLabel, Grid, Input, Modal, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalOverlay, Select, Tab, TabList, TabPanel, TabPanels, Tabs, Text, Textarea, useDisclosure, useToast } from '@chakra-ui/react'
import { EvidenceGraph } from '../components/EvidenceGraph'
import { conclusionColor, useClaimStore, windowId } from '../store/useClaimStore'
import { publishBlockers } from '../services/api'
import type { ClaimFact, EvidenceKind, FactConclusion, SourceRecord } from '../types'

type FactDraft = Partial<Pick<ClaimFact, 'conclusion' | 'confidence' | 'unresolved'>>

export function ClaimWorkspace() {
  const { id } = useParams()
  const toast = useToast()
  const state = useClaimStore()
  const claim = state.claims.find((item) => item.id === id)
  const [selectedFactId, setSelectedFactId] = useState(claim?.facts[0]?.id ?? '')
  const selectedFact = claim?.facts.find((item) => item.id === selectedFactId) ?? claim?.facts[0]
  const [factText, setFactText] = useState('')
  const sourceModal = useDisclosure()
  const versionModal = useDisclosure()
  const upgradeModal = useDisclosure()
  const retractModal = useDisclosure()
  const [sourceForm, setSourceForm] = useState<Omit<SourceRecord, 'id' | 'capturedAt' | 'version' | 'status'>>({ title: '', url: '', publisher: '', publishedAt: '2026-09-29', kind: '原始证据', chainOfCustody: '', contentHash: '' })
  const [counterSource, setCounterSource] = useState(false)
  const [transitionNote, setTransitionNote] = useState('')
  const [sourceTarget, setSourceTarget] = useState<{ factId: string; source: SourceRecord } | null>(null)
  const [upgradeForm, setUpgradeForm] = useState({ contentHash: '', chainOfCustody: '', note: '' })
  const [retractReason, setRetractReason] = useState('')
  // 编辑批次：事实修改先暂存为草稿，连同基准版本一起提交
  const [drafts, setDrafts] = useState<Record<string, FactDraft>>({})
  const [draftBase, setDraftBase] = useState<number | null>(null)
  const [batchNote, setBatchNote] = useState('')
  useEffect(() => { if (!selectedFactId && claim?.facts[0]) setSelectedFactId(claim.facts[0].id) }, [selectedFactId, claim])
  if (!claim) return <Box p="10">未找到核查主张</Box>
  const frozen = claim.status === '已发布' || claim.status === '已撤回'
  const activeReview = state.reviewBatches.find((item) => item.claimId === claim.id && item.status === '待复核')
  const claimVersions = state.versions.filter((item) => item.claimId === claim.id)
  const blockers = publishBlockers(claim)
  const draftCount = Object.keys(drafts).length
  const draftFact = selectedFact ? { ...selectedFact, ...drafts[selectedFact.id] } : undefined
  const stageFact = (patch: FactDraft) => {
    if (!selectedFact || frozen) return
    if (draftBase === null) setDraftBase(claim.version)
    setDrafts((current) => ({ ...current, [selectedFact.id]: { ...current[selectedFact.id], ...patch } }))
  }
  const discardDrafts = () => { setDrafts({}); setDraftBase(null); setBatchNote('') }
  const submitBatch = () => {
    const result = state.submitBatch({ claimId: claim.id, baseVersion: draftBase ?? claim.version, note: batchNote, mutations: Object.entries(drafts).map(([factId, patch]) => ({ factId, patch })), windowId })
    toast({ title: result.message, status: result.ok ? 'success' : result.conflict ? 'warning' : 'error' })
    discardDrafts()
  }
  const addSource = () => {
    if (!selectedFact || !sourceForm.title || !sourceForm.url) return
    state.addSource(claim.id, selectedFact.id, sourceForm, counterSource)
    sourceModal.onClose()
    toast({ title: '证据已加入关系图', status: 'success' })
  }
  const openUpgrade = (factId: string, source: SourceRecord) => { setSourceTarget({ factId, source }); setUpgradeForm({ contentHash: '', chainOfCustody: '', note: '' }); upgradeModal.onOpen() }
  const openRetract = (factId: string, source: SourceRecord) => { setSourceTarget({ factId, source }); setRetractReason(''); retractModal.onOpen() }
  const upgradeSource = () => {
    if (!sourceTarget) return
    const result = state.upgradeSource(claim.id, sourceTarget.factId, sourceTarget.source.id, upgradeForm)
    toast({ title: result.message, status: result.ok ? 'success' : 'error' })
    if (result.ok) upgradeModal.onClose()
  }
  const retractSource = () => {
    if (!sourceTarget) return
    const result = state.retractSource(claim.id, sourceTarget.factId, sourceTarget.source.id, retractReason)
    toast({ title: result.message, status: result.ok ? 'success' : 'error' })
    if (result.ok) retractModal.onClose()
  }
  const transition = (status: typeof claim.status) => {
    const result = state.transitionClaim(claim.id, status, transitionNote || `由${claim.status}流转至${status}`)
    toast({ title: result.message, status: result.ok ? 'success' : 'error' })
    if (result.ok) versionModal.onClose()
  }
  const exportArchive = () => {
    const versions = state.versions.filter((item) => item.claimId === claim.id)
    const audit = state.audit.filter((item) => item.claimId === claim.id)
    const blob = new Blob([JSON.stringify({ claim, versions, audit }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${claim.id}-核查档案.json`; anchor.click(); URL.revokeObjectURL(url)
  }
  return <Box p="6" pb="16">
    <Flex justify="space-between" align="flex-start" mb="4"><Box><Text fontSize="xs" color="gray.600">{claim.id} · {claim.reporter} / {claim.editor || '未指派编辑'} · V{claim.version} · {windowId}</Text><Text fontSize="xl" fontWeight="700" mt="1">{claim.title}</Text><Text color="gray.600" fontSize="sm" mt="2" maxW="760px">{claim.summary}</Text></Box><Flex gap="2"><Button variant="outline" onClick={exportArchive}>导出档案</Button><Button colorScheme="teal" onClick={versionModal.onOpen}>状态与版本</Button></Flex></Flex>
    {claim.status === '已发布' && <Box bg="blue.50" borderWidth="1px" borderColor="blue.200" p="3" mb="4"><Text fontSize="sm" fontWeight="600">已发布版本 V{claim.version} 已冻结留档{activeReview ? `，复核批次${activeReview.id}进行中（${activeReview.trigger}）` : ''}</Text><Text fontSize="xs" color="gray.600" mt="1">冻结期间结论与证据不可直接修改；来源升版或撤回将另开复核批次，在复核队列中结案。</Text></Box>}
    {claim.status === '待核' && <Box bg="purple.50" borderWidth="1px" borderColor="purple.200" p="3" mb="4"><Text fontSize="sm" fontWeight="600">旧数据升级迁入，缺少来源链</Text><Text fontSize="xs" color="gray.600" mt="1">该主张不能直接发布，请补齐来源与留档说明后转入核查流程。</Text></Box>}
    {draftCount > 0 && <Flex bg="orange.50" borderWidth="1px" borderColor="orange.200" p="3" mb="4" align="center" gap="3">
      <Box flex="1"><Text fontSize="sm" fontWeight="600">未提交批次 · {draftCount}项事实修改 · 基于V{draftBase}</Text>{draftBase !== null && draftBase !== claim.version && <Text fontSize="xs" color="red.600" mt="1">该主张已被先到提交更新至V{claim.version}，提交后您的修改将保留为冲突值待复核。</Text>}</Box>
      <Input size="sm" maxW="240px" placeholder="批次说明（可选）" value={batchNote} onChange={(event) => setBatchNote(event.target.value)} />
      <Button size="sm" colorScheme="teal" onClick={submitBatch}>提交批次</Button>
      <Button size="sm" variant="ghost" onClick={discardDrafts}>放弃</Button>
    </Flex>}
    <EvidenceGraph facts={claim.facts} />
    <Grid mt="4" templateColumns="320px 1fr" gap="4" alignItems="start">
      <Box bg="white" borderWidth="1px" p="3">
        <Flex justify="space-between" align="center" mb="3"><Text fontWeight="700">可验证事实树</Text><Badge>{claim.facts.length}</Badge></Flex>
        {claim.facts.map((fact) => <Box key={fact.id} as="button" textAlign="left" w="100%" p="3" mb="2" borderWidth="1px" borderColor={fact.id === selectedFact?.id ? 'teal.600' : 'gray.200'} bg={fact.id === selectedFact?.id ? 'teal.50' : 'white'} onClick={() => setSelectedFactId(fact.id)}><Flex justify="space-between"><Text fontSize="xs" color="gray.500">{fact.id}</Text><Flex gap="1">{drafts[fact.id] && <Badge colorScheme="orange">未提交</Badge>}<Badge colorScheme={conclusionColor[fact.conclusion]}>{fact.conclusion}</Badge></Flex></Flex><Text fontSize="sm" mt="2" fontWeight="600">{fact.text}</Text><Text fontSize="xs" color="gray.500" mt="2">置信度 {fact.confidence}% · 疑点 {fact.unresolved.length}</Text></Box>)}
        {!frozen && <Flex mt="3" gap="2"><Input size="sm" placeholder="拆出新的可验证事实" value={factText} onChange={(event) => setFactText(event.target.value)} /><Button size="sm" colorScheme="teal" onClick={() => { state.addFact(claim.id, factText); setFactText('') }}>添加</Button></Flex>}
      </Box>
      {selectedFact && draftFact && <Box bg="white" borderWidth="1px" p="4">
        <Flex justify="space-between" align="flex-start"><Box><Text fontSize="xs" color="gray.500">{selectedFact.id}</Text><Text fontWeight="700" mt="1">{selectedFact.text}</Text></Box><Badge colorScheme={conclusionColor[draftFact.conclusion ?? selectedFact.conclusion]}>{draftFact.conclusion}</Badge></Flex>
        <Grid templateColumns="1fr 1fr 1fr" gap="3" mt="4">
          <FormControl isDisabled={frozen}><FormLabel fontSize="xs">事实结论</FormLabel><Select size="sm" value={draftFact.conclusion} onChange={(event) => stageFact({ conclusion: event.target.value as FactConclusion })}>{['已证实', '部分属实', '证据不足', '不实'].map((value) => <option key={value}>{value}</option>)}</Select></FormControl>
          <FormControl isDisabled={frozen}><FormLabel fontSize="xs">置信程度 {draftFact.confidence}%</FormLabel><Input size="sm" type="range" min="0" max="100" value={draftFact.confidence} onChange={(event) => stageFact({ confidence: Number(event.target.value) })} /></FormControl>
          <FormControl isDisabled={frozen}><FormLabel fontSize="xs">未解决疑点</FormLabel><Input size="sm" value={(draftFact.unresolved ?? []).join('；')} onChange={(event) => stageFact({ unresolved: event.target.value ? event.target.value.split('；') : [] })} /></FormControl>
        </Grid>
        <Tabs mt="5" colorScheme="teal">
          <TabList><Tab>支持证据 {selectedFact.sources.length}</Tab><Tab>相反证据 {selectedFact.counterSources.length}</Tab><Tab>批注 {selectedFact.annotations.length}</Tab><Tab>来源时间线</Tab></TabList>
          <TabPanels>
            <TabPanel px="0"><EvidenceList sources={selectedFact.sources} factId={selectedFact.id} canAdd={!frozen} onAdd={() => { setCounterSource(false); sourceModal.onOpen() }} onUpgrade={openUpgrade} onRetract={openRetract} readOnly={claim.status === '已撤回'} /></TabPanel>
            <TabPanel px="0"><EvidenceList sources={selectedFact.counterSources} factId={selectedFact.id} canAdd={!frozen} onAdd={() => { setCounterSource(true); sourceModal.onOpen() }} onUpgrade={openUpgrade} onRetract={openRetract} counter readOnly={claim.status === '已撤回'} /></TabPanel>
            <TabPanel px="0"><AnnotationList fact={selectedFact} claimId={claim.id} /></TabPanel>
            <TabPanel px="0"><Box borderLeftWidth="2px" borderColor="gray.300" pl="4">{[...selectedFact.sources, ...selectedFact.counterSources].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).map((source) => <Box key={source.id} mb="4"><Text fontSize="xs" color="gray.500">{source.publishedAt} · {source.kind} · {source.status}</Text><Text fontWeight="600" mt="1">{source.title}</Text><Text fontSize="sm" color="gray.600">{source.publisher} · 留档 {source.capturedAt.replace('T', ' ').slice(0, 16)}</Text></Box>)}</Box></TabPanel>
          </TabPanels>
        </Tabs>
      </Box>}
    </Grid>
    <Modal isOpen={sourceModal.isOpen} onClose={sourceModal.onClose} size="xl"><ModalOverlay /><ModalContent><ModalHeader>{counterSource ? '关联相反证据' : '关联支持证据'}</ModalHeader><ModalCloseButton /><ModalBody><Grid templateColumns="1fr 1fr" gap="3"><FormControl><FormLabel>来源标题</FormLabel><Input value={sourceForm.title} onChange={(event) => setSourceForm({ ...sourceForm, title: event.target.value })} /></FormControl><FormControl><FormLabel>公开地址</FormLabel><Input value={sourceForm.url} onChange={(event) => setSourceForm({ ...sourceForm, url: event.target.value })} /></FormControl><FormControl><FormLabel>发布机构</FormLabel><Input value={sourceForm.publisher} onChange={(event) => setSourceForm({ ...sourceForm, publisher: event.target.value })} /></FormControl><FormControl><FormLabel>证据类型</FormLabel><Select value={sourceForm.kind} onChange={(event) => setSourceForm({ ...sourceForm, kind: event.target.value as EvidenceKind })}>{['原始证据', '二次来源', '待证信息'].map((value) => <option key={value}>{value}</option>)}</Select></FormControl><FormControl><FormLabel>内容哈希</FormLabel><Input placeholder="sha256:..." value={sourceForm.contentHash} onChange={(event) => setSourceForm({ ...sourceForm, contentHash: event.target.value })} /></FormControl><FormControl><FormLabel>留档说明</FormLabel><Input value={sourceForm.chainOfCustody} onChange={(event) => setSourceForm({ ...sourceForm, chainOfCustody: event.target.value })} /></FormControl></Grid></ModalBody><ModalFooter><Button variant="ghost" mr="3" onClick={sourceModal.onClose}>取消</Button><Button colorScheme="teal" isDisabled={!sourceForm.title || !sourceForm.url} onClick={addSource}>加入证据关系图</Button></ModalFooter></ModalContent></Modal>
    <Modal isOpen={upgradeModal.isOpen} onClose={upgradeModal.onClose}><ModalOverlay /><ModalContent><ModalHeader>来源升版 · {sourceTarget?.source.title}</ModalHeader><ModalCloseButton /><ModalBody><Text fontSize="xs" color="gray.500" mb="3">当前V{sourceTarget?.source.version}将标记为已升版并保留在证据链中；未发布结论失效重算，已发布版本冻结并另开复核批次。</Text><FormControl mb="3"><FormLabel>新内容哈希</FormLabel><Input placeholder="sha256:..." value={upgradeForm.contentHash} onChange={(event) => setUpgradeForm({ ...upgradeForm, contentHash: event.target.value })} /></FormControl><FormControl mb="3"><FormLabel>新留档说明</FormLabel><Input value={upgradeForm.chainOfCustody} onChange={(event) => setUpgradeForm({ ...upgradeForm, chainOfCustody: event.target.value })} /></FormControl><FormControl><FormLabel>升版说明</FormLabel><Textarea rows={3} value={upgradeForm.note} onChange={(event) => setUpgradeForm({ ...upgradeForm, note: event.target.value })} /></FormControl></ModalBody><ModalFooter><Button variant="ghost" mr="3" onClick={upgradeModal.onClose}>取消</Button><Button colorScheme="teal" onClick={upgradeSource}>升版并级联复核</Button></ModalFooter></ModalContent></Modal>
    <Modal isOpen={retractModal.isOpen} onClose={retractModal.onClose}><ModalOverlay /><ModalContent><ModalHeader>撤回来源 · {sourceTarget?.source.title}</ModalHeader><ModalCloseButton /><ModalBody><Text fontSize="xs" color="gray.500" mb="3">撤回后来源保留在证据链中并标记已撤回；依赖它的未发布结论失效重算，已发布版本冻结并另开复核批次。</Text><FormControl><FormLabel>撤回原因</FormLabel><Textarea rows={3} value={retractReason} onChange={(event) => setRetractReason(event.target.value)} /></FormControl></ModalBody><ModalFooter><Button variant="ghost" mr="3" onClick={retractModal.onClose}>取消</Button><Button colorScheme="red" isDisabled={!retractReason.trim()} onClick={retractSource}>撤回并级联复核</Button></ModalFooter></ModalContent></Modal>
    <Modal isOpen={versionModal.isOpen} onClose={versionModal.onClose} size="lg"><ModalOverlay /><ModalContent><ModalHeader>状态流转与版本记录</ModalHeader><ModalCloseButton /><ModalBody>
      <FormControl mb="4"><FormLabel>版本变更说明</FormLabel><Textarea rows={3} value={transitionNote} onChange={(event) => setTransitionNote(event.target.value)} /></FormControl>
      {blockers.length > 0 && claim.status !== '已发布' && <Box bg="red.50" p="3" mb="4"><Text fontSize="sm" fontWeight="600" mb="1">发布前校验未通过</Text>{blockers.map((item) => <Text key={item} fontSize="xs" color="red.700">· {item}</Text>)}</Box>}
      <Text fontSize="xs" color="gray.500" mb="2">历史版本（发布与冻结版本含完整快照）</Text>
      <Box maxH="200px" overflowY="auto" borderWidth="1px" p="3" mb="2">{claimVersions.map((item) => <Flex key={item.id} justify="space-between" mb="2"><Box><Text fontSize="sm"><Badge mr="2" colorScheme={item.kind === '发布' ? 'green' : item.kind === '冻结' ? 'blue' : item.kind === '失效重算' ? 'orange' : 'gray'}>{item.kind ?? '编辑'}</Badge>V{item.version} · {item.summary}</Text><Text fontSize="xs" color="gray.500">{item.editor} · {item.createdAt.replace('T', ' ').slice(0, 16)}</Text></Box>{item.snapshot && <Button size="xs" variant="outline" onClick={() => { const blob = new Blob([JSON.stringify(item.snapshot, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${claim.id}-V${item.version}-冻结快照.json`; anchor.click(); URL.revokeObjectURL(url) }}>快照</Button>}</Flex>)}{claimVersions.length === 0 && <Text fontSize="xs" color="gray.500">暂无版本记录</Text>}</Box>
    </ModalBody><ModalFooter>
      {claim.status !== '核查中' && claim.status !== '已发布' && claim.status !== '已撤回' && <Button mr="2" onClick={() => transition('核查中')}>转入核查中</Button>}
      {claim.status !== '待编辑复核' && claim.status !== '已发布' && claim.status !== '已撤回' && <Button mr="2" onClick={() => transition('待编辑复核')}>提交编辑复核</Button>}
      {claim.status !== '已发布' && claim.status !== '已撤回' && <Button colorScheme="teal" isDisabled={blockers.length > 0} onClick={() => transition('已发布')}>发布正式版本</Button>}
    </ModalFooter></ModalContent></Modal>
  </Box>
}

function EvidenceList({ sources, factId, canAdd, onAdd, onUpgrade, onRetract, counter = false, readOnly = false }: { sources: SourceRecord[]; factId: string; canAdd: boolean; onAdd: () => void; onUpgrade: (factId: string, source: SourceRecord) => void; onRetract: (factId: string, source: SourceRecord) => void; counter?: boolean; readOnly?: boolean }) {
  return <Box><Flex justify="space-between" mb="3"><Text fontSize="sm" color="gray.600">{counter ? '相反证据与支持证据并列保留' : '按原始证据、二次来源、待证信息分类'}</Text>{canAdd && <Button size="sm" colorScheme={counter ? 'red' : 'teal'} variant="outline" onClick={onAdd}>{counter ? '关联相反证据' : '关联支持证据'}</Button>}</Flex>{sources.map((source) => <Box key={source.id} borderWidth="1px" p="3" mb="2" opacity={source.status === '有效' ? 1 : 0.75}><Flex justify="space-between" align="center"><Text fontWeight="600">{source.title}</Text><Flex gap="1"><Badge colorScheme={source.kind === '原始证据' ? 'green' : source.kind === '二次来源' ? 'orange' : 'gray'}>{source.kind}</Badge><Badge colorScheme={source.status === '有效' ? 'teal' : source.status === '已升版' ? 'blue' : 'red'}>{source.status}</Badge></Flex></Flex><Text fontSize="xs" color="gray.600" mt="2">{source.publisher} · {source.publishedAt} · V{source.version}{source.supersededBy ? ` · 被${source.supersededBy}取代` : ''}</Text><Text fontFamily="mono" fontSize="xs" mt="2">{source.contentHash}</Text><Divider my="2" /><Text fontSize="xs">{source.chainOfCustody}</Text>{source.retractReason && <Text fontSize="xs" color="red.600" mt="1">撤回原因:{source.retractReason}</Text>}<Text fontSize="xs" color="blue.600" mt="1" wordBreak="break-all">{source.url}</Text>{!readOnly && source.status === '有效' && <Flex gap="2" mt="2"><Button size="xs" variant="outline" onClick={() => onUpgrade(factId, source)}>升版</Button><Button size="xs" variant="outline" colorScheme="red" onClick={() => onRetract(factId, source)}>撤回</Button></Flex>}</Box>)}</Box>
}

function AnnotationList({ fact, claimId }: { fact: ClaimFact; claimId: string }) {
  const addAnnotation = useClaimStore((state) => state.addAnnotation)
  const resolve = useClaimStore((state) => state.resolveAnnotation)
  const [text, setText] = useState('')
  return <Box><Flex gap="2" mb="3"><Input placeholder="添加事实核查批注" value={text} onChange={(event) => setText(event.target.value)} /><Button onClick={() => { addAnnotation(claimId, fact.id, { author: '陆衡', role: '事实核查员', content: text }); setText('') }}>添加</Button></Flex>{fact.annotations.map((item) => <Box key={item.id} borderLeftWidth="3px" borderColor={item.resolved ? 'green.400' : 'orange.400'} bg={item.resolved ? 'green.50' : 'orange.50'} p="3" mb="2"><Flex justify="space-between"><Text fontWeight="600" fontSize="sm">{item.role} {item.author}</Text><Button size="xs" variant="ghost" isDisabled={item.resolved} onClick={() => resolve(claimId, fact.id, item.id)}>{item.resolved ? '已解决' : '标记解决'}</Button></Flex><Text fontSize="sm" mt="2">{item.content}</Text><Text fontSize="xs" color="gray.500" mt="1">{item.createdAt.replace('T', ' ').slice(0, 16)}</Text></Box>)}</Box>
}
