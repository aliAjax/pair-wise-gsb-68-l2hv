import { useState } from 'react'
import { Badge, Box, Button, Flex, Input, Table, Tbody, Td, Text, Th, Thead, Tr, useToast } from '@chakra-ui/react'
import { useClaimStore } from '../store/useClaimStore'

const batchColor: Record<string, string> = { 已生效: 'green', 冲突待复核: 'orange', 写入失败: 'red', 已采纳: 'teal', 已放弃: 'gray' }

export function AuditArchive() {
  const state = useClaimStore()
  const toast = useToast()
  const [keyword, setKeyword] = useState('')
  const rows = state.audit.filter((item) => `${item.claimId} ${item.action} ${item.operator} ${item.detail}`.toLowerCase().includes(keyword.toLowerCase()))
  const exportAll = () => {
    const payload = { generatedAt: new Date().toISOString(), claims: state.claims, versions: state.versions, audit: state.audit, batches: state.batches, reviewBatches: state.reviewBatches }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '事实核查档案与审计.json'; anchor.click(); URL.revokeObjectURL(url)
  }
  return <Box p="6" pb="16">
    <Flex justify="space-between" align="center" mb="5"><Box><Text fontSize="xs" color="gray.600">主张 / 证据替换 / 批次 / 发布版本</Text><Text fontSize="xl" fontWeight="700" mt="1">核查档案与审计</Text></Box><Button colorScheme="teal" onClick={exportAll}>导出全部档案</Button></Flex>
    <Flex gap="3" mb="3"><Input maxW="460px" placeholder="搜索主张、动作、操作人或说明" value={keyword} onChange={(event) => setKeyword(event.target.value)} /><Text alignSelf="center" fontSize="xs" color="gray.500">共{rows.length}条不可变审计事件</Text></Flex>
    <Box bg="white" borderWidth="1px"><Table size="sm"><Thead><Tr><Th>时间</Th><Th>主张</Th><Th>动作</Th><Th>操作人</Th><Th>说明</Th></Tr></Thead><Tbody>{rows.map((item) => <Tr key={item.id}><Td fontSize="xs">{item.createdAt.replace('T', ' ').slice(0, 16)}</Td><Td fontFamily="mono" fontSize="xs">{item.claimId}</Td><Td><Badge colorScheme={item.action.includes('相反') || item.action.includes('撤回') ? 'red' : item.action.includes('发布') || item.action.includes('生效') ? 'green' : item.action.includes('冲突') || item.action.includes('失败') || item.action.includes('失效') ? 'orange' : 'blue'}>{item.action}</Badge></Td><Td>{item.operator}</Td><Td fontSize="sm">{item.detail}</Td></Tr>)}</Tbody></Table></Box>
    <Box mt="5" bg="white" borderWidth="1px" p="4">
      <Flex justify="space-between" align="center" mb="3"><Box><Text fontWeight="700">批次日志与恢复</Text><Text fontSize="xs" color="gray.500" mt="1">已记录{state.batchSeq}个提交批次；写入失败时从最后一个完整批次恢复，失败批次可重试。</Text></Box><Button size="sm" variant="outline" colorScheme={state.failNextCommit ? 'red' : 'gray'} onClick={() => { state.armWriteFailureDrill(); toast({ title: '已就绪：下一次批次写入将模拟失败', status: 'warning' }) }}>{state.failNextCommit ? '演练已就绪' : '演练：下次写入失败'}</Button></Flex>
      <Table size="sm"><Thead><Tr><Th>批次</Th><Th>主张</Th><Th>窗口</Th><Th>基准版本</Th><Th>状态</Th><Th>时间</Th><Th /></Tr></Thead><Tbody>{state.batches.map((batch) => <Tr key={batch.id}><Td fontFamily="mono" fontSize="xs">{batch.id}#{batch.seq}</Td><Td fontFamily="mono" fontSize="xs">{batch.claimId}</Td><Td fontSize="xs">{batch.windowId}</Td><Td fontSize="xs">V{batch.baseVersion}</Td><Td><Badge colorScheme={batchColor[batch.status]}>{batch.status}</Badge></Td><Td fontSize="xs">{batch.createdAt.replace('T', ' ').slice(0, 16)}</Td><Td>{batch.status === '写入失败' && <Button size="xs" colorScheme="teal" onClick={() => { const result = state.retryFailedBatch(batch.id); toast({ title: result.message, status: result.ok ? 'success' : result.conflict ? 'warning' : 'error' }) }}>重试</Button>}</Td></Tr>)}{state.batches.length === 0 && <Tr><Td colSpan={7}><Text fontSize="xs" color="gray.500">暂无批次记录，在核查主张中暂存修改并提交批次后可见。</Text></Td></Tr>}</Tbody></Table>
    </Box>
    <Box mt="5" bg="white" borderWidth="1px" p="4"><Text fontWeight="700">版本差异原则</Text><Text fontSize="sm" color="gray.600" mt="2">被替换证据仍保留在版本记录中；发布版本不能隐藏相反证据、删除原始来源或覆盖既有批注。来源升版或撤回时，未发布结论失效重算，已发布版本冻结原样并另开复核批次；同一批次并发提交时先到者生效，晚到者的冲突值保留待复核。</Text></Box>
  </Box>
}
