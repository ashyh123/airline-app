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
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
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
import {
  CarOutlined,
  DashboardOutlined,
  EnvironmentOutlined,
  FieldTimeOutlined,
  ImportOutlined,
  ProfileOutlined,
  TeamOutlined,
  WarningOutlined
} from '@ant-design/icons';
import { apiFetch, apiHeaders, currentUser } from 'utils/auth';
import ApronMap from './ApronMap';
import FlightPlan from './FlightPlan';

const API = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8080/api';
const example = `flightNo,gate,departureAt,fuelNeeded,priority,x,y\nCA2026,E08,${new Date(Date.now() + 86400000).toISOString()},6800,2,14,9`;

const stateStyle = {
  PENDING: ['待执行', 'warning'],
  IN_PROGRESS: ['作业中', 'info'],
  COMPLETED: ['已完成', 'success'],
  EXCEPTION: ['异常已移交', 'error'],
  AWAITING_REVIEW: ['差额待确认', 'error'],
  PARTIAL: ['部分加注已移交', 'warning'],
  CANCELLED: ['已取消', 'default'],
  AVAILABLE: ['可用', 'success'],
  RESERVED: ['已预留', 'warning'],
  WORKING: ['作业中', 'info'],
  REFUELLING: ['补油中', 'warning'],
  MAINTENANCE: ['维修中', 'default']
};

const workStyle = {
  ON_DUTY: ['值班', 'success'],
  STANDBY: ['休闲', 'info'],
  RESTING: ['休息', 'default']
};

const allocationModes = {
  KEEP: '保留当前人车',
  ASSIGN: '值班人车接替',
  CALL: '临时调用候命人员',
  CHANGE_VEHICLE: '原人员更换车辆',
  REPLACE_DRIVER: '临时更换人员'
};

const SECTIONS = [
  { id: 'overview', label: '态势总览', icon: <DashboardOutlined /> },
  { id: 'flights', label: '航班计划', icon: <ProfileOutlined /> },
  { id: 'map', label: '机坪态势', icon: <EnvironmentOutlined /> },
  { id: 'alerts', label: '风险预警', icon: <WarningOutlined /> },
  { id: 'timeline', label: '任务时间轴', icon: <FieldTimeOutlined /> },
  { id: 'tasks', label: '作业工单', icon: <ProfileOutlined /> },
  { id: 'resources', label: '资源与指标', icon: <CarOutlined /> },
  { id: 'personnel', label: '当班人员', icon: <TeamOutlined /> },
  { id: 'import', label: '航班导入', icon: <ImportOutlined /> }
];

function csvRows(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/); const keys = header.split(',').map((cell) => cell.trim());
  return lines.filter(Boolean).map((line) => Object.fromEntries(keys.map((key, index) => [key, line.split(',')[index]?.trim()])));
}

function StateChip({ value }) {
  const [label, color] = stateStyle[value] ?? [value, 'default'];
  return <Chip size="small" label={label} color={color} variant={color === 'default' ? 'outlined' : 'filled'} />;
}

function Metric({ label, value, note, tone = 'primary' }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.25, height: '100%', borderTop: 3, borderTopColor: `${tone}.main` }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="h3" sx={{ mt: 0.8 }}>{value}</Typography>
      <Typography variant="caption" color="text.secondary">{note}</Typography>
    </Paper>
  );
}

function DispatchTimeline({ vehicles, tasks, serviceMinutes = 18 }) {
  const activeTasks = tasks.filter((task) => task.state === 'PENDING' || task.state === 'IN_PROGRESS');
  const horizon = Math.ceil(Math.max(90, ...activeTasks.map((task) => (task.state === 'IN_PROGRESS' ? 0 : task.eta_minutes || 0) + serviceMinutes)) / 30) * 30;
  const marks = [0, horizon / 3, horizon * 2 / 3, horizon];
  return (
    <Paper variant="outlined" sx={{ p: 2.25, overflowX: 'auto' }}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'start', mb: 1.5 }}>
        <Box><Typography variant="h6">车辆任务时间轴</Typography><Typography variant="caption" color="text.secondary">以当前时刻为起点，色块表示预计抵达后约 {serviceMinutes} 分钟的示意保障窗口。</Typography></Box>
        <Stack direction="row" spacing={1}><Chip size="small" color="info" label="作业中" /><Chip size="small" color="warning" label="待执行" /></Stack>
      </Stack>
      <Box sx={{ minWidth: 650 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: '120px 1fr', mb: 0.5 }}><Box />
          <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary', px: 0.5 }}>{marks.map((mark) => <Typography key={mark} variant="caption">{mark === 0 ? '现在' : `+${mark} 分钟`}</Typography>)}</Box>
        </Box>
        <Stack spacing={1}>{vehicles.map((vehicle) => {
          const vehicleTasks = activeTasks.filter((task) => task.vehicle_id === vehicle.id).sort((a, b) => (a.dispatch_order || 999) - (b.dispatch_order || 999));
          return <Box key={vehicle.id} sx={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 1 }}>
            <Box><Typography variant="body2" fontWeight={700}>{vehicle.code}</Typography><Typography variant="caption" color="text.secondary">{vehicle.driver || '未绑定人员'} · {stateStyle[vehicle.status]?.[0]}</Typography></Box>
            <Box sx={{ height: 38, borderRadius: 1, position: 'relative', bgcolor: 'grey.100', overflow: 'hidden', backgroundImage: 'linear-gradient(90deg, transparent 33%, #d8dde5 33.2%, transparent 33.4%, transparent 66%, #d8dde5 66.2%, transparent 66.4%)' }}>
              {vehicleTasks.map((task) => {
                const start = task.state === 'IN_PROGRESS' ? 0 : Math.max(0, task.eta_minutes || 0) / horizon * 100;
                const color = task.state === 'IN_PROGRESS' ? 'info.main' : task.locked ? 'primary.main' : 'warning.main';
                return <Box key={task.id} title={`${task.flight_no} · ${task.gate} · ${task.eta_minutes ?? 0} 分钟到达${task.timeRisk ? ` · ${task.timeRisk}` : ''}`} sx={{ position: 'absolute', left: `${start}%`, width: `${serviceMinutes / horizon * 100}%`, top: 7, height: 24, px: 0.75, borderRadius: 1, bgcolor: color, color: 'common.white', display: 'flex', alignItems: 'center', fontSize: 11, fontWeight: 700, boxShadow: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{task.flight_no}{task.locked ? ' · 锁定' : ''}</Box>;
              })}
            </Box>
          </Box>;
        })}</Stack>
      </Box>
    </Paper>
  );
}

