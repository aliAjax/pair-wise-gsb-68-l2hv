import { Badge, Box, Button, Flex, Text, useToast } from '@chakra-ui/react'
import { useClaimStore } from '../store/useClaimStore'

export function ReviewQueue() {
  const state = useClaimStore()
  const toast = useToast()
  const reviewClaims = state.claims.filter((claim) => claim.status === '待编辑复核' || claim.facts.some((fact) => fact.annotations.some((note) => !note.resolved)))
  const reviewBatches = state.reviewBatches.filter((item) => item.status === '待复核')
  const conflictBatches = state.batches.filter((item) => item.status === '冲突待复核')
  const failedBatches = state.batches.filter((item) => item.status === '写入失败')
  const approve = (claimId: string) => {
    const result = state.transitionClaim(claimId, '已发布', '编辑完成事实、来源与相反证据复核。')
    toast({ title: result.message, status: result.ok ? 'success' : 'error' })
  }
  const claimTitle = (claimId: string) => state.claims.find((item) => item.id === claimId)?.title ?? claimId
  const factText = (claimId: string, factId: string) => state.claims.find((item) => item.id === claimId)?.facts.find((item) => item.id === factId)?.text ?? factId
  return <Box p="6" pb="16">
    <Box mb="5"><Text fontSize="xs" color="gray.600">编辑审阅 / 来源复核 / 冲突与恢复</Text><Text fontSize="xl" fontWeight="700" mt="1">复核队列</Text></Box>

    {failedBatches.length > 0 && <Box mb="5"><Text fontWeight="700" mb="2">写入失败批次 {failedBatches.length}</Text><Flex direction="column" gap="3">{failedBatches.map((batch) => <Box key={batch.id} bg="white" borderWidth="1px" borderColor="red.300" p="4">
      <Flex justify="space-between"><Box><Text fontFamily="mono" fontSize="xs" color="gray.500">{batch.id} · {batch.windowId} · 基于V{batch.baseVersion}</Text><Text fontWeight="700" mt="1">{claimTitle(batch.claimId)}</Text><Text fontSize="sm" color="gray.600" mt="1">已从最后一个完整批次恢复，{batch.mutations.length}项修改待重试写入。</Text></Box><Badge colorScheme="red" h="fit-content">写入失败</Badge></Flex>
      <Button mt="3" size="sm" colorScheme="teal" onClick={() => { const result = state.retryFailedBatch(batch.id); toast({ title: result.message, status: result.ok ? 'success' : result.conflict ? 'warning' : 'error' }) }}>从完整批次恢复并重试</Button>
    </Box>)}</Flex></Box>}

    {reviewBatches.length > 0 && <Box mb="5"><Text fontWeight="700" mb="2">来源变更复核批次 {reviewBatches.length}</Text><Flex direction="column" gap="3">{reviewBatches.map((batch) => <Box key={batch.id} bg="white" borderWidth="1px" borderColor="blue.300" p="4">
      <Flex justify="space-between"><Box><Text fontFamily="mono" fontSize="xs" color="gray.500">{batch.id} · 冻结V{batch.frozenVersion}</Text><Text fontWeight="700" mt="1">{claimTitle(batch.claimId)}</Text></Box><Badge colorScheme={batch.trigger === '来源撤回' ? 'red' : 'blue'} h="fit-content">{batch.trigger}</Badge></Flex>
      <Text fontSize="sm" color="gray.600" mt="2">来源「{batch.sourceTitle}」{batch.trigger === '来源撤回' ? `被撤回：${batch.retractReason}` : '已升版'}，发布版本V{batch.frozenVersion}保持冻结，涉及事实：{batch.factIds.map((id) => factText(batch.claimId, id)).join('；')}</Text>
      <Flex gap="2" mt="3">
        <Button size="sm" colorScheme="teal" variant="outline" onClick={() => { state.resolveReviewBatch(batch.id, '维持发布'); toast({ title: '已结案：维持发布，冻结版本不变', status: 'success' }) }}>维持发布</Button>
        <Button size="sm" colorScheme="orange" variant="outline" onClick={() => { state.resolveReviewBatch(batch.id, '退回重核'); toast({ title: '已退回重核：来源变更已应用，结论失效重算', status: 'success' }) }}>退回重核</Button>
        <Button size="sm" colorScheme="red" variant="outline" onClick={() => { state.resolveReviewBatch(batch.id, '撤回主张'); toast({ title: '已结案：主张撤回', status: 'success' }) }}>撤回主张</Button>
      </Flex>
    </Box>)}</Flex></Box>}

    {conflictBatches.length > 0 && <Box mb="5"><Text fontWeight="700" mb="2">冲突批次（晚到提交） {conflictBatches.length}</Text><Flex direction="column" gap="3">{conflictBatches.map((batch) => {
      const claim = state.claims.find((item) => item.id === batch.claimId)
      return <Box key={batch.id} bg="white" borderWidth="1px" borderColor="orange.300" p="4">
        <Flex justify="space-between"><Box><Text fontFamily="mono" fontSize="xs" color="gray.500">{batch.id} · {batch.windowId} · 基于V{batch.baseVersion}，当前V{claim?.version ?? '-'}</Text><Text fontWeight="700" mt="1">{claimTitle(batch.claimId)}</Text></Box><Badge colorScheme="orange" h="fit-content">冲突待复核</Badge></Flex>
        <Box mt="2">{batch.mutations.map((mutation) => <Box key={mutation.factId} bg="orange.50" p="2" mt="2"><Text fontSize="xs" color="gray.500">{mutation.factId} · {factText(batch.claimId, mutation.factId)}</Text><Text fontSize="sm">保留的冲突值：{[mutation.patch.conclusion && `结论→${mutation.patch.conclusion}`, mutation.patch.confidence !== undefined && `置信度→${mutation.patch.confidence}%`, mutation.patch.unresolved && `疑点→${mutation.patch.unresolved.join('；') || '（清空）'}`].filter(Boolean).join('，')}</Text></Box>)}</Box>
        <Flex gap="2" mt="3">
          <Button size="sm" colorScheme="teal" onClick={() => { state.resolveConflictBatch(batch.id, '采纳'); toast({ title: '冲突值已采纳并生效', status: 'success' }) }}>采纳冲突值</Button>
          <Button size="sm" variant="outline" onClick={() => { state.resolveConflictBatch(batch.id, '放弃'); toast({ title: '已放弃冲突值，保留当前生效值', status: 'info' }) }}>放弃</Button>
        </Flex>
      </Box>
    })}</Flex></Box>}

    <Text fontWeight="700" mb="2">编辑复核队列 {reviewClaims.length}</Text>
    <Flex direction="column" gap="3">{reviewClaims.map((claim) => {
      const unresolved = claim.facts.flatMap((fact) => fact.annotations.filter((note) => !note.resolved).map((note) => ({ fact, note })))
      const blocking = claim.facts.filter((fact) => fact.conclusion === '证据不足' && fact.unresolved.length)
      return <Box key={claim.id} bg="white" borderWidth="1px" p="4">
        <Flex justify="space-between"><Box><Text fontFamily="mono" fontSize="xs" color="gray.500">{claim.id}</Text><Text fontWeight="700" mt="1">{claim.title}</Text></Box><Badge colorScheme="orange">{claim.status}</Badge></Flex>
        <Flex mt="4" gap="4"><Box flex="1"><Text fontSize="sm" fontWeight="600">未解决批注 {unresolved.length}</Text>{unresolved.map(({ fact, note }) => <Box key={note.id} bg="orange.50" p="2" mt="2"><Text fontSize="xs" color="gray.500">{fact.id} · {note.author}</Text><Text fontSize="sm">{note.content}</Text></Box>)}</Box><Box flex="1"><Text fontSize="sm" fontWeight="600">发布阻断 {blocking.length}</Text>{blocking.map((fact) => <Box key={fact.id} bg="red.50" p="2" mt="2"><Text fontSize="xs" color="gray.500">{fact.id}</Text><Text fontSize="sm">{fact.unresolved.join('；')}</Text></Box>)}</Box></Flex>
        {blocking.length > 0 && <Button mt="4" size="sm" colorScheme="teal" isDisabled onClick={() => approve(claim.id)}>发布前校验未通过</Button>}
        {blocking.length === 0 && <Button mt="4" size="sm" colorScheme="teal" onClick={() => approve(claim.id)}>批准发布并锁定版本</Button>}
      </Box>
    })}</Flex>
  </Box>
}
