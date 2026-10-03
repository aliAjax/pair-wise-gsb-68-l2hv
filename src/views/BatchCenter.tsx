import { Badge, Box, Button, Flex, Switch, Table, Tbody, Td, Text, Th, Thead, Tr, useToast } from '@chakra-ui/react'
import { useClaimStore } from '../store/useClaimStore'
import type { ChangeBatch } from '../types'

const batchColor: Record<ChangeBatch['status'], string> = {
  待提交: 'blue',
  已生效: 'green',
  冲突待复核: 'red',
  已解决: 'gray',
  写入失败: 'purple'
}

export function BatchCenter() {
  const state = useClaimStore()
  const toast = useToast()
  const batches = [...state.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const journal = [...state.journal].sort((a, b) => b.seq - a.seq)
  const incompleteTail = state.journal.some((entry) => !entry.complete)

  const commit = async (batchId: string) => {
    const result = await state.commitBatch(batchId)
    toast({ title: result.message, status: result.ok ? 'success' : result.conflict ? 'warning' : 'error' })
  }
  const resolve = async (batchId: string, mode: '保留当前值' | '采用冲突值') => {
    const result = await state.resolveBatch(batchId, mode)
    toast({ title: result.message, status: result.ok ? 'success' : 'error' })
  }
  const recover = () => {
    const result = state.recoverJournal()
    toast({ title: result.message, status: 'success' })
  }

  return <Box p="6" pb="16">
    <Flex justify="space-between" align="flex-start" mb="5">
      <Box>
        <Text fontSize="xs" color="gray.600">批次提交 / 冲突复核 / 写入恢复</Text>
        <Text fontSize="xl" fontWeight="700" mt="1">批次中心</Text>
        <Text fontSize="xs" color="gray.500" mt="1">同一批次多窗口提交时先到先生效，晚到保留冲突值等复核；当前日志序号 #{state.journalSeq}</Text>
      </Box>
      <Flex align="center" gap="3" bg="white" borderWidth="1px" p="3">
        <Box>
          <Text fontSize="sm" fontWeight="600">故障注入</Text>
          <Text fontSize="xs" color="gray.500">下次提交在写入中段失败</Text>
        </Box>
        <Switch colorScheme="red" isChecked={state.injectFailure} onChange={(event) => state.setInjectFailure(event.target.checked)} />
      </Flex>
    </Flex>

    {incompleteTail && <Flex justify="space-between" align="center" bg="red.50" borderWidth="1px" borderColor="red.300" p="3" mb="4">
      <Text fontSize="sm" color="red.700">检测到未完整落盘的写入日志，数据已回退保护，请从最后一个完整批次恢复重试。</Text>
      <Button size="sm" colorScheme="red" onClick={recover}>从最后完整批次恢复</Button>
    </Flex>}

    <Text fontWeight="700" mb="2">变更批次</Text>
    <Flex direction="column" gap="3" mb="6">
      {batches.length === 0 && <Box bg="white" borderWidth="1px" p="4"><Text fontSize="sm" color="gray.500">暂无批次。在主张详情页对来源执行升版或撤回后会生成批次。</Text></Box>}
      {batches.map((batch) => <Box key={batch.id} bg="white" borderWidth="1px" p="4">
        <Flex justify="space-between" align="flex-start">
          <Box>
            <Flex align="center" gap="2">
              <Text fontFamily="mono" fontSize="xs" color="gray.500">{batch.id}</Text>
              <Badge colorScheme="teal">{batch.kind}</Badge>
              <Badge colorScheme={batchColor[batch.status]}>{batch.status}</Badge>
              {batch.seq !== null && <Badge variant="outline">#{batch.seq}</Badge>}
            </Flex>
            <Text fontSize="sm" mt="2">{describeBatch(batch)}</Text>
            <Text fontSize="xs" color="gray.500" mt="1">{batch.createdBy} · {batch.createdAt.replace('T', ' ').slice(0, 16)} · 基于日志序号 #{batch.baseSeq}</Text>
          </Box>
          {batch.status === '待提交' && <Button size="sm" colorScheme="teal" onClick={() => void commit(batch.id)}>提交批次</Button>}
        </Flex>
        {batch.conflicts.length > 0 && <Box mt="3" borderTopWidth="1px" pt="3">
          <Text fontSize="sm" fontWeight="600" mb="2">保留的冲突值（{batch.conflicts.length}）</Text>
          {batch.conflicts.map((conflict) => <Flex key={conflict.id} fontSize="xs" bg="red.50" p="2" mb="1" gap="4">
            <Text fontWeight="600" minW="70px">{conflict.field}</Text>
            <Text flex="1">提交值：{conflict.attemptedValue}</Text>
            <Text flex="1" color="gray.600">当前值：{conflict.currentValue}</Text>
          </Flex>)}
          {batch.status === '冲突待复核' && <Flex gap="2" mt="2">
            <Button size="xs" variant="outline" onClick={() => void resolve(batch.id, '保留当前值')}>保留当前值</Button>
            <Button size="xs" colorScheme="red" onClick={() => void resolve(batch.id, '采用冲突值')}>采用冲突值重新提交</Button>
          </Flex>}
        </Box>}
      </Box>)}
    </Flex>

    <Flex justify="space-between" align="center" mb="2">
      <Text fontWeight="700">写入日志</Text>
      <Text fontSize="xs" color="gray.500">每个完整批次记录校验和与状态快照，恢复时截断不完整尾部</Text>
    </Flex>
    <Box bg="white" borderWidth="1px">
      <Table size="sm">
        <Thead><Tr><Th>序号</Th><Th>批次</Th><Th>类型</Th><Th>状态</Th><Th>校验和</Th><Th>时间</Th></Tr></Thead>
        <Tbody>
          {journal.length === 0 && <Tr><Td colSpan={6}><Text fontSize="sm" color="gray.500">暂无写入记录</Text></Td></Tr>}
          {journal.map((entry) => <Tr key={`${entry.seq}-${entry.batchId}`} bg={entry.complete ? undefined : 'red.50'}>
            <Td fontFamily="mono" fontSize="xs">#{entry.seq}</Td>
            <Td fontFamily="mono" fontSize="xs">{entry.batchId}</Td>
            <Td fontSize="xs">{entry.kind}</Td>
            <Td><Badge colorScheme={entry.complete ? 'green' : 'red'}>{entry.complete ? '完整' : '不完整'}</Badge></Td>
            <Td fontFamily="mono" fontSize="xs">{entry.checksum || '—'}</Td>
            <Td fontSize="xs">{entry.createdAt.replace('T', ' ').slice(0, 16)}</Td>
          </Tr>)}
        </Tbody>
      </Table>
    </Box>
  </Box>
}

function describeBatch(batch: ChangeBatch): string {
  if (batch.payload.sourceChange) {
    const change = batch.payload.sourceChange
    return batch.kind === '来源撤回'
      ? `撤回来源「${change.title}」V${change.baseVersion}：${change.note}`
      : `来源「${change.title}」V${change.baseVersion} → V${change.baseVersion + 1}（${change.newHash}）：${change.note}`
  }
  const items = batch.payload.reviewItems ?? []
  return `复核 ${items.length} 项已发布事实：${items.map((item) => `${item.claimId}/${item.factId}`).join('、') || '无'}`
}