export default function DispatchConsole() {
  const [data, setData] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [overrideTask, setOverrideTask] = useState(null);
  const [candidateData, setCandidateData] = useState(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState('');
  const [selectedCandidateId, setSelectedCandidateId] = useState('');
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [plannedOrder, setPlannedOrder] = useState('');
  const [handlingAlert, setHandlingAlert] = useState(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [resolvingAlert, setResolvingAlert] = useState(false);
  const [refuelling, setRefuelling] = useState(false);
  const [refuelTarget, setRefuelTarget] = useState(null);
  const [refuelError, setRefuelError] = useState('');
  const [activeSection, setActiveSection] = useState('overview');
  const [importing, setImporting] = useState(false);
  const [personnelFilter, setPersonnelFilter] = useState('');
  const [callTarget, setCallTarget] = useState(null);
  const [callVehicleId, setCallVehicleId] = useState('');
  const [statusTarget, setStatusTarget] = useState(null);
  const [statusReason, setStatusReason] = useState('');
  const [personActing, setPersonActing] = useState(false);
  const [personError, setPersonError] = useState('');
  const [flightEdit, setFlightEdit] = useState(null);
  const [flightSaving, setFlightSaving] = useState(false);
  const [flightError, setFlightError] = useState('');
  const [alertError, setAlertError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [importPreview, setImportPreview] = useState(null);
  const [importError, setImportError] = useState('');
  const [showTaskHistory, setShowTaskHistory] = useState(false);
  const [taskSearch, setTaskSearch] = useState('');
  const [focusedFlightId, setFocusedFlightId] = useState('');
  const [mapFocusVersion, setMapFocusVersion] = useState(0);
  const [followupTask, setFollowupTask] = useState(null);
  const [followupReason, setFollowupReason] = useState('');
  const [followupSaving, setFollowupSaving] = useState(false);
  const [followupError, setFollowupError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch(`${API}/overview`, { headers: apiHeaders() });
      if (!response.ok) throw new Error('调度服务暂不可用，请确认后端已启动。');
      setData(await response.json());
      setLastUpdated(new Date());
      setLoadError('');
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!overrideTask) return;
    let cancelled = false;
    setCandidateLoading(true);
    setCandidateError('');
    setCandidateData(null);
    setSelectedCandidateId('');
    async function loadCandidates() {
      try {
        const response = await apiFetch(`${API}/tasks/${overrideTask.id}/candidates`, { headers: apiHeaders() });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? '无法获取临时分配建议');
        if (!cancelled) setCandidateData(body);
      } catch (err) {
        if (!cancelled) setCandidateError(err.message);
      } finally {
        if (!cancelled) setCandidateLoading(false);
      }
    }
    loadCandidates();
    return () => { cancelled = true; };
  }, [overrideTask]);

  async function command(path, payload = {}) {
    const response = await apiFetch(`${API}${path}`, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify(payload) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? '操作未完成');
    if (body.overview) setData(body.overview);
    setMessage(body.message ?? '操作已完成');
    setError('');
    return body;
  }

  async function optimize() {
    setAssigning(true);
    try { await command('/dispatch/optimize'); } catch (err) { setError(err.message); } finally { setAssigning(false); }
  }

  async function importFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportError('');
    setImportPreview({ name: file.name, flights: [], rows: [], valid: 0, applied: false });
    try {
      const content = await file.text();
      const flights = file.name.toLowerCase().endsWith('.json') ? JSON.parse(content) : csvRows(content);
      const response = await apiFetch(`${API}/admin/flights/import`, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify({ flights, preview: true }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '无法预览导入文件');
      setImportPreview({ name: file.name, flights, ...body, applied: false });
    } catch (err) { setImportError(err.message); } finally { setImporting(false); event.target.value = ''; }
  }

  async function applyImport() {
    setImporting(true);
    setImportError('');
    try {
      const response = await apiFetch(`${API}/admin/flights/import`, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify({ flights: importPreview.flights }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '导入未完成');
      setImportPreview((previous) => ({ ...previous, ...body, applied: true }));
      setMessage(`已导入或更新 ${body.imported} 条航班，拒绝 ${body.rejected.length} 条。`);
      await load();
    } catch (err) { setImportError(err.message); } finally { setImporting(false); }
  }

  async function override() {
    if (!selectedCandidate) return;
    setOverrideSaving(true);
    try {
      await command(`/tasks/${overrideTask.id}/override`, {
        vehicleId: selectedCandidate.vehicleId,
        driverId: selectedCandidate.driverId,
        dispatchOrder: plannedOrder
      });
      setOverrideTask(null);
    } catch (err) { setCandidateError(err.message); } finally { setOverrideSaving(false); }
  }

  async function openAlertHandling(alert) {
    setHandlingAlert({ alert, loading: true, details: null });
    setResolutionNote('');
    setAlertError('');
    try {
      const response = await apiFetch(`${API}/alerts/${alert.id}/recommendations`, { headers: apiHeaders() });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '无法获取处置建议');
      setHandlingAlert({ alert, loading: false, details: body });
    } catch (err) {
      setAlertError(err.message);
      setHandlingAlert({ alert, loading: false, details: null });
    }
  }

  async function resolveAlert() {
    setResolvingAlert(true);
    try {
      await command(`/alerts/${handlingAlert.alert.id}/resolve`, { resolution: resolutionNote });
      setHandlingAlert(null);
    } catch (err) { setAlertError(err.message); } finally { setResolvingAlert(false); }
  }

  function openRefuel(vehicle, action) {
    setRefuelError('');
    setRefuelTarget({ vehicle, action });
  }

  async function confirmRefuel() {
    setRefuelling(true);
    try {
      await command(`/vehicles/${refuelTarget.vehicle.id}/refuel`, { action: refuelTarget.action });
      setRefuelTarget(null);
      setHandlingAlert(null);
    } catch (err) { setRefuelError(err.message); } finally { setRefuelling(false); }
  }

  async function saveFlightEdit() {
    setFlightSaving(true);
    try {
      await command(`/flights/${flightEdit.id}`, {
        gate: flightEdit.gate,
        departureAt: new Date(flightEdit.departure_local).toISOString(),
        fuelNeeded: Number(flightEdit.fuel_needed),
        priority: Number(flightEdit.priority)
      });
      setFlightEdit(null);
    } catch (err) { setFlightError(err instanceof RangeError ? '请选择有效的离港日期与时间' : err.message); } finally { setFlightSaving(false); }
  }

  function openFlightEdit(flight) {
    const departure = new Date(flight.departure_at);
    const local = Number.isNaN(departure.getTime()) ? '' : new Date(departure.getTime() - departure.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    setFlightError('');
    setFlightEdit({ ...flight, departure_local: local });
  }

  function openAllocation(task) {
    setOverrideTask(task);
    setPlannedOrder(String(task.dispatch_order || 1));
    setFocusedFlightId(task.flight_id);
  }

  function locateFlight(flightId) {
    setFocusedFlightId(flightId);
    setMapFocusVersion((value) => value + 1);
    jumpTo('map');
  }

  function locateAlert(alert) {
    const task = data.tasks.find((item) => item.id === alert.related_id)
      ?? data.tasks.find((item) => item.flight_id === alert.related_id && ['PENDING', 'IN_PROGRESS', 'AWAITING_REVIEW'].includes(item.state));
    const flight = data.flights.find((item) => item.id === (task?.flight_id ?? alert.related_id));
    setHandlingAlert(null);
    if (task) { setTaskSearch(task.flight_no); setShowTaskHistory(!['PENDING', 'IN_PROGRESS', 'AWAITING_REVIEW'].includes(task.state)); jumpTo('tasks'); }
    else if (flight) locateFlight(flight.id);
    else jumpTo('resources');
  }

  async function confirmFollowup() {
    setFollowupSaving(true);
    try { await command(`/tasks/${followupTask.id}/followup`, { reason: followupReason }); setFollowupTask(null); }
    catch (err) { setFollowupError(err.message); } finally { setFollowupSaving(false); }
  }

  function jumpTo(id) {
    setActiveSection(id);
    document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function personAction(path, payload) {
    setPersonActing(true);
    try {
      await command(path, payload);
      setCallTarget(null); setCallVehicleId('');
      setStatusTarget(null); setStatusReason('');
      setPersonError('');
    } catch (err) { setPersonError(err.message); } finally { setPersonActing(false); }
  }

  function openCall(person) {
    setCallTarget(person);
    setCallVehicleId('');
    setPersonError('');
  }

  function openStatus(person, status) {
    setStatusTarget({ person, status });
    setStatusReason('');
    setPersonError('');
  }

  const driverNames = new Map((data?.personnel ?? []).filter((person) => person.role === 'DRIVER' && person.work_status === 'ON_DUTY' && person.vehicle_id).map((person) => [person.vehicle_id, person.display_name]));
  const vehicles = (data?.vehicles ?? []).map((vehicle) => ({ ...vehicle, driver: driverNames.get(vehicle.id) ?? '' }));
  const boundVehicleIds = new Set((data?.personnel ?? []).filter((p) => p.vehicle_id).map((p) => p.vehicle_id));
  const personLocation = callTarget?.location;
  const freeVehicles = vehicles.filter((vehicle) => vehicle.status === 'AVAILABLE' && !boundVehicleIds.has(vehicle.id)).sort((a, b) => {
    if (!personLocation) return a.code.localeCompare(b.code);
    return (Math.abs(a.x - personLocation.x) + Math.abs(a.y - personLocation.y)) - (Math.abs(b.x - personLocation.x) + Math.abs(b.y - personLocation.y));
  });
  const filteredDrivers = (data?.personnel ?? []).filter((person) => person.role === 'DRIVER' && (!personnelFilter || person.work_status === personnelFilter));
  const dispatchers = (data?.personnel ?? []).filter((person) => person.role === 'DISPATCHER');
  const counts = data?.personnelCounts ?? { onDuty: 0, standby: 0, resting: 0 };
  const selectedCandidate = candidateData?.candidates.find((candidate) => `${candidate.vehicleId}:${candidate.driverId}` === selectedCandidateId);
  const activeStates = ['PENDING', 'IN_PROGRESS', 'AWAITING_REVIEW'];
  const taskUrgency = { AWAITING_REVIEW: 0, PENDING: 1, IN_PROGRESS: 2 };
  const visibleTasks = (data?.tasks ?? []).filter((task) => (showTaskHistory || activeStates.includes(task.state)) && `${task.flight_no} ${task.gate}`.toLowerCase().includes(taskSearch.trim().toLowerCase()))
    .sort((a, b) => (taskUrgency[a.state] ?? 3) - (taskUrgency[b.state] ?? 3));
  const waitingFlights = (data?.flights ?? []).filter((flight) => ['PLANNED', 'WAITING'].includes(flight.status) && !flight.archived)
    .map((flight) => ({ ...flight, requiredFuel: flight.fuel_remaining ?? flight.fuel_needed }));

  if (loading) return <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 360 }}><CircularProgress /></Box>;

  return (
    <Box sx={{ display: 'flex', gap: 2.5, alignItems: 'flex-start' }}>
      <Paper variant="outlined" sx={{ width: 176, flexShrink: 0, position: 'sticky', top: 88, alignSelf: 'flex-start', py: 1, display: { xs: 'none', lg: 'block' } }}>
        <Typography variant="subtitle2" sx={{ px: 2, py: 1 }}>功能指引</Typography>
        <List dense sx={{ p: 0 }}>
          {SECTIONS.map((section) => (
            <ListItemButton key={section.id} selected={activeSection === section.id} onClick={() => jumpTo(section.id)} sx={{ py: 0.9 }}>
              <ListItemIcon sx={{ minWidth: 30, color: activeSection === section.id ? 'primary.main' : 'text.secondary' }}>{section.icon}</ListItemIcon>
              <ListItemText primary={<Typography variant="body2">{section.label}</Typography>} />
            </ListItemButton>
          ))}
        </List>
      </Paper>

      <Stack spacing={2.5} sx={{ flex: 1, minWidth: 0 }}>
        <Paper variant="outlined" component="nav" aria-label="工作台快捷导航" sx={{ display: { xs: 'flex', lg: 'none' }, position: 'sticky', top: 64, zIndex: 1100, p: 0.75, gap: 0.5, overflowX: 'auto' }}>
          {['tasks', 'resources', 'personnel', 'alerts', 'flights', 'map'].map((id) => <Button key={id} size="small" variant={activeSection === id ? 'contained' : 'text'} onClick={() => jumpTo(id)} sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{SECTIONS.find((section) => section.id === id)?.label}</Button>)}
        </Paper>
        <Box sx={{ display: 'flex', alignItems: { xs: 'start', sm: 'center' }, justifyContent: 'space-between', gap: 2, flexDirection: { xs: 'column', sm: 'row' } }}>
          <Box>
            <Typography variant="h4">调度人员工作台</Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>{currentUser()?.display_name}{lastUpdated ? ` · 最后更新 ${lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}` : ''}</Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={load}>刷新态势</Button>
            <Button variant="contained" onClick={optimize} disabled={assigning}>{assigning ? '计算中…' : '生成调度方案'}</Button>
          </Stack>
        </Box>

        {loadError && <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>重新连接</Button>}>{loadError}</Alert>}
        {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>重试</Button>}>{error}</Alert>}
        {message && <Alert severity="success" onClose={() => setMessage('')}>{message}</Alert>}

        {data && <>
          <Grid id="section-overview" container spacing={2} sx={{ scrollMarginTop: '148px' }}>
            <Grid size={{ xs: 6, md: 3 }}><Metric label="待保障航班" value={data.stats.waiting} note="含已计划与待保障，按优先级入队" tone="warning" /></Grid>
            <Grid size={{ xs: 6, md: 3 }}><Metric label="进行中工单" value={data.stats.activeTasks} note="含已下发与正在作业" tone="info" /></Grid>
            <Grid size={{ xs: 6, md: 3 }}><Metric label="车辆利用率" value={`${data.stats.vehicleUtilization}%`} note="当前班组实时占用" tone="success" /></Grid>
            <Grid size={{ xs: 6, md: 3 }}><Metric label="严重风险" value={data.stats.criticalAlerts} note="须由调度员尽快处理" tone="error" /></Grid>

          </Grid>

          <Paper id="section-tasks" variant="outlined" sx={{ overflow: 'hidden', scrollMarginTop: '148px' }}>
            <Box sx={{ p: 2.25, pb: 1 }}><Typography variant="h6">作业工单</Typography><Typography variant="body2" color="text.secondary">当前工单优先显示。临时分配后锁定人车；加注差额须由调度确认后续保障。</Typography>
              <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
                <TextField size="small" label="查找工单航班或机位" value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} />
                <Button size="small" variant={showTaskHistory ? 'contained' : 'outlined'} onClick={() => setShowTaskHistory((value) => !value)}>{showTaskHistory ? '收起历史工单' : '查看历史工单'}</Button>
                <Chip size="small" label={`当前 ${data.tasks.filter((task) => activeStates.includes(task.state)).length} 单`} />
              </Stack>
            </Box>
            <Box sx={{ overflowX: 'auto' }}><Table size="small" sx={{ minWidth: 760 }}>
              <TableHead><TableRow><TableCell>顺序</TableCell><TableCell>航班 / 机位</TableCell><TableCell>优先级</TableCell><TableCell>已派车辆</TableCell><TableCell>预计到达</TableCell><TableCell>状态</TableCell><TableCell align="right">操作</TableCell></TableRow></TableHead>
              <TableBody>{visibleTasks.map((task) => <TableRow key={task.id} hover>
                <TableCell>{task.state === 'PENDING' ? <Chip size="small" label={`#${task.dispatch_order || '—'}`} variant="outlined" /> : '—'}</TableCell>
                <TableCell><Button size="small" onClick={() => locateFlight(task.flight_id)} sx={{ p: 0, minWidth: 0, fontWeight: 700 }}>{task.flight_no}</Button><Typography variant="caption" display="block" color="text.secondary">{task.gate} · 本单需油 {task.fuel_needed.toLocaleString()} L</Typography>{['AWAITING_REVIEW', 'PARTIAL', 'COMPLETED'].includes(task.state) && <Typography variant="caption" color={task.state === 'AWAITING_REVIEW' ? 'error.main' : 'text.secondary'}>已加 {task.fuel_loaded == null ? '未记录' : `${task.fuel_loaded.toLocaleString()} L`} · 本单差额 {task.remaining_fuel == null ? '未知' : `${task.remaining_fuel.toLocaleString()} L`}</Typography>}</TableCell>
                <TableCell><Chip size="small" color={task.priority === 3 ? 'error' : task.priority === 2 ? 'warning' : 'default'} label={task.priority === 3 ? '高' : task.priority === 2 ? '中' : '低'} /></TableCell>
                <TableCell>{task.vehicle_code ?? '未分配'}<Typography variant="caption" display="block" color="text.secondary">{task.driver ?? ''}</Typography></TableCell>
                <TableCell>{task.eta_minutes ? `${task.eta_minutes} 分钟` : '—'}{task.timeRisk && <Typography variant="caption" color="error.main" display="block">{task.timeRisk}</Typography>}{task.estimatedCompletionAt && <Typography variant="caption" color="text.secondary" display="block">预计完成 {new Date(task.estimatedCompletionAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</Typography>}</TableCell>
                <TableCell><Stack spacing={0.5}><StateChip value={task.state} />{Boolean(task.locked) && <Chip size="small" label="人工锁定" variant="outlined" />}</Stack></TableCell>
                <TableCell align="right">{task.state === 'PENDING' ? <Button size="small" variant="outlined" onClick={() => openAllocation(task)}>临时分配</Button> : task.state === 'AWAITING_REVIEW' ? <Button size="small" color="warning" variant="contained" onClick={() => { setFollowupTask(task); setFollowupReason(''); setFollowupError(''); }}>确认后续保障</Button> : <Typography variant="caption" color="text.secondary">{activeStates.includes(task.state) ? '由司机上报' : '已结束'}</Typography>}</TableCell>
              </TableRow>)}{visibleTasks.length === 0 && <TableRow><TableCell colSpan={7}><Typography color="text.secondary" sx={{ py: 2 }}>当前没有符合筛选的工单。</Typography></TableCell></TableRow>}</TableBody>
            </Table></Box>
          </Paper>

          <Grid container spacing={2}>
            <Grid id="section-map" size={{ xs: 12, xl: 7 }} sx={{ order: { xs: 2, xl: 1 }, scrollMarginTop: '148px' }}>
              <Paper variant="outlined" sx={{ p: 2.25, height: '100%' }}>
                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                  <Box><Typography variant="h6">机坪态势</Typography><Typography variant="caption" color="text.secondary">示意布局，不代表真实机场地图</Typography></Box>
                  <Chip label={`${data.stats.availableVehicles} 辆可用`} color="success" size="small" />
                </Stack>
                <ApronMap key={`${focusedFlightId}:${mapFocusVersion}`} focusedFlightId={focusedFlightId} flights={data.flights.filter((flight) => flight.id === focusedFlightId || !flight.archived)} vehicles={vehicles} refuelPoint={data.refuelPoint} standbyPoint={data.standbyPoint} />
              </Paper>
            </Grid>
            <Grid id="section-alerts" size={{ xs: 12, xl: 5 }} sx={{ order: { xs: 1, xl: 2 }, scrollMarginTop: '148px' }}>
              <Paper variant="outlined" sx={{ p: 2.25, height: '100%' }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.25 }}><WarningOutlined style={{ color: '#ed6c02' }} /><Typography variant="h6">风险预警</Typography></Stack>
                {data.alerts.length === 0 ? <Alert severity="info">当前没有活动预警；仍需按工单与实际作业情况核实保障状态。</Alert> : <Stack spacing={1} sx={{ maxHeight: 480, overflowY: 'auto' }}>{data.alerts.map((item) => <Alert key={item.id} severity={item.level === 'CRITICAL' ? 'error' : 'warning'} variant="outlined" action={<Button color="inherit" size="small" onClick={() => openAlertHandling(item)}>查看</Button>}>
                  <Typography variant="body2">{item.message}</Typography>
                  <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mt: 0.5 }}><Chip size="small" variant="outlined" label={item.status === 'ACKNOWLEDGED' ? '已确认 · 待解除' : '待确认'} /><Typography variant="caption">{new Date(item.created_at).toLocaleTimeString()}</Typography></Stack>
                  {item.acknowledged_note && <Typography variant="caption" display="block">{item.acknowledged_by}于 {new Date(item.acknowledged_at).toLocaleString('zh-CN', { hour12: false })} 确认：{item.acknowledged_note}</Typography>}
                  <Button color="inherit" size="small" onClick={() => locateAlert(item)} sx={{ mt: 0.5 }}>定位关联工单 / 资源</Button>
                </Alert>)}</Stack>}
                {data.recentResolutions?.length > 0 && <Box component="details" sx={{ mt: 1.5, pt: 1.25, borderTop: '1px solid', borderColor: 'divider' }}><Typography component="summary" variant="body2" sx={{ cursor: 'pointer' }}>最近解除记录（{data.recentResolutions.length}）</Typography><Stack spacing={1} sx={{ mt: 1 }}>{data.recentResolutions.map((item) => <Box key={item.id}><Typography variant="caption" display="block">{item.message}</Typography><Typography variant="caption" color="text.secondary">{new Date(item.resolved_at).toLocaleString('zh-CN', { hour12: false })} · {item.resolution}</Typography></Box>)}</Stack></Box>}
              </Paper>
            </Grid>
          </Grid>

          <Box id="section-timeline" sx={{ scrollMarginTop: '148px' }}><DispatchTimeline vehicles={vehicles} tasks={data.tasks} serviceMinutes={data.timeModel?.serviceMinutes} /></Box>


          <Grid container spacing={2}>
            <Grid id="section-resources" size={{ xs: 12, lg: 7 }} sx={{ scrollMarginTop: '148px' }}>
              <Paper variant="outlined" sx={{ p: 2.25 }}>
                <Typography variant="h6">加油车资源</Typography>
                <Typography variant="caption" color="text.secondary">可用且未满油的车辆可安排前往补油点；补油期间暂停派工，确认完成后恢复可用。</Typography>
                <Stack spacing={2} mt={1.5}>{vehicles.map((vehicle) => {
                  const insufficientFlights = waitingFlights.filter((flight) => flight.requiredFuel > vehicle.fuel_level && flight.requiredFuel <= vehicle.capacity);
                  return <Box key={vehicle.id}>
                    <Stack direction="row" useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 0.5, flexWrap: 'wrap' }}>
                      <Box><Typography variant="body2" fontWeight={600}>{vehicle.code} <Typography component="span" variant="caption" color="text.secondary">· {vehicle.driver || '未绑定人员'}</Typography></Typography><Typography variant="caption" color="text.secondary">示意位置 ({vehicle.x}, {vehicle.y})</Typography></Box>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                        <Typography variant="caption">{vehicle.fuel_level.toLocaleString()} / {vehicle.capacity.toLocaleString()} L</Typography>
                        <StateChip value={vehicle.status} />
                        {vehicle.status === 'AVAILABLE' && vehicle.fuel_level < vehicle.capacity && <Button size="small" variant="outlined" color="warning" disabled={refuelling} onClick={() => openRefuel(vehicle, 'start')}>安排补油</Button>}
                        {vehicle.status === 'REFUELLING' && <Button size="small" variant="outlined" color="success" disabled={refuelling} onClick={() => openRefuel(vehicle, 'complete')}>确认补油完成</Button>}
                      </Stack>
                    </Stack>
                    <LinearProgress variant="determinate" value={Math.round(vehicle.fuel_level / vehicle.capacity * 100)} color={vehicle.fuel_level / vehicle.capacity < .35 ? 'warning' : 'primary'} />
                    {vehicle.status === 'AVAILABLE' && insufficientFlights.length > 0 && <Typography variant="caption" color="warning.main" display="block" mt={0.5}>不足以保障 {insufficientFlights.map((flight) => `${flight.flight_no}（缺 ${(flight.requiredFuel - vehicle.fuel_level).toLocaleString()} L）`).join('、')}</Typography>}
                    {vehicle.status === 'AVAILABLE' && vehicle.fuel_level * 5 < vehicle.capacity && <Typography variant="caption" color="warning.main" display="block" mt={0.5}>低于容量 20% 的安全阈值，建议优先补油。</Typography>}
                  </Box>;
                })}</Stack>
              </Paper>
            </Grid>
            <Grid size={{ xs: 12, lg: 5 }}><Paper variant="outlined" sx={{ p: 2.25, height: '100%' }}><Typography variant="h6">运行指标</Typography><Stack spacing={2} mt={2}><Box><Stack direction="row" sx={{ justifyContent: 'space-between' }}><Typography variant="body2">按时保障率</Typography><Typography variant="body2" fontWeight={700}>{data.stats.onTimeRate == null ? '暂无数据' : `${data.stats.onTimeRate}%`}</Typography></Stack>{data.stats.onTimeRate == null ? <Typography variant="caption" color="text.secondary">尚未接入可靠的完成时间与统计口径。</Typography> : <LinearProgress variant="determinate" value={data.stats.onTimeRate} color="success" sx={{ mt: 0.75 }} />}</Box></Stack></Paper></Grid>
          </Grid>

          <Paper id="section-personnel" variant="outlined" sx={{ p: 2.25, scrollMarginTop: '148px' }}>
            <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1.5, flexWrap: 'wrap', gap: 1 }}>
              <Box>
                <Typography variant="h6">人员与可调度资源</Typography>
                <Typography variant="caption" color="text.secondary">值班与休闲人员可被临时调用；休息人员不参与派工。</Typography>
              </Box>
              <Stack direction="row" spacing={1}>
                {[['', '全部'], ['ON_DUTY', `值班 ${counts.onDuty}`], ['STANDBY', `休闲 ${counts.standby}`], ['RESTING', `休息 ${counts.resting}`]].map(([value, label]) => (
                  <Chip key={value} size="small" clickable variant={personnelFilter === value ? 'filled' : 'outlined'} color={value === 'ON_DUTY' ? 'success' : value === 'STANDBY' ? 'info' : 'default'} label={label} onClick={() => setPersonnelFilter(value)} />
                ))}
              </Stack>
            </Stack>
            <Box sx={{ mb: 1.5 }}>
              <Typography variant="caption" color="text.secondary">调度人员：</Typography>
              {dispatchers.map((dispatcher) => <Chip key={dispatcher.id} size="small" sx={{ mr: 0.75 }} label={`${dispatcher.display_name}（${dispatcher.username}）`} />)}
            </Box>
            <Box sx={{ overflowX: 'auto' }}><Table size="small" sx={{ minWidth: 720 }}>
              <TableHead><TableRow><TableCell>工号</TableCell><TableCell>姓名</TableCell><TableCell>账号</TableCell><TableCell>状态</TableCell><TableCell>示意位置</TableCell><TableCell>负责车辆</TableCell><TableCell>当前任务</TableCell><TableCell align="right">操作</TableCell></TableRow></TableHead>
              <TableBody>
                {filteredDrivers.map((person) => {
                  const [workLabel, workColor] = workStyle[person.work_status] ?? [person.work_status ?? '—', 'default'];
                  const location = person.location;
                  return <TableRow key={person.id} hover>
                    <TableCell>{person.emp_no ?? '—'}</TableCell>
                    <TableCell><Typography fontWeight={600}>{person.display_name}</Typography></TableCell>
                    <TableCell>{person.username}</TableCell>
                    <TableCell><Chip size="small" label={workLabel} color={workColor} variant={workColor === 'default' ? 'outlined' : 'filled'} /></TableCell>
                    <TableCell>{person.work_status === 'RESTING' ? '不在调度范围' : location ? `${location.name} (${location.x}, ${location.y})` : '待更新'}</TableCell>
                    <TableCell>{person.vehicle_code ? <>{person.vehicle_code} <Typography component="span" variant="caption" color="text.secondary">（{stateStyle[person.vehicle_status]?.[0] ?? person.vehicle_status}）</Typography></> : '—'}</TableCell>
                    <TableCell>{person.current_task ? <>{person.current_task.flight_no} · {person.current_task.gate} <Chip size="small" variant="outlined" label={stateStyle[person.current_task.state]?.[0]} color={stateStyle[person.current_task.state]?.[1]} /></> : '—'}</TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
                        {person.work_status === 'RESTING' && <Button size="small" variant="outlined" onClick={() => openStatus(person, 'STANDBY')}>设为休闲</Button>}
                        {person.work_status === 'STANDBY' && <Button size="small" variant="contained" onClick={() => openCall(person)}>临时调用</Button>}
                        {person.work_status === 'ON_DUTY' && <Button size="small" variant="contained" onClick={() => openCall(person)}>更换车辆</Button>}
                        {person.work_status === 'ON_DUTY' && <Button size="small" variant="outlined" onClick={() => openStatus(person, 'STANDBY')}>设为休闲</Button>}
                        {(person.work_status === 'ON_DUTY' || person.work_status === 'STANDBY') && <Button size="small" variant="outlined" color="warning" onClick={() => openStatus(person, 'RESTING')}>安排休息</Button>}
                      </Stack>
                    </TableCell>
                  </TableRow>;
                })}
                {filteredDrivers.length === 0 && <TableRow><TableCell colSpan={8}><Typography color="text.secondary" sx={{ py: 2 }}>该状态下暂无人员</Typography></TableCell></TableRow>}
              </TableBody>
            </Table></Box>
          </Paper>

          <FlightPlan flights={data.flights} tasks={data.tasks} onEdit={openFlightEdit} onAllocate={openAllocation} onLocate={locateFlight} />

          <Paper id="section-import" variant="outlined" sx={{ p: 2.25, scrollMarginTop: '148px' }}>
            <Typography variant="h6">导入航班数据</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>支持 UTF-8 的 CSV 或 JSON 数组。CSV 表头：flightNo、gate、departureAt、fuelNeeded、priority、x、y。选择文件后先预览新增、更新和拒绝行；确认后只应用校验通过的数据，再生成调度方案。</Typography>
            <Stack direction="row" spacing={1.5} sx={{ mt: 2, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button component="label" variant="contained" disabled={importing}>{importing ? '校验中…' : '选择 CSV 或 JSON 文件'}<input hidden type="file" accept=".csv,.json,application/json,text/csv" onChange={importFile} /></Button>
              <Typography variant="caption" color="text.secondary">示例：{example}</Typography>
            </Stack>
          </Paper>

        </>}
      </Stack>

      <Dialog open={Boolean(importPreview)} onClose={() => !importing && setImportPreview(null)} fullWidth maxWidth="md">
        <DialogTitle>{importPreview?.applied ? '导入结果' : '航班导入预览'} · {importPreview?.name}</DialogTitle>
        <DialogContent><Stack spacing={1.5} sx={{ mt: 1 }}>
          {importing && <LinearProgress />}
          {importError && <Alert severity="error">{importError}</Alert>}
          {importPreview?.applied ? <Alert severity="success">已应用 {importPreview.imported} 条记录；拒绝 {importPreview.rejected?.length ?? 0} 条。失败记录未写入。</Alert> : <Alert severity="info">当前只做校验，尚未写入。确认时会再次检查活动工单和字段约束。</Alert>}
          <Typography variant="body2">新增 {importPreview?.rows.filter((row) => row.action === 'CREATE').length ?? 0} · 更新 {importPreview?.rows.filter((row) => row.action === 'UPDATE').length ?? 0} · 拒绝 {importPreview?.rows.filter((row) => row.action === 'REJECT').length ?? 0}</Typography>
          <Box sx={{ maxHeight: 380, overflow: 'auto' }}><Table size="small"><TableHead><TableRow><TableCell>数据行</TableCell><TableCell>航班</TableCell><TableCell>结果</TableCell><TableCell>原因</TableCell></TableRow></TableHead><TableBody>{importPreview?.rows.map((row) => <TableRow key={row.row}><TableCell>{row.row}</TableCell><TableCell>{row.flightNo || '未填写'}</TableCell><TableCell><Chip size="small" color={row.action === 'REJECT' ? 'error' : 'success'} variant="outlined" label={{ CREATE: '新增', UPDATE: '更新', REJECT: '拒绝' }[row.action]} /></TableCell><TableCell>{row.error || '校验通过'}</TableCell></TableRow>)}</TableBody></Table></Box>
        </Stack></DialogContent>
        <DialogActions><Button disabled={importing} onClick={() => setImportPreview(null)}>{importPreview?.applied ? '关闭' : '取消'}</Button>{!importPreview?.applied && <Button variant="contained" disabled={importing || !importPreview?.valid} onClick={applyImport}>确认导入 {importPreview?.valid ?? 0} 条有效记录</Button>}</DialogActions>
      </Dialog>

      <Dialog open={Boolean(followupTask)} onClose={() => !followupSaving && setFollowupTask(null)} fullWidth maxWidth="sm">
        <DialogTitle>确认后续保障 · {followupTask?.flight_no}</DialogTitle>
        <DialogContent><Stack spacing={1.5} sx={{ mt: 1 }}>
          {followupError && <Alert severity="error">{followupError}</Alert>}
          <Typography variant="body2">原执行人员 {followupTask?.driver} · {followupTask?.vehicle_code}</Typography>
          <Typography>本单计划 {followupTask?.fuel_needed.toLocaleString()} L，实际已加 {followupTask?.fuel_loaded.toLocaleString()} L，剩余需加 {followupTask?.remaining_fuel.toLocaleString()} L。</Typography>
          <Typography variant="body2" color="text.secondary">司机说明：{followupTask?.reason}</Typography>
          <Alert severity="warning">确认后将按剩余量重新调度，并释放原车。加注差额不等同车辆故障；请先核实原车具备恢复可用条件，故障车辆应走异常处理。</Alert>
          <TextField autoFocus label="后续保障说明" multiline minRows={3} value={followupReason} onChange={(event) => setFollowupReason(event.target.value)} helperText="至少 4 个字，记录现场核实情况及后续安排。" />
        </Stack></DialogContent>
        <DialogActions><Button disabled={followupSaving} onClick={() => setFollowupTask(null)}>取消</Button><Button variant="contained" disabled={followupSaving || followupReason.trim().length < 4} onClick={confirmFollowup}>{followupSaving ? '处理中…' : '确认剩余保障并释放原车'}</Button></DialogActions>
      </Dialog>

      <Dialog open={Boolean(overrideTask)} onClose={() => !overrideSaving && setOverrideTask(null)} fullWidth maxWidth="md">
        <DialogTitle>临时分配与就近推荐 · {overrideTask?.flight_no}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">{overrideTask?.gate} · 需油 {overrideTask?.fuel_needed.toLocaleString()} L。候选已通过人员、车辆及油量校验，按人员到车、车辆到机位的总示意距离排序。请选择一组人车后保存，系统会重新校验并锁定工单。</Typography>
            <Alert severity="info">位置为机坪示意坐标，距离单位为格，预计到达时间仅用于演示调度，不代表实际导航。</Alert>
            {candidateLoading && <LinearProgress />}
            {candidateError && <Alert severity="error">{candidateError}</Alert>}
            {!candidateLoading && candidateData?.candidates.length === 0 && <Alert severity="warning">当前没有满足人员、油量与任务约束的候选。请先安排补油、调用人员或调整其他待执行工单。</Alert>}
            <Stack spacing={1} sx={{ maxHeight: 320, overflowY: 'auto' }}>
              {candidateData?.candidates.map((candidate, index) => {
                const candidateId = `${candidate.vehicleId}:${candidate.driverId}`;
                const selected = candidateId === selectedCandidateId;
                return <Paper key={candidateId} variant="outlined" sx={{ p: 1.5, borderColor: selected ? 'primary.main' : 'divider', bgcolor: selected ? 'primary.lighter' : 'background.paper' }}>
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" fontWeight={700}>#{index + 1} {candidate.vehicleCode} · {candidate.driverName}</Typography>
                      <Typography variant="caption" display="block" color="text.secondary">{allocationModes[candidate.mode]} · {workStyle[candidate.driverWorkStatus]?.[0]} · 油量 {candidate.fuelLevel.toLocaleString()} / {candidate.capacity.toLocaleString()} L · 车辆位置 ({candidate.x}, {candidate.y})</Typography>
                      <Typography variant="caption" display="block" color="text.secondary">总示意距离 {candidate.distance} 格（人员到车 {candidate.driverDistance} 格）· 估算约 {candidate.etaMinutes} 分钟到达</Typography>
                      <Typography variant="caption" display="block">{candidate.recommendation}</Typography>{candidate.timeRisk && <Typography variant="caption" color="error.main" display="block">{candidate.timeRisk}</Typography>}
                    </Box>
                    <Button size="small" variant={selected ? 'contained' : 'outlined'} onClick={() => setSelectedCandidateId(candidateId)} disabled={overrideSaving} sx={{ flexShrink: 0 }}>{selected ? '已选择' : '选择人车'}</Button>
                  </Stack>
                </Paper>;
              })}
            </Stack>
            {candidateData?.excluded?.length > 0 && <Box><Typography variant="subtitle2" mb={0.75}>未列入候选的车辆</Typography><Stack spacing={0.75}>{candidateData.excluded.map((vehicle) => <Alert key={vehicle.vehicleId} severity="info" variant="outlined"><strong>{vehicle.vehicleCode}</strong>：{vehicle.reasons.join('；')}</Alert>)}</Stack></Box>}
            {selectedCandidate && candidateData?.flight && <Box>
              <Typography variant="subtitle2" mb={0.5}>已选车辆至目标机位的示意连线</Typography>
              <Box sx={{ maxWidth: 560, mx: 'auto', borderRadius: 1, overflow: 'hidden' }}><ApronMap flights={[candidateData.flight]} vehicles={vehicles.filter((vehicle) => vehicle.id === selectedCandidate.vehicleId).map((vehicle) => ({ ...vehicle, driver: selectedCandidate.driverName }))} refuelPoint={data?.refuelPoint} standbyPoint={data?.standbyPoint} selectedCandidate={selectedCandidate} targetFlight={candidateData.flight} /></Box>
            </Box>}
            <TextField label="执行顺序" fullWidth type="text" value={plannedOrder} onChange={(event) => setPlannedOrder(event.target.value.replace(/[^0-9]/g, ''))} inputProps={{ inputMode: 'numeric', pattern: '[0-9]*' }} helperText="1 为当前待执行队列中的最优先工单。作业中的工单不可在此改派。" />
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setOverrideTask(null)} disabled={overrideSaving}>取消</Button><Button variant="contained" onClick={override} disabled={!selectedCandidate || !/^[1-9][0-9]*$/.test(plannedOrder) || overrideSaving}>{overrideSaving ? '保存中…' : '确认临时分配'}</Button></DialogActions>
      </Dialog>

      <Dialog open={Boolean(refuelTarget)} onClose={() => !refuelling && setRefuelTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>{refuelTarget?.action === 'complete' ? '确认补油完成' : '安排车辆补油'} · {refuelTarget?.vehicle.code}</DialogTitle>
        <DialogContent><Stack spacing={1.5} sx={{ mt: 1 }}>
          {refuelError && <Alert severity="error">{refuelError}</Alert>}
          <Typography variant="body2">当前油量 {refuelTarget?.vehicle.fuel_level.toLocaleString()} / {refuelTarget?.vehicle.capacity.toLocaleString()} L。</Typography>
          {refuelTarget?.action === 'complete' ? <Alert severity="warning">请确认车辆已在补油点完成补油。确认后按满容记录油量、关闭油量告警并恢复可用，系统将重新生成调度方案。</Alert> : <Alert severity="info">将安排车辆前往{data?.refuelPoint?.name ?? '补油点'}，期间标记为“补油中”并暂停派工。当前油量保持不变，实际补油后还需确认完成。</Alert>}
        </Stack></DialogContent>
        <DialogActions><Button onClick={() => setRefuelTarget(null)} disabled={refuelling}>取消</Button><Button variant="contained" onClick={confirmRefuel} disabled={refuelling}>{refuelling ? '处理中…' : refuelTarget?.action === 'complete' ? '确认已补满' : '确认安排补油'}</Button></DialogActions>
      </Dialog>

      <Dialog open={Boolean(handlingAlert)} onClose={() => !resolvingAlert && setHandlingAlert(null)} fullWidth maxWidth="sm">
        <DialogTitle>风险确认与资源建议</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" mb={2}>{handlingAlert?.alert.message}</Typography>
          {alertError && <Alert severity="error" sx={{ mb: 1.5 }}>{alertError}</Alert>}
          <Button size="small" onClick={() => locateAlert(handlingAlert.alert)} sx={{ mb: 1.5 }}>定位关联工单 / 资源</Button>
          {handlingAlert?.loading ? <LinearProgress /> : <Stack spacing={1.25}>
            {handlingAlert?.details?.suggestion && <Alert severity="info">{handlingAlert.details.suggestion}</Alert>}
            {handlingAlert?.alert?.type === 'VEHICLE_LOW_FUEL' ? (
              <Alert severity="warning" action={<Button color="inherit" size="small" disabled={refuelling || handlingAlert?.details?.vehicle?.status !== 'AVAILABLE'} onClick={() => openRefuel(handlingAlert.details.vehicle, 'start')}>安排补油</Button>}>
                {handlingAlert?.details?.vehicle ? `${handlingAlert.details.vehicle.code} 当前油量 ${handlingAlert.details.vehicle.fuel_level.toLocaleString()} / ${handlingAlert.details.vehicle.capacity.toLocaleString()} L。` : ''}{handlingAlert?.details?.vehicle?.status === 'REFUELLING' ? '该车辆正在补油，请在“加油车资源”中确认补油完成后恢复派工。' : '请安排可用车辆前往补油点；车辆补油期间暂停派工，确认完成后关闭告警并重新参与调度。'}
              </Alert>
            ) : <>
              <Typography variant="subtitle2">可协调资源</Typography>
              {handlingAlert?.details?.candidates?.length ? handlingAlert.details.candidates.map((vehicle) => <Paper key={vehicle.id} variant="outlined" sx={{ p: 1.25 }}><Stack direction="row" sx={{ justifyContent: 'space-between', gap: 1 }}><Typography variant="body2" fontWeight={700}>{vehicle.code} · {vehicle.driver}</Typography><StateChip value={vehicle.status} /></Stack><Typography variant="caption" display="block" color="text.secondary" mt={0.5}>可用油量 {vehicle.fuel_level.toLocaleString()} L · {vehicle.recommendation}</Typography></Paper>) : <Alert severity="warning">当前没有满足油量约束的可协调车辆。请安排补油、外援或调整保障计划后再处置。</Alert>}
            </>}
            <TextField label="风险确认与跟进说明" placeholder="例如：已联系候命人员，待车辆完成补油后接续保障" multiline minRows={3} value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} helperText="确认仅记录跟进情况，风险仍保持活动；资源条件真正满足后由系统解除。" />
          </Stack>}
        </DialogContent>
        <DialogActions><Button onClick={() => setHandlingAlert(null)} disabled={resolvingAlert}>取消</Button><Button variant="contained" onClick={resolveAlert} disabled={handlingAlert?.loading || resolutionNote.trim().length < 4 || resolvingAlert}>{resolvingAlert ? '记录中…' : '确认风险并记录'}</Button></DialogActions>
      </Dialog>

      <Dialog open={Boolean(flightEdit)} onClose={() => !flightSaving && setFlightEdit(null)} fullWidth maxWidth="xs">
        <DialogTitle>调整航班计划 · {flightEdit?.flight_no}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {flightError && <Alert severity="error">{flightError}</Alert>}
            <Typography variant="body2" color="text.secondary">修改后同步到态势和调度队列；已有待执行或作业中工单时不可修改需油量。</Typography>
            <TextField label="预计离港时间" type="datetime-local" value={flightEdit?.departure_local ?? ''} onChange={(event) => setFlightEdit((f) => ({ ...f, departure_local: event.target.value }))} slotProps={{ inputLabel: { shrink: true } }} helperText={`按本地时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone} 输入，保存时统一转换时间。`} />
            <TextField label="机位" value={flightEdit?.gate ?? ''} onChange={(event) => setFlightEdit((f) => ({ ...f, gate: event.target.value }))} inputProps={{ maxLength: 8 }} />
            <TextField label="需油量（L）" type="text" value={flightEdit?.fuel_needed ?? ''} onChange={(event) => setFlightEdit((f) => ({ ...f, fuel_needed: event.target.value.replace(/[^0-9]/g, '') }))} inputProps={{ inputMode: 'numeric', pattern: '[0-9]*' }} />
            <Stack spacing={0.75}>
              <Typography variant="body2" fontWeight={700}>优先级</Typography>
              <Select fullWidth value={String(flightEdit?.priority ?? 1)} onChange={(event) => setFlightEdit((f) => ({ ...f, priority: Number(event.target.value) }))}>
                <MenuItem value="3">高</MenuItem>
                <MenuItem value="2">中</MenuItem>
                <MenuItem value="1">低</MenuItem>
              </Select>
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFlightEdit(null)} disabled={flightSaving}>取消</Button>
          <Button variant="contained" disabled={flightSaving || !flightEdit?.gate || !flightEdit?.departure_local || !(Number(flightEdit?.fuel_needed) > 0)} onClick={saveFlightEdit}>{flightSaving ? '保存中…' : '保存调整'}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(callTarget)} onClose={() => !personActing && setCallTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>{callTarget?.work_status === 'ON_DUTY' ? '更换负责车辆' : '临时调用'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {personError && <Alert severity="error">{personError}</Alert>}
            <Typography variant="body2" color="text.secondary">
              {callTarget?.work_status === 'ON_DUTY'
                ? `${callTarget?.display_name} 当前负责 ${callTarget?.vehicle_code ?? '无车辆'}。更换后原车辆解除绑定，待执行工单随人员转移并重新校验油量；存在作业中工单时不可更换。`
                : `为 ${callTarget?.display_name} 选择一辆可用且未被占用的加油车，确认后人员转为值班并建立车辆绑定。`}
            </Typography>
            <Typography variant="caption" color="text.secondary">车辆按人员当前位置到车的示意距离排序；未绑车人员位于{data?.standbyPoint?.name ?? '人员候命区'}。</Typography>
            {freeVehicles.length === 0 ? <Alert severity="warning">当前没有可用且未被占用的加油车，无法临时调用或更换。</Alert> : (
              <Select aria-label="选择加油车" fullWidth value={callVehicleId} onChange={(event) => setCallVehicleId(event.target.value)} displayEmpty>
                <MenuItem value="">请选择加油车</MenuItem>
                {freeVehicles.map((vehicle) => <MenuItem key={vehicle.id} value={vehicle.id}>{vehicle.code} · 油量 {vehicle.fuel_level.toLocaleString()} / {vehicle.capacity.toLocaleString()} L · 位置 ({vehicle.x}, {vehicle.y}){personLocation ? ` · 距离 ${Math.abs(vehicle.x - personLocation.x) + Math.abs(vehicle.y - personLocation.y)} 格` : ''}</MenuItem>)}
              </Select>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCallTarget(null)} disabled={personActing}>取消</Button>
          <Button variant="contained" disabled={!callVehicleId || personActing} onClick={() => personAction(`/dispatch/personnel/${callTarget.id}/${callTarget.work_status === 'ON_DUTY' ? 'vehicle' : 'call'}`, { vehicleId: callVehicleId })}>{personActing ? '处理中…' : '确认'}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(statusTarget)} onClose={() => !personActing && setStatusTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>{statusTarget?.status === 'RESTING' ? '安排休息' : '设为休闲'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {personError && <Alert severity="error">{personError}</Alert>}
            <Typography variant="body2" color="text.secondary">
              {statusTarget?.status === 'RESTING'
                ? `${statusTarget?.person?.display_name} 将移出可调度队伍并解除车辆绑定；名下有待执行或作业中工单时将被阻止。`
                : `${statusTarget?.person?.display_name} 将进入候命状态${statusTarget?.person?.work_status === 'ON_DUTY' ? '，并解除当前车辆绑定' : ''}，可再次被临时调用或直接派工。`}
            </Typography>
            <TextField autoFocus label="原因" value={statusReason} onChange={(event) => setStatusReason(event.target.value)} placeholder="如：交班、请假、临时离岗" helperText={statusTarget?.status === 'RESTING' ? '必填，供交接班追溯' : '值班人员转休闲时必填'} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setStatusTarget(null)} disabled={personActing}>取消</Button>
          <Button variant="contained" disabled={personActing || (statusTarget?.status === 'RESTING' && statusReason.trim().length < 2) || (statusTarget?.status === 'STANDBY' && statusTarget?.person?.work_status === 'ON_DUTY' && statusReason.trim().length < 2)} onClick={() => personAction(`/dispatch/personnel/${statusTarget.person.id}/status`, { status: statusTarget.status, reason: statusReason })}>{personActing ? '处理中…' : '确认'}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
