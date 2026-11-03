import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

const states = {
  PLANNED: ['已计划', 'default'], WAITING: ['待保障', 'warning'], ASSIGNED: ['已派单', 'info'],
  AWAITING_REVIEW: ['差额待确认', 'error'], COMPLETED: ['已完成', 'success'], CANCELLED: ['已取消', 'default'], DEPARTING: ['离港中', 'info']
};
const dateKey = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export default function FlightPlan({ flights, tasks, onEdit, onAllocate, onLocate }) {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('CURRENT');
  const [status, setStatus] = useState('');
  const [date, setDate] = useState('');
  const isHistory = (flight) => Boolean(flight.archived);
  const filtered = flights.filter((flight) => {
    const matchesText = `${flight.flight_no} ${flight.gate}`.toLowerCase().includes(search.trim().toLowerCase());
    return matchesText && (!status || flight.status === status) && (!date || dateKey(flight.departure_at) === date)
      && (scope === 'ALL' || (scope === 'HISTORY' ? isHistory(flight) : !isHistory(flight)));
  });
  return <Paper id="section-flights" variant="outlined" sx={{ p: 2.25, scrollMarginTop: '148px', minWidth: 0 }}>
    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1.5, gap: 1 }}>
      <Box><Typography variant="h6">航班计划</Typography><Typography variant="caption" color="text.secondary">默认显示当前未结束航班；过期且无活动工单的计划归入历史，已有活动工单始终保留。</Typography></Box>
      <Chip size="small" variant="outlined" label={`${filtered.length} / ${flights.length} 班`} />
    </Stack>
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mb: 1.5 }}>
      <TextField size="small" label="搜索航班或机位" value={search} onChange={(event) => { setSearch(event.target.value); if (event.target.value.trim()) setScope('ALL'); }} sx={{ minWidth: 180, flex: 1 }} />
      <TextField select size="small" label="计划范围" value={scope} onChange={(event) => setScope(event.target.value)} sx={{ minWidth: 140 }}><MenuItem value="CURRENT">当前计划</MenuItem><MenuItem value="HISTORY">历史与已结束</MenuItem><MenuItem value="ALL">全部日期</MenuItem></TextField>
      <TextField select size="small" label="航班状态" value={status} onChange={(event) => { setStatus(event.target.value); if (['COMPLETED', 'CANCELLED', 'DEPARTING'].includes(event.target.value)) setScope('HISTORY'); }} sx={{ minWidth: 140 }}><MenuItem value="">全部状态</MenuItem>{Object.entries(states).map(([value, [label]]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}</TextField>
      <TextField size="small" type="date" label="离港日期" value={date} onChange={(event) => { setDate(event.target.value); if (event.target.value) setScope('ALL'); }} slotProps={{ inputLabel: { shrink: true } }} />
    </Stack>
    <Box sx={{ overflowX: 'auto' }}><Table size="small" sx={{ minWidth: 720 }}>
      <TableHead><TableRow><TableCell>航班</TableCell><TableCell>机位</TableCell><TableCell>离港时间</TableCell><TableCell>需油量</TableCell><TableCell>优先级</TableCell><TableCell>状态</TableCell><TableCell align="right">操作</TableCell></TableRow></TableHead>
      <TableBody>{filtered.map((flight) => {
        const [label, color] = states[flight.status] ?? [flight.status, 'default'];
        const task = tasks.find((item) => item.flight_id === flight.id && item.state === 'PENDING');
        return <TableRow key={flight.id} hover>
          <TableCell><Button size="small" onClick={() => onLocate(flight.id)} sx={{ p: 0, minWidth: 0, fontWeight: 700 }}>{flight.flight_no}</Button></TableCell>
          <TableCell>{flight.gate}</TableCell><TableCell>{dateKey(flight.departure_at) ? new Date(flight.departure_at).toLocaleString('zh-CN', { hour12: false }) : '日期需修正'}</TableCell>
          <TableCell>计划 {flight.fuel_needed.toLocaleString()} L{flight.fuel_remaining !== flight.fuel_needed && <Typography variant="caption" display="block" color="text.secondary">剩余 {flight.fuel_remaining == null ? '未记录' : `${flight.fuel_remaining.toLocaleString()} L`}</Typography>}</TableCell><TableCell>{flight.priority === 3 ? '高' : flight.priority === 2 ? '中' : '低'}</TableCell>
          <TableCell><Chip size="small" label={label} color={color} variant="outlined" /></TableCell>
          <TableCell align="right"><Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}><Button size="small" onClick={() => onEdit(flight)}>调整</Button>{task && <Button size="small" variant="outlined" onClick={() => onAllocate(task)}>临时分配</Button>}</Stack></TableCell>
        </TableRow>;
      })}{filtered.length === 0 && <TableRow><TableCell colSpan={7}><Typography color="text.secondary" sx={{ py: 2 }}>当前筛选没有航班。可选择全部日期或修改搜索条件。</Typography></TableCell></TableRow>}</TableBody>
    </Table></Box>
  </Paper>;
}
