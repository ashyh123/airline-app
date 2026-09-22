import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { apiHeaders, currentUser } from 'utils/auth';

const API = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8080/api';
const labels = { PENDING: ['待执行', 'warning'], IN_PROGRESS: ['作业中', 'info'] };

export default function DriverWorkspace() {
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [exceptionTask, setExceptionTask] = useState(null);
  const [reason, setReason] = useState('');
  const [completeTask, setCompleteTask] = useState(null);
  const [fuelLevel, setFuelLevel] = useState('');
  const user = currentUser();
  const load = useCallback(async () => {
    try { const response = await fetch(`${API}/driver/tasks`, { headers: apiHeaders() }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setTasks(data.tasks); setError(''); } catch (err) { setError(err.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  async function update(task, state, extra = {}) {
    try { const response = await fetch(`${API}/tasks/${task.id}/progress`, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify({ state, ...extra }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setMessage(data.message); setExceptionTask(null); setReason(''); setCompleteTask(null); setFuelLevel(''); await load(); } catch (err) { setError(err.message); }
  }
  function openComplete(task) {
    setCompleteTask(task);
    setFuelLevel(task.fuel_level != null ? String(Math.max(0, task.fuel_level - task.fuel_needed)) : '');
  }
  if (loading) return <Box sx={{ minHeight: 360, display: 'grid', placeItems: 'center' }}><CircularProgress /></Box>;
  return <Stack spacing={2.5}>
    <Box><Typography variant="h4">我的作业工单</Typography><Typography color="text.secondary" sx={{ mt: .5 }}>{user?.display_name} · 只展示分配给本人车辆的待办与进行中工单</Typography></Box>
    {error && <Alert severity="error">{error}</Alert>}{message && <Alert severity="success" onClose={() => setMessage('')}>{message}</Alert>}
    {tasks.length === 0 ? <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}><Typography variant="h6">当前没有待处理工单</Typography><Typography color="text.secondary" sx={{ mt: 1 }}>新工单下发后会显示在这里。</Typography></Paper> : tasks.map((task) => { const [label, color] = labels[task.state]; return <Paper key={task.id} variant="outlined" sx={{ p: 2.5 }}><Stack spacing={1.5}><Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}><Box><Typography variant="h5">{task.flight_no} · {task.gate}</Typography><Typography variant="body2" color="text.secondary">{task.vehicle_code} · 需油 {task.fuel_needed.toLocaleString()} L · 当前油 {task.fuel_level.toLocaleString()} L · 预计到达 {task.eta_minutes} 分钟</Typography></Box><Chip label={label} color={color} /></Stack><Stack direction="row" spacing={1}>{task.state === 'PENDING' && <Button variant="contained" onClick={() => update(task, 'IN_PROGRESS')}>到位并开始作业</Button>}{task.state === 'IN_PROGRESS' && <><Button variant="contained" color="success" onClick={() => openComplete(task)}>确认作业完成</Button><Button variant="outlined" color="error" onClick={() => setExceptionTask(task)}>上报异常</Button></>}</Stack></Stack></Paper>; })}
    <Dialog open={Boolean(exceptionTask)} onClose={() => setExceptionTask(null)} fullWidth maxWidth="xs"><DialogTitle>上报作业异常</DialogTitle><DialogContent><TextField autoFocus fullWidth multiline minRows={3} value={reason} onChange={(event) => setReason(event.target.value)} label="异常原因" placeholder="例如：车辆泵压异常，无法继续加注" sx={{ mt: 1 }} /></DialogContent><DialogActions><Button onClick={() => setExceptionTask(null)}>取消</Button><Button color="error" variant="contained" disabled={!reason.trim()} onClick={() => update(exceptionTask, 'EXCEPTION', { reason })}>提交异常</Button></DialogActions></Dialog>
    <Dialog open={Boolean(completeTask)} onClose={() => setCompleteTask(null)} fullWidth maxWidth="xs"><DialogTitle>确认作业完成</DialogTitle><DialogContent><Stack spacing={2} sx={{ mt: 1 }}><Typography variant="body2" color="text.secondary">请提交车辆当前油量，系统将同步更新车辆剩余油量并恢复车辆为可用状态。</Typography><TextField autoFocus fullWidth type="number" value={fuelLevel} onChange={(event) => setFuelLevel(event.target.value)} label="当前油量（L）" inputProps={{ min: 0, max: completeTask?.capacity ?? undefined }} helperText={completeTask?.capacity ? `车辆容量 ${completeTask.capacity.toLocaleString()} L` : ''} /></Stack></DialogContent><DialogActions><Button onClick={() => setCompleteTask(null)}>取消</Button><Button color="success" variant="contained" disabled={fuelLevel === '' || Number(fuelLevel) < 0 || (completeTask?.capacity != null && Number(fuelLevel) > completeTask.capacity)} onClick={() => update(completeTask, 'COMPLETED', { fuelLevel: Number(fuelLevel) })}>提交完成</Button></DialogActions></Dialog>
  </Stack>;
}
