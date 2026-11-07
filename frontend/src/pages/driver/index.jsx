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
import { apiFetch, apiHeaders, currentUser } from 'utils/auth';

const API = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8080/api';
const labels = { PENDING: ['待执行', 'warning'], IN_PROGRESS: ['作业中', 'info'], AWAITING_REVIEW: ['差额待调度确认', 'warning'] };
const WORK_LABEL = { ON_DUTY: '值班', STANDBY: '休闲', RESTING: '休息' };

export default function DriverWorkspace() {
  const [tasks, setTasks] = useState([]);
  const [driver, setDriver] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [exceptionTask, setExceptionTask] = useState(null);
  const [reason, setReason] = useState('');
  const [completeTask, setCompleteTask] = useState(null);
  const [fuelLoaded, setFuelLoaded] = useState('');
  const [refuelOpen, setRefuelOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestReason, setRequestReason] = useState('');
  const [reportedFuel, setReportedFuel] = useState('');
  const user = currentUser();
  const refuelRequest = driver?.refuel_request;
  const requestPending = ['PENDING', 'SCHEDULED'].includes(refuelRequest?.status);
  const validReportedFuel = reportedFuel === '' || (/^\d+$/.test(reportedFuel) && Number(reportedFuel) <= (driver?.vehicle?.capacity ?? 0));
  const load = useCallback(async () => {
    try {
      const response = await apiFetch(`${API}/driver/tasks`, { headers: apiHeaders() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setTasks(data.tasks); setDriver(data.driver); setLoadError('');
    } catch (err) { setLoadError(err.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [load]);
  async function update(task, state, extra = {}) {
    setSubmitting(true); setActionError('');
    try {
      const response = await apiFetch(`${API}/tasks/${task.id}/progress`, {
        method: 'POST', headers: apiHeaders(true), body: JSON.stringify({ state, ...extra })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMessage(data.message); setExceptionTask(null); setCompleteTask(null); setReason(''); setFuelLoaded('');
      await load();
    } catch (err) { setActionError(err.message); } finally { setSubmitting(false); }
  }
  async function requestRefuel() {
    setSubmitting(true); setActionError('');
    try {
      const response = await apiFetch(`${API}/driver/refuel-requests`, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify({ reason: requestReason, reportedFuel: reportedFuel === '' ? null : Number(reportedFuel) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setMessage(result.message); setRequestOpen(false); await load();
    } catch (err) { setActionError(err.message); } finally { setSubmitting(false); }
  }
  async function completeRefuel() {
    setSubmitting(true); setActionError('');
    try {
      const response = await apiFetch(`${API}/vehicles/${driver.vehicle.id}/refuel`, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify({ action: 'complete' }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setMessage(result.message); setRefuelOpen(false); await load();
    } catch (err) { setActionError(err.message); } finally { setSubmitting(false); }
  }
  function openComplete(task) {
    setActionError(''); setReason(''); setCompleteTask(task); setFuelLoaded(String(task.fuel_needed));
  }
  const amount = Number(fuelLoaded);
  const validAmount = Boolean(completeTask) && /^\d+$/.test(fuelLoaded) && Number.isSafeInteger(amount) && amount >= 0
    && amount <= (completeTask?.fuel_level ?? 0) && amount <= (completeTask?.fuel_needed ?? 0);
  const shortfall = completeTask && validAmount ? completeTask.fuel_needed - amount : 0;
  function statusBanner() {
    if (!driver) return null;
    if (driver.account_status !== 'ENABLED') return <Alert severity="error">账号已被停用，请联系系统管理员。</Alert>;
    if (driver.vehicle?.status === 'REFUELLING') return <Alert severity="warning" variant="outlined">负责车辆 {driver.vehicle.code} 正在补油，暂停接收航班工单。请在现场补满油后确认完成。<Button disabled={submitting} onClick={() => { setActionError(''); setRefuelOpen(true); }}>确认补油完成</Button></Alert>;
    if (driver.work_status === 'ON_DUTY' && driver.vehicle) return <Alert severity="success" variant="outlined">当前状态：值班 · 负责车辆 {driver.vehicle.code}（{driver.vehicle.fuel_level.toLocaleString()} / {driver.vehicle.capacity.toLocaleString()} L）。</Alert>;
    if (driver.work_status === 'STANDBY') return <Alert severity="info" variant="outlined">当前状态：休闲候命 · 暂无车辆绑定。调度人员临时调用并绑定车辆后，这里会显示工单。</Alert>;
    return <Alert severity="warning" variant="outlined">当前状态：休息 · 暂无可执行工单。调度人员确认返岗后会安排候命或值班。</Alert>;
  }
  if (loading) return <Box sx={{ minHeight: 360, display: 'grid', placeItems: 'center' }}><CircularProgress /></Box>;
  return <Stack spacing={2.5}>
    <Box><Typography variant="h4">我的作业工单</Typography><Typography color="text.secondary" sx={{ mt: 0.5 }}>{user?.display_name}{user?.emp_no ? ` · 工号 ${user.emp_no}` : ''}</Typography></Box>
    {loadError && <Alert severity="error">{loadError}</Alert>}
    {actionError && !exceptionTask && !completeTask && <Alert severity="error">{actionError}</Alert>}
    {message && <Alert severity="success" onClose={() => setMessage('')}>{message}</Alert>}
    {statusBanner()}
    {refuelRequest && <Alert severity={refuelRequest.status === 'REJECTED' ? 'warning' : 'info'}>
      补油申请：{{ PENDING: '待调度处理', SCHEDULED: '已安排补油', REJECTED: '已退回', CANCELLED: '已取消', COMPLETED: '已完成' }[refuelRequest.status]} · {refuelRequest.reason}
      {refuelRequest.resolution && <Typography variant="body2">{refuelRequest.resolution}</Typography>}
    </Alert>}
    {driver?.eligible && !['REFUELLING', 'MAINTENANCE'].includes(driver.vehicle?.status) && <Box><Button variant="outlined" disabled={submitting || requestPending} onClick={() => { setRequestReason(''); setReportedFuel(''); setActionError(''); setRequestOpen(true); }}>{requestPending ? '补油申请待调度处理' : '申请补油'}</Button></Box>}
    {(!driver?.eligible || tasks.length === 0) && <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}><Typography variant="h6">当前没有待处理工单</Typography><Typography color="text.secondary" sx={{ mt: 1 }}>当前状态：{WORK_LABEL[driver?.work_status] ?? '未知'}。新工单下发后会显示在这里。</Typography></Paper>}
    {driver?.eligible && tasks.map((task) => {
      const [label, color] = labels[task.state] ?? [task.state, 'default'];
      return <Paper key={task.id} variant="outlined" sx={{ p: 2.5 }}><Stack spacing={1.5}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' } }}>
          <Box><Typography variant="h5">{task.flight_no} · {task.gate}</Typography><Typography variant="body2" color="text.secondary">{task.vehicle_code} · 本单计划 {task.fuel_needed.toLocaleString()} L · 当前油 {task.fuel_level.toLocaleString()} L</Typography>{task.state === 'PENDING' && <Typography variant="caption" color="text.secondary">示意预计到达 {task.eta_minutes} 分钟</Typography>}</Box>
          <Stack direction="row" spacing={0.75}>{task.dispatch_order ? <Chip size="small" variant="outlined" label={`顺序 #${task.dispatch_order}`} /> : null}<Chip label={label} color={color} /></Stack>
        </Stack>
        {task.timeRisk && <Alert severity="warning">预计无法在保障截止时间前完成，请听从调度安排。</Alert>}
        {task.state === 'AWAITING_REVIEW' && <Alert severity="warning">已记录本次加注 {task.fuel_loaded?.toLocaleString() ?? 0} L，剩余需求 {task.remaining_fuel?.toLocaleString() ?? 0} L。{task.reason}。车辆暂停派工，等待调度人员确认后续保障。</Alert>}
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
          {task.state === 'PENDING' && <Button disabled={submitting} variant="contained" onClick={() => update(task, 'IN_PROGRESS')}>到位并开始作业</Button>}
          {task.state === 'IN_PROGRESS' && <><Button disabled={submitting} variant="contained" color="success" onClick={() => openComplete(task)}>确认作业完成</Button><Button disabled={submitting} variant="outlined" color="error" onClick={() => { setActionError(''); setReason(''); setExceptionTask(task); }}>上报异常</Button></>}
        </Stack>
      </Stack></Paper>;
    })}
    <Dialog open={requestOpen} onClose={() => !submitting && setRequestOpen(false)} fullWidth maxWidth="xs">
      <DialogTitle>申请补油 · {driver?.vehicle?.code}</DialogTitle>
      <DialogContent><Stack spacing={2} sx={{ mt: 1 }}>
        <Alert severity="info">提交后等待调度安排，车辆状态和现有工单保持不变。现场油量仅供调度参考，不会直接覆盖系统油量。</Alert>
        {actionError && <Alert severity="error">{actionError}</Alert>}
        <TextField label="补油原因" multiline minRows={2} value={requestReason} onChange={(e) => setRequestReason(e.target.value)} helperText="填写 4 至 500 字" inputProps={{ maxLength: 500 }} />
        <TextField label="现场剩余油量（L，可选）" value={reportedFuel} onChange={(e) => setReportedFuel(e.target.value)} error={!validReportedFuel} helperText={`请输入 0 至 ${driver?.vehicle?.capacity ?? 0} 的整数`} inputProps={{ inputMode: 'numeric' }} />
      </Stack></DialogContent>
      <DialogActions><Button disabled={submitting} onClick={() => setRequestOpen(false)}>取消</Button><Button variant="contained" disabled={submitting || requestReason.trim().length < 4 || requestReason.trim().length > 500 || !validReportedFuel} onClick={requestRefuel}>提交补油申请</Button></DialogActions>
    </Dialog>
    <Dialog open={refuelOpen} onClose={() => !submitting && setRefuelOpen(false)} fullWidth maxWidth="xs">
      <DialogTitle>确认补油完成 · {driver?.vehicle?.code}</DialogTitle>
      <DialogContent><Stack spacing={2} sx={{ mt: 1 }}><Alert severity="warning">请确认已在现场补满油。提交后按车辆容量记录油量，并恢复调度。</Alert>{actionError && <Alert severity="error">{actionError}</Alert>}</Stack></DialogContent>
      <DialogActions><Button disabled={submitting} onClick={() => setRefuelOpen(false)}>取消</Button><Button variant="contained" disabled={submitting} onClick={completeRefuel}>确认已补满</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(exceptionTask)} onClose={() => !submitting && setExceptionTask(null)} fullWidth maxWidth="xs">
      <DialogTitle>上报作业异常</DialogTitle><DialogContent><Stack spacing={2} sx={{ mt: 1 }}>
        <Alert severity="info">如本次已经加注，请通过“确认作业完成”登记实际量和差额。此处用于尚未加注的车辆故障。</Alert>
        {actionError && <Alert severity="error">{actionError}</Alert>}
        <TextField autoFocus fullWidth multiline minRows={3} value={reason} onChange={(event) => setReason(event.target.value)} label="异常原因" placeholder="例如：车辆泵压异常，无法开始加注" />
      </Stack></DialogContent><DialogActions><Button disabled={submitting} onClick={() => setExceptionTask(null)}>取消</Button><Button color="error" variant="contained" disabled={submitting || !reason.trim()} onClick={() => update(exceptionTask, 'EXCEPTION', { reason })}>提交异常</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(completeTask)} onClose={() => !submitting && setCompleteTask(null)} fullWidth maxWidth="xs">
      <DialogTitle>登记实际加注量</DialogTitle><DialogContent><Stack spacing={2} sx={{ mt: 1 }}>
        {actionError && <Alert severity="error">{actionError}</Alert>}
        <Typography variant="body2" color="text.secondary">足量加注后完成工单；不足时记录差额，等待调度人员确认后续保障。</Typography>
        <TextField autoFocus fullWidth value={fuelLoaded} onChange={(event) => setFuelLoaded(event.target.value)} label="本次加注量（L）" error={fuelLoaded !== '' && !validAmount} inputProps={{ inputMode: 'numeric' }} helperText={completeTask ? `本单计划 ${completeTask.fuel_needed.toLocaleString()} L · 当前油 ${completeTask.fuel_level.toLocaleString()} L。请输入不超过计划及当前油量的非负整数。` : ''} />
        {validAmount && <Typography variant="body2">提交后车内剩余 {(completeTask.fuel_level - amount).toLocaleString()} L · 航班剩余需求 {shortfall.toLocaleString()} L</Typography>}
        {shortfall > 0 && <><Alert severity="warning">本次不会标记正常完成。车辆保持占用，调度人员确认后再安排剩余需求。</Alert><TextField fullWidth multiline minRows={2} label="未足量加注原因" value={reason} onChange={(event) => setReason(event.target.value)} helperText="至少 4 个字，说明需要调度处理的情况" /></>}
      </Stack></DialogContent><DialogActions>
        <Button disabled={submitting} onClick={() => setCompleteTask(null)}>取消</Button>
        <Button color={shortfall > 0 ? 'warning' : 'success'} variant="contained" disabled={submitting || !validAmount || (shortfall > 0 && reason.trim().length < 4)} onClick={() => update(completeTask, shortfall > 0 ? 'AWAITING_REVIEW' : 'COMPLETED', { fuelLoaded: amount, ...(shortfall > 0 ? { reason } : {}) })}>{submitting ? '提交中…' : shortfall > 0 ? '记录差额并等待确认' : '提交完成'}</Button>
      </DialogActions>
    </Dialog>
  </Stack>;
}
