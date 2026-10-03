import { Badge, Box, Button, Flex, Text, useToast } from '@chakra-ui/react'
import { useNavigate } from 'react-router-dom'
import { useClaimStore } from '../store/useClaimStore'
import { preflightPublish } from '../services/api'

export function ReviewQueue() {
  const state = useClaimStore()
  const navigate = useNavigate()
  const toast = useToast()
  const reviewClaims = state.claims.filter((claim) => claim.status === '待编辑复核' || claim.facts.some((fact) => fact.annotations.some((note) => !note.resolved) || fact.invalidatedBy))
  const pendingBatches = state.batches.filter((batch) => batch.status === '待提交' || batch.status === '冲突待复核')
  const approve = (claimId: string) => {
    const result = state.transitionClaim(claimId, '已发布', '编辑完成事实、来源与相反证据复核。')
    toast({ title: result.message, status: result.ok ? 'success' : 'error' })
  }
  return <Box p="6" pb="16">
    <Flex justify="space-between" align="flex-start" mb="5">
      <Box><Text fontSize="xs" color="gray.600">编辑审阅 / 争议证据 / 发布前检查</Text><Text fontSize="xl" fontWeight="700" mt="1">复核队列</Text></Box>
      {pendingBatches.length > 0 && <Button size="sm" colorScheme="red" variant="outline" onClick={() => navigate('/batches')}>{pendingBatches.length} 个批次待处理</Button>}
    </Flex>
    <Flex direction="column" gap="3">{reviewClaims.map((claim) => {
      const unresolved = claim.facts.flatMap((fact) => fact.annotations.filter((note) => !note.resolved).map((note) => ({ fact, note })))
      const invalidated = claim.facts.filter((fact) => fact.invalidatedBy)
      const blockers = preflightPublish(claim).blocking
      return <Box key={claim.id} bg="white" borderWidth="1px" p="4">
        <Flex justify="space-between"><Box><Text fontFamily="mono" fontSize="xs" color="gray.500">{claim.id}</Text><Text fontWeight="700" mt="1">{claim.title}</Text></Box><Badge colorScheme={claim.status === '已发布' ? 'green' : 'orange'}>{claim.status}</Badge></Flex>
        <Flex mt="4" gap="4">
          <Box flex="1"><Text fontSize="sm" fontWeight="600">未解决批注 {unresolved.length}</Text>{unresolved.map(({ fact, note }) => <Box key={note.id} bg="orange.50" p="2" mt="2"><Text fontSize="xs" color="gray.500">{fact.id} · {note.author}</Text><Text fontSize="sm">{note.content}</Text></Box>)}</Box>
          <Box flex="1">
            <Text fontSize="sm" fontWeight="600">来源变更失效 {invalidated.length}</Text>
            {invalidated.map((fact) => <Flex key={fact.id} bg="red.50" p="2" mt="2" justify="space-between" align="center"><Box><Text fontSize="xs" color="gray.500">{fact.id}</Text><Text fontSize="sm">{fact.invalidatedBy!.reason}</Text></Box>{claim.status !== '已发布' && <Button size="xs" colorScheme="red" onClick={() => { state.recomputeFact(claim.id, fact.id, '宋卓'); toast({ title: '结论已重算', status: 'success' }) }}>重算</Button>}</Flex>)}
            <Text fontSize="sm" fontWeight="600" mt="3">发布阻断 {blockers.length}</Text>
            {blockers.map((item) => <Box key={item} bg="red.50" p="2" mt="2"><Text fontSize="sm">{item}</Text></Box>)}
          </Box>
        </Flex>
        {claim.status !== '已发布' && (blockers.length > 0
          ? <Button mt="4" size="sm" colorScheme="teal" isDisabled>发布前校验未通过</Button>
          : <Button mt="4" size="sm" colorScheme="teal" onClick={() => approve(claim.id)}>批准发布并锁定版本</Button>)}
      </Box>
    })}
    {reviewClaims.length === 0 && <Box bg="white" borderWidth="1px" p="4"><Text fontSize="sm" color="gray.500">当前没有待复核主张。</Text></Box>}
    </Flex>
  </Box>
}
