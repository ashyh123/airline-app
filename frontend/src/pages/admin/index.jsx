import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { apiHeaders } from 'utils/auth';

const API = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8080/api';
const example = 'flightNo,gate,departureAt,fuelNeeded,priority,x,y\nCA2026,E08,2026-09-14T12:30:00+00:00,6800,2,14,9';

function csvRows(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/); const keys = header.split(',').map((cell) => cell.trim());
  return lines.filter(Boolean).map((line) => Object.fromEntries(keys.map((key, index) => [key, line.split(',')[index]?.trim()])));
}

export default function AdminWorkspace() {
  const [flights, setFlights] = useState([]); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(true); const [importing, setImporting] = useState(false);
  const [broadcasting, setBroadcasting] = useState(false); const [broadcastTitle, setBroadcastTitle] = useState(''); const [broadcastContent, setBroadcastContent] = useState(''); const [broadcastLevel, setBroadcastLevel] = useState('INFO'); const [broadcastFlight, setBroadcastFlight] = useState('');
  const load = useCallback(async () => { try { const response = await fetch(`${API}/admin/flights`, { headers: apiHeaders() }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setFlights(data.flights); setError(''); } catch (err) { setError(err.message); } finally { setLoading(false); } }, []);
  useEffect(() => { load(); }, [load]);
  async function importFile(event) {
    const file = event.target.files?.[0]; if (!file) return; setImporting(true);
    try { const content = await file.text(); const items = file.name.toLowerCase().endsWith('.json') ? JSON.parse(content) : csvRows(content); const response = await fetch(`${API}/admin/flights/import`, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify({ flights: items }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setFlights(data.flights); setMessage(`${data.message}${data.rejected.length ? `；拒绝 ${data.rejected.length} 条格式错误数据` : ''}`); setError(''); } catch (err) { setError(`导入失败：${err.message}`); } finally { setImporting(false); event.target.value = ''; }
  }
  async function sendBroadcast(event) {
    event.preventDefault(); setBroadcasting(true);
    try { const response = await fetch(`${API}/admin/broadcasts`, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify({ title: broadcastTitle, content: broadcastContent, level: broadcastLevel, flightId: broadcastFlight || null }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setMessage(data.message); setBroadcastTitle(''); setBroadcastContent(''); setBroadcastLevel('INFO'); setBroadcastFlight(''); setError(''); } catch (err) { setError(`播报发送失败：${err.message}`); } finally { setBroadcasting(false); }
  }
  if (loading) return <Box sx={{ minHeight: 360, display: 'grid', placeItems: 'center' }}><CircularProgress /></Box>;
  return <Stack spacing={2.5}><Box><Typography variant="h4">系统管理、航班导入与运行播报</Typography><Typography color="text.secondary" sx={{ mt: .5 }}>管理员可批量导入或更新航班计划；导入、航班动态和现场情况都会发送给调度员。</Typography></Box>{error && <Alert severity="error">{error}</Alert>}{message && <Alert severity="success" onClose={() => setMessage('')}>{message}</Alert>}<Paper variant="outlined" sx={{ p: 2.5 }}><Typography variant="h6">导入航班数据</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>支持 UTF-8 的 CSV 或 JSON 数组。CSV 表头：flightNo、gate、departureAt、fuelNeeded、priority、x、y。</Typography><Stack direction="row" spacing={1.5} sx={{ mt: 2, alignItems: 'center', flexWrap: 'wrap' }}><Button component="label" variant="contained" disabled={importing}>{importing ? '导入中…' : '选择 CSV 或 JSON 文件'}<input hidden type="file" accept=".csv,.json,application/json,text/csv" onChange={importFile} /></Button><Typography variant="caption" color="text.secondary">示例：{example}</Typography></Stack></Paper><Paper component="form" onSubmit={sendBroadcast} variant="outlined" sx={{ p: 2.5 }}><Typography variant="h6">现场情况播报</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>发布后会在调度员右上角“运行通知”中出现，用于传达临时机位调整、天气影响、加油准备或其他现场情况。</Typography><Stack spacing={1.5} sx={{ mt: 2 }}><TextField required label="播报标题" value={broadcastTitle} onChange={(event) => setBroadcastTitle(event.target.value)} placeholder="例如：B 区机坪临时管制" inputProps={{ maxLength: 40 }} /><TextField required label="播报内容" multiline minRows={3} value={broadcastContent} onChange={(event) => setBroadcastContent(event.target.value)} placeholder="请描述当前实际情况、影响范围及需要调度员关注的事项" inputProps={{ maxLength: 300 }} /><Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}><Select aria-label="播报级别" value={broadcastLevel} onChange={(event) => setBroadcastLevel(event.target.value)} sx={{ minWidth: 150 }}><MenuItem value="INFO">普通播报</MenuItem><MenuItem value="WARNING">需关注</MenuItem><MenuItem value="CRITICAL">紧急播报</MenuItem></Select><Select aria-label="关联航班" displayEmpty value={broadcastFlight} onChange={(event) => setBroadcastFlight(event.target.value)} sx={{ flexGrow: 1 }}><MenuItem value="">不关联具体航班</MenuItem>{flights.map((flight) => <MenuItem key={flight.id} value={flight.id}>{flight.flight_no} · {flight.gate}</MenuItem>)}</Select><Button type="submit" variant="contained" disabled={broadcasting || broadcastTitle.trim().length < 2 || broadcastContent.trim().length < 4}>{broadcasting ? '发送中…' : '发送给调度员'}</Button></Stack></Stack></Paper><Paper variant="outlined" sx={{ overflow: 'hidden' }}><Box sx={{ p: 2.25 }}><Typography variant="h6">当前航班计划</Typography></Box><Table size="small"><TableHead><TableRow><TableCell>航班</TableCell><TableCell>机位</TableCell><TableCell>离港时间</TableCell><TableCell>需油量</TableCell><TableCell>优先级</TableCell><TableCell>状态</TableCell></TableRow></TableHead><TableBody>{flights.map((flight) => <TableRow key={flight.id}><TableCell>{flight.flight_no}</TableCell><TableCell>{flight.gate}</TableCell><TableCell>{flight.departure_at.replace('T', ' ').slice(0, 16)}</TableCell><TableCell>{flight.fuel_needed.toLocaleString()} L</TableCell><TableCell>{flight.priority}</TableCell><TableCell>{flight.status}</TableCell></TableRow>)}</TableBody></Table></Paper></Stack>;
}
