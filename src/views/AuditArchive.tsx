import { useState } from 'react'
import { Badge, Box, Button, Flex, Input, Table, Tbody, Td, Text, Th, Thead, Tr } from '@chakra-ui/react'
import { useClaimStore } from '../store/useClaimStore'

export function AuditArchive() {
  const state = useClaimStore()
  const [keyword, setKeyword] = useState('')
  const rows = state.audit.filter((item) => `${item.claimId} ${item.action} ${item.operator} ${item.detail}`.toLowerCase().includes(keyword.toLowerCase()))
  const exportAll = () => {
    const payload = { generatedAt: new Date().toISOString(), claims: state.claims, versions: state.versions, audit: state.audit, sourceRegistry: state.sourceRegistry, batches: state.batches, journal: state.journal.map(({ snapshot, ...entry }) => ({ ...entry, snapshot: snapshot ? '（快照从略）' : undefined })), snapshots: state.snapshots }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '事实核查档案与审计.json'; anchor.click(); URL.revokeObjectURL(url)
  }
  return <Box p="6" pb="16">
    <Flex justify="space-between" align="center" mb="5"><Box><Text fontSize="xs" color="gray.600">主张 / 证据替换 / 批次 / 发布版本</Text><Text fontSize="xl" fontWeight="700" mt="1">核查档案与审计</Text></Box><Button colorScheme="teal" onClick={exportAll}>导出全部档案</Button></Flex>
    <Flex gap="3" mb="3"><Input maxW="460px" placeholder="搜索主张、动作、操作人或说明" value={keyword} onChange={(event) => setKeyword(event.target.value)} /><Text alignSelf="center" fontSize="xs" color="gray.500">共{rows.length}条不可变审计事件</Text></Flex>
    <Box bg="white" borderWidth="1px"><Table size="sm"><Thead><Tr><Th>时间</Th><Th>主张</Th><Th>动作</Th><Th>操作人</Th><Th>说明</Th></Tr></Thead><Tbody>{rows.map((item) => <Tr key={item.id}><Td fontSize="xs">{item.createdAt.replace('T', ' ').slice(0, 16)}</Td><Td fontFamily="mono" fontSize="xs">{item.claimId}</Td><Td><Badge colorScheme={item.action.includes('相反') || item.action.includes('冲突') || item.action.includes('失败') ? 'red' : item.action.includes('发布') || item.action.includes('生效') || item.action.includes('冻结') ? 'green' : item.action.includes('恢复') || item.action.includes('迁移') ? 'purple' : 'blue'}>{item.action}</Badge></Td><Td>{item.operator}</Td><Td fontSize="sm">{item.detail}</Td></Tr>)}</Tbody></Table></Box>

    <Text fontWeight="700" mt="6" mb="2">已发布冻结快照</Text>
    <Box bg="white" borderWidth="1px"><Table size="sm"><Thead><Tr><Th>主张</Th><Th>版本</Th><Th>冻结时间</Th><Th>说明</Th></Tr></Thead><Tbody>
      {state.snapshots.length === 0 && <Tr><Td colSpan={4}><Text fontSize="sm" color="gray.500">暂无冻结快照</Text></Td></Tr>}
      {state.snapshots.map((item) => <Tr key={item.id}><Td fontFamily="mono" fontSize="xs">{item.claimId}</Td><Td>V{item.version}</Td><Td fontSize="xs">{item.frozenAt.replace('T', ' ').slice(0, 16)}</Td><Td fontSize="sm">来源升版或撤回不回写本快照，变更另开复核批次</Td></Tr>)}
    </Tbody></Table></Box>

    <Box mt="5" bg="white" borderWidth="1px" p="4"><Text fontWeight="700">版本差异原则</Text><Text fontSize="sm" color="gray.600" mt="2">被替换证据仍保留在版本记录中；发布版本不能隐藏相反证据、删除原始来源或覆盖既有批注。来源升版或撤回后：未发布结论立即失效并需重算；已发布版本冻结原样，由复核批次另行处理。批次冲突保留冲突值待复核，写入失败从最后一个完整批次恢复重试。</Text></Box>
  </Box>
}
