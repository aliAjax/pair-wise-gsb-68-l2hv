import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Badge, Box, Button, Divider, Flex, FormControl, FormLabel, Grid, Input, Modal, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalOverlay, Select, Tab, TabList, TabPanel, TabPanels, Tabs, Text, Textarea, useDisclosure, useToast } from '@chakra-ui/react'
import { EvidenceGraph } from '../components/EvidenceGraph'
import { conclusionColor, statusColor, useClaimStore } from '../store/useClaimStore'
import { preflightPublish } from '../services/api'
import type { ClaimFact, EvidenceKind, FactConclusion, SourceRecord } from '../types'

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
  const changeModal = useDisclosure()
  const snapshotModal = useDisclosure()
  const [sourceForm, setSourceForm] = useState<Omit<SourceRecord, 'id' | 'capturedAt' | 'version' | 'sourceKey'>>({ title: '', url: '', publisher: '', publishedAt: '2026-09-29', kind: '原始证据', chainOfCustody: '', contentHash: '' })
  const [counterSource, setCounterSource] = useState(false)
  const [transitionNote, setTransitionNote] = useState('')
  const [changeTarget, setChangeTarget] = useState<{ mode: '来源升版' | '来源撤回'; source: SourceRecord } | null>(null)
  const [changeForm, setChangeForm] = useState({ newHash: '', note: '' })
  useEffect(() => { if (!selectedFactId && claim?.facts[0]) setSelectedFactId(claim.facts[0].id) }, [selectedFactId, claim])
  if (!claim) return <Box p="10">未找到核查主张</Box>

  const frozen = claim.status === '已发布'
  const snapshot = state.snapshots.find((item) => item.claimId === claim.id && item.version === claim.version) ?? state.snapshots.find((item) => item.claimId === claim.id)
  const blockers = preflightPublish(claim).blocking
  const invalidatedCount = claim.facts.filter((fact) => fact.invalidatedBy).length

  const setFact = (patch: Partial<ClaimFact>) => { if (selectedFact && !frozen) state.updateFact(claim.id, selectedFact.id, patch) }
  const addSource = () => {
    if (!selectedFact || !sourceForm.title || !sourceForm.url) return
    state.addSource(claim.id, selectedFact.id, sourceForm, counterSource)
    sourceModal.onClose()
    toast({ title: '证据已加入关系图', status: 'success' })
  }
  const transition = (status: typeof claim.status) => {
    const result = state.transitionClaim(claim.id, status, transitionNote || `由${claim.status}流转至${status}`)
    toast({ title: result.message, status: result.ok ? 'success' : 'error' })
    if (result.ok) versionModal.onClose()
  }
  const submitChange = async () => {
    if (!changeTarget) return
    const result = await state.submitSourceChange(changeTarget.mode, {
      sourceKey: changeTarget.source.sourceKey,
      title: changeTarget.source.title,
      newHash: changeForm.newHash || changeTarget.source.contentHash,
      note: changeForm.note || (changeTarget.mode === '来源撤回' ? '来源方撤回原文' : '来源发布新版')
    }, '陆衡')
    toast({ title: result.message, status: result.ok ? 'success' : result.conflict ? 'warning' : 'error' })
    if (result.ok || result.conflict) { changeModal.onClose(); setChangeForm({ newHash: '', note: '' }) }
  }
  const openChange = (mode: '来源升版' | '来源撤回', source: SourceRecord) => { setChangeTarget({ mode, source }); changeModal.onOpen() }
  const exportArchive = () => {
    const versions = state.versions.filter((item) => item.claimId === claim.id)
    const audit = state.audit.filter((item) => item.claimId === claim.id)
    const blob = new Blob([JSON.stringify({ claim, versions, audit, snapshots: state.snapshots.filter((item) => item.claimId === claim.id) }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${claim.id}-核查档案.json`; anchor.click(); URL.revokeObjectURL(url)
  }

  return <Box p="6" pb="16">
    <Flex justify="space-between" align="flex-start" mb="4">
      <Box>
        <Flex align="center" gap="2">
          <Text fontSize="xs" color="gray.600">{claim.id} · {claim.reporter} / {claim.editor || '未指派编辑'} · V{claim.version}</Text>
          <Badge colorScheme={statusColor[claim.status]}>{claim.status}</Badge>
          {claim.migratedFromLegacy && <Badge colorScheme="purple">旧数据迁移</Badge>}
        </Flex>
        <Text fontSize="xl" fontWeight="700" mt="1">{claim.title}</Text>
        <Text color="gray.600" fontSize="sm" mt="2" maxW="760px">{claim.summary}</Text>
      </Box>
      <Flex gap="2">
        {snapshot && <Button variant="outline" onClick={snapshotModal.onOpen}>冻结快照 V{snapshot.version}</Button>}
        <Button variant="outline" onClick={exportArchive}>导出档案</Button>
        {!frozen && <Button colorScheme="teal" onClick={versionModal.onOpen}>状态与版本</Button>}
      </Flex>
    </Flex>

    {frozen && <Box bg="green.50" borderWidth="1px" borderColor="green.300" p="3" mb="4">
      <Text fontSize="sm" color="green.800">已发布版本已冻结，内容不可直接修改；来源升版或撤回不会回写本版本，系统会另开复核批次处理。</Text>
    </Box>}
    {claim.status === '待核' && <Box bg="purple.50" borderWidth="1px" borderColor="purple.300" p="3" mb="4">
      <Text fontSize="sm" color="purple.800">旧数据升级迁入：本主张没有来源链，先进入待核，补齐来源链并完成核验前不能直接发布。</Text>
    </Box>}
    {invalidatedCount > 0 && <Flex justify="space-between" align="center" bg="orange.50" borderWidth="1px" borderColor="orange.300" p="3" mb="4">
      <Text fontSize="sm" color="orange.800">{invalidatedCount} 项事实的来源已升版或撤回，结论已失效，需重算后才能发布。</Text>
    </Flex>}

    <EvidenceGraph facts={claim.facts} />
    <Grid mt="4" templateColumns="320px 1fr" gap="4" alignItems="start">
      <Box bg="white" borderWidth="1px" p="3">
        <Flex justify="space-between" align="center" mb="3"><Text fontWeight="700">可验证事实树</Text><Badge>{claim.facts.length}</Badge></Flex>
        {claim.facts.map((fact) => <Box key={fact.id} as="button" textAlign="left" w="100%" p="3" mb="2" borderWidth="1px" borderColor={fact.id === selectedFact?.id ? 'teal.600' : 'gray.200'} bg={fact.id === selectedFact?.id ? 'teal.50' : 'white'} onClick={() => setSelectedFactId(fact.id)}>
          <Flex justify="space-between" gap="2">
            <Text fontSize="xs" color="gray.500">{fact.id}</Text>
            <Flex gap="1">
              {fact.invalidatedBy && <Badge colorScheme="red">结论失效</Badge>}
              <Badge colorScheme={conclusionColor[fact.conclusion]}>{fact.conclusion}</Badge>
            </Flex>
          </Flex>
          <Text fontSize="sm" mt="2" fontWeight="600">{fact.text}</Text>
          <Text fontSize="xs" color="gray.500" mt="2">置信度 {fact.confidence}% · 疑点 {fact.unresolved.length}</Text>
        </Box>)}
        {!frozen && <Flex mt="3" gap="2"><Input size="sm" placeholder="拆出新的可验证事实" value={factText} onChange={(event) => setFactText(event.target.value)} /><Button size="sm" colorScheme="teal" onClick={() => { state.addFact(claim.id, factText); setFactText('') }}>添加</Button></Flex>}
      </Box>
      {selectedFact && <Box bg="white" borderWidth="1px" p="4">
        <Flex justify="space-between" align="flex-start">
          <Box><Text fontSize="xs" color="gray.500">{selectedFact.id}</Text><Text fontWeight="700" mt="1">{selectedFact.text}</Text></Box>
          <Badge colorScheme={conclusionColor[selectedFact.conclusion]}>{selectedFact.conclusion}</Badge>
        </Flex>
        {selectedFact.invalidatedBy && <Flex justify="space-between" align="center" bg="red.50" borderWidth="1px" borderColor="red.200" p="3" mt="3">
          <Box>
            <Text fontSize="sm" fontWeight="600" color="red.700">结论已失效：{selectedFact.invalidatedBy.reason}</Text>
            <Text fontSize="xs" color="red.600" mt="1">重算将按当前有效来源重新推导结论与置信度，原结论留档于版本记录。</Text>
          </Box>
          {!frozen && <Button size="sm" colorScheme="red" onClick={() => { state.recomputeFact(claim.id, selectedFact.id, '陆衡'); toast({ title: '结论已按当前有效来源重算', status: 'success' }) }}>重算结论</Button>}
        </Flex>}
        <Grid templateColumns="1fr 1fr 1fr" gap="3" mt="4">
          <FormControl isDisabled={frozen || !!selectedFact.invalidatedBy}><FormLabel fontSize="xs">事实结论</FormLabel><Select size="sm" value={selectedFact.conclusion} onChange={(event) => setFact({ conclusion: event.target.value as FactConclusion })}>{['已证实', '部分属实', '证据不足', '不实'].map((value) => <option key={value}>{value}</option>)}</Select></FormControl>
          <FormControl isDisabled={frozen || !!selectedFact.invalidatedBy}><FormLabel fontSize="xs">置信程度 {selectedFact.confidence}%</FormLabel><Input size="sm" type="range" min="0" max="100" value={selectedFact.confidence} onChange={(event) => setFact({ confidence: Number(event.target.value) })} /></FormControl>
          <FormControl isDisabled={frozen}><FormLabel fontSize="xs">未解决疑点</FormLabel><Input size="sm" value={selectedFact.unresolved.join('；')} onChange={(event) => setFact({ unresolved: event.target.value ? event.target.value.split('；') : [] })} /></FormControl>
        </Grid>
        <Tabs mt="5" colorScheme="teal">
          <TabList><Tab>支持证据 {selectedFact.sources.length}</Tab><Tab>相反证据 {selectedFact.counterSources.length}</Tab><Tab>批注 {selectedFact.annotations.length}</Tab><Tab>来源时间线</Tab></TabList>
          <TabPanels>
            <TabPanel px="0"><EvidenceList sources={selectedFact.sources} onAdd={() => { setCounterSource(false); sourceModal.onOpen() }} onChange={openChange} frozen={frozen} /></TabPanel>
            <TabPanel px="0"><EvidenceList sources={selectedFact.counterSources} onAdd={() => { setCounterSource(true); sourceModal.onOpen() }} onChange={openChange} frozen={frozen} counter /></TabPanel>
            <TabPanel px="0"><AnnotationList fact={selectedFact} claimId={claim.id} frozen={frozen} /></TabPanel>
            <TabPanel px="0"><Box borderLeftWidth="2px" borderColor="gray.300" pl="4">{[...selectedFact.sources, ...selectedFact.counterSources].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).map((source) => <Box key={source.id} mb="4"><Text fontSize="xs" color="gray.500">{source.publishedAt} · {source.kind}</Text><Text fontWeight="600" mt="1">{source.title}</Text><Text fontSize="sm" color="gray.600">{source.publisher} · 留档 {source.capturedAt.replace('T', ' ').slice(0, 16)}</Text></Box>)}</Box></TabPanel>
          </TabPanels>
        </Tabs>
      </Box>}
    </Grid>

    <Modal isOpen={sourceModal.isOpen} onClose={sourceModal.onClose} size="xl"><ModalOverlay /><ModalContent><ModalHeader>{counterSource ? '关联相反证据' : '关联支持证据'}</ModalHeader><ModalCloseButton /><ModalBody><Grid templateColumns="1fr 1fr" gap="3"><FormControl><FormLabel>来源标题</FormLabel><Input value={sourceForm.title} onChange={(event) => setSourceForm({ ...sourceForm, title: event.target.value })} /></FormControl><FormControl><FormLabel>公开地址</FormLabel><Input value={sourceForm.url} onChange={(event) => setSourceForm({ ...sourceForm, url: event.target.value })} /></FormControl><FormControl><FormLabel>发布机构</FormLabel><Input value={sourceForm.publisher} onChange={(event) => setSourceForm({ ...sourceForm, publisher: event.target.value })} /></FormControl><FormControl><FormLabel>证据类型</FormLabel><Select value={sourceForm.kind} onChange={(event) => setSourceForm({ ...sourceForm, kind: event.target.value as EvidenceKind })}>{['原始证据', '二次来源', '待证信息'].map((value) => <option key={value}>{value}</option>)}</Select></FormControl><FormControl><FormLabel>内容哈希</FormLabel><Input placeholder="sha256:..." value={sourceForm.contentHash} onChange={(event) => setSourceForm({ ...sourceForm, contentHash: event.target.value })} /></FormControl><FormControl><FormLabel>留档说明</FormLabel><Input value={sourceForm.chainOfCustody} onChange={(event) => setSourceForm({ ...sourceForm, chainOfCustody: event.target.value })} /></FormControl></Grid></ModalBody><ModalFooter><Button variant="ghost" mr="3" onClick={sourceModal.onClose}>取消</Button><Button colorScheme="teal" isDisabled={!sourceForm.title || !sourceForm.url} onClick={addSource}>加入证据关系图</Button></ModalFooter></ModalContent></Modal>

    <Modal isOpen={changeModal.isOpen} onClose={changeModal.onClose}><ModalOverlay /><ModalContent>
      <ModalHeader>{changeTarget?.mode === '来源撤回' ? '撤回来源' : '来源升版'}</ModalHeader><ModalCloseButton />
      <ModalBody>
        <Text fontSize="sm" mb="1">{changeTarget?.source.title}</Text>
        <Text fontSize="xs" color="gray.500" mb="4">提交后生成变更批次：未发布主张的相关结论立即失效待重算；已发布版本保持冻结，另开复核批次。两个窗口同时提交同一批次时，只有先到的生效。</Text>
        {changeTarget?.mode === '来源升版' && <FormControl mb="3"><FormLabel fontSize="sm">新版内容哈希</FormLabel><Input placeholder="sha256:..." value={changeForm.newHash} onChange={(event) => setChangeForm({ ...changeForm, newHash: event.target.value })} /></FormControl>}
        <FormControl><FormLabel fontSize="sm">{changeTarget?.mode === '来源撤回' ? '撤回依据' : '升版说明'}</FormLabel><Textarea rows={3} value={changeForm.note} onChange={(event) => setChangeForm({ ...changeForm, note: event.target.value })} /></FormControl>
      </ModalBody>
      <ModalFooter><Button variant="ghost" mr="3" onClick={changeModal.onClose}>取消</Button><Button colorScheme={changeTarget?.mode === '来源撤回' ? 'red' : 'teal'} onClick={() => void submitChange()}>提交变更批次</Button></ModalFooter>
    </ModalContent></Modal>

    <Modal isOpen={snapshotModal.isOpen} onClose={snapshotModal.onClose} size="xl"><ModalOverlay /><ModalContent>
      <ModalHeader>已发布冻结快照{snapshot ? ` · V${snapshot.version}` : ''}</ModalHeader><ModalCloseButton />
      <ModalBody>
        <Text fontSize="xs" color="gray.500" mb="3">冻结于 {snapshot?.frozenAt.replace('T', ' ').slice(0, 16)}，来源后续升版或撤回不回写本快照。</Text>
        <Box as="pre" bg="gray.50" p="3" fontSize="xs" overflowX="auto" maxH="360px" overflowY="auto">{JSON.stringify(snapshot?.snapshot, null, 2)}</Box>
      </ModalBody>
      <ModalFooter><Button onClick={snapshotModal.onClose}>关闭</Button></ModalFooter>
    </ModalContent></Modal>

    <Modal isOpen={versionModal.isOpen} onClose={versionModal.onClose}><ModalOverlay /><ModalContent><ModalHeader>状态流转与版本说明</ModalHeader><ModalCloseButton /><ModalBody>
      <FormControl mb="4"><FormLabel>版本变更说明</FormLabel><Textarea rows={4} value={transitionNote} onChange={(event) => setTransitionNote(event.target.value)} /></FormControl>
      {blockers.length > 0 && <Box bg="red.50" p="3" mb="3"><Text fontSize="sm" fontWeight="600" color="red.700" mb="1">发布前校验未通过</Text>{blockers.map((item) => <Text key={item} fontSize="xs" color="red.600">· {item}</Text>)}</Box>}
      <Text fontSize="xs" color="gray.500">待编辑复核需要至少一项事实；发布会拦截证据不足且有疑点、缺少来源链、结论失效未重算的事实。</Text>
    </ModalBody><ModalFooter>
      {claim.status === '待核' && <Button mr="2" onClick={() => transition('核查中')}>开始核验</Button>}
      <Button mr="2" onClick={() => transition('待编辑复核')}>提交编辑复核</Button>
      <Button colorScheme="teal" isDisabled={blockers.length > 0} onClick={() => transition('已发布')}>发布正式版本</Button>
    </ModalFooter></ModalContent></Modal>
  </Box>
}

function EvidenceList({ sources, onAdd, onChange, frozen, counter = false }: { sources: SourceRecord[]; onAdd: () => void; onChange: (mode: '来源升版' | '来源撤回', source: SourceRecord) => void; frozen: boolean; counter?: boolean }) {
  const registry = useClaimStore((state) => state.sourceRegistry)
  const latest = (sourceKey: string) => registry.filter((item) => item.sourceKey === sourceKey && item.status === '有效').sort((a, b) => b.version - a.version)[0]
  return <Box>
    <Flex justify="space-between" mb="3">
      <Text fontSize="sm" color="gray.600">{counter ? '相反证据与支持证据并列保留' : '按原始证据、二次来源、待证信息分类'}</Text>
      {!frozen && <Button size="sm" colorScheme={counter ? 'red' : 'teal'} variant="outline" onClick={onAdd}>{counter ? '关联相反证据' : '关联支持证据'}</Button>}
    </Flex>
    {sources.map((source) => {
      const active = latest(source.sourceKey)
      const behind = active && active.version > source.version
      return <Box key={source.id} borderWidth="1px" borderColor={source.retracted ? 'red.300' : 'gray.200'} p="3" mb="2">
        <Flex justify="space-between" gap="2">
          <Text fontWeight="600">{source.title}</Text>
          <Flex gap="1">
            {source.retracted && <Badge colorScheme="red">已撤回</Badge>}
            {behind && !source.retracted && <Badge colorScheme="orange">已有 V{active.version}</Badge>}
            <Badge colorScheme={source.kind === '原始证据' ? 'green' : source.kind === '二次来源' ? 'orange' : 'gray'}>{source.kind}</Badge>
          </Flex>
        </Flex>
        <Text fontSize="xs" color="gray.600" mt="2">{source.publisher} · {source.publishedAt} · 留档 V{source.version}{active ? ` / 注册表最新 V${active.version}` : ' / 注册表无有效版本'}</Text>
        <Text fontFamily="mono" fontSize="xs" mt="2">{source.contentHash}</Text>
        <Divider my="2" />
        <Text fontSize="xs">{source.chainOfCustody}</Text>
        <Flex justify="space-between" align="center" mt="1">
          <Text fontSize="xs" color="blue.600" wordBreak="break-all">{source.url}</Text>
          {!source.retracted && <Flex gap="1" ml="2">
            <Button size="xs" variant="outline" onClick={() => onChange('来源升版', source)}>升版</Button>
            <Button size="xs" variant="outline" colorScheme="red" onClick={() => onChange('来源撤回', source)}>撤回</Button>
          </Flex>}
        </Flex>
      </Box>
    })}
  </Box>
}

function AnnotationList({ fact, claimId, frozen }: { fact: ClaimFact; claimId: string; frozen: boolean }) {
  const addAnnotation = useClaimStore((state) => state.addAnnotation)
  const resolve = useClaimStore((state) => state.resolveAnnotation)
  const [text, setText] = useState('')
  return <Box>
    {!frozen && <Flex gap="2" mb="3"><Input placeholder="添加事实核查批注" value={text} onChange={(event) => setText(event.target.value)} /><Button onClick={() => { addAnnotation(claimId, fact.id, { author: '陆衡', role: '事实核查员', content: text }); setText('') }}>添加</Button></Flex>}
    {fact.annotations.map((item) => <Box key={item.id} borderLeftWidth="3px" borderColor={item.resolved ? 'green.400' : 'orange.400'} bg={item.resolved ? 'green.50' : 'orange.50'} p="3" mb="2"><Flex justify="space-between"><Text fontWeight="600" fontSize="sm">{item.role} {item.author}</Text>{!frozen && <Button size="xs" variant="ghost" isDisabled={item.resolved} onClick={() => resolve(claimId, fact.id, item.id)}>{item.resolved ? '已解决' : '标记解决'}</Button>}</Flex><Text fontSize="sm" mt="2">{item.content}</Text><Text fontSize="xs" color="gray.500" mt="1">{item.createdAt.replace('T', ' ').slice(0, 16)}</Text></Box>)}
  </Box>
}
