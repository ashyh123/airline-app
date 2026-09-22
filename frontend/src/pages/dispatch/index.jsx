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
  NotificationOutlined,
  ProfileOutlined,
  WarningOutlined
} from '@ant-design/icons';
import { apiHeaders, currentUser } from 'utils/auth';

const API = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8080/api';
const example = 'flightNo,gate,departureAt,fuelNeeded,priority,x,y\nCA2026,E08,2026-09-14T12:30:00+00:00,6800,2,14,9';

const stateStyle = {
  PENDING: ['待执行', 'warning'],
  IN_PROGRESS: ['作业中', 'info'],
  COMPLETED: ['已完成', 'success'],
  EXCEPTION: ['异常', 'error'],
  AVAILABLE: ['可用', 'success'],
  RESERVED: ['已预留', 'warning'],
  WORKING: ['作业中', 'info'],
  MAINTENANCE: ['维修中', 'default']
};

const SECTIONS = [
  { id: 'overview', label: '态势总览', icon: <DashboardOutlined /> },
  { id: 'map', label: '机坪态势', icon: <EnvironmentOutlined /> },
  { id: 'alerts', label: '风险预警', icon: <WarningOutlined /> },
  { id: 'timeline', label: '任务时间轴', icon: <FieldTimeOutlined /> },
  { id: 'tasks', label: '作业工单', icon: <ProfileOutlined /> },
  { id: 'resources', label: '资源与指标', icon: <CarOutlined /> },
  { id: 'import', label: '航班导入', icon: <ImportOutlined /> },
  { id: 'broadcast', label: '现场播报', icon: <NotificationOutlined /> }
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

function ApiError({ message }) {
  return message ? <Alert severity="error" sx={{ mb: 2 }}>{message}</Alert> : null;
}

const mapX = (x) => 50 + x * 38;
const mapY = (y) => 140 + y * 16;

function PlaneGlyph({ color }) {
  return (
    <g fill={color}>
      <path d="M0 -15 C1.8 -10.5 2.1 -4 1.7 2 L1.7 8.5 L4.8 11.5 L4.8 14 L0 13 L-4.8 14 L-4.8 11.5 L-1.7 8.5 L-1.7 2 C-2.1 -4 -1.8 -10.5 0 -15 Z" />
      <path d="M-1.9 -3.5 L-13 4.5 L-13 7 L-1.9 3.8 Z" />
      <path d="M1.9 -3.5 L13 4.5 L13 7 L1.9 3.8 Z" />
    </g>
  );
}

function ApronMap({ flights, vehicles }) {
  const vehicleColor = (status) => (status === 'AVAILABLE' ? '#2e7d32' : status === 'MAINTENANCE' ? '#757575' : '#1976d2');
  return (
    <svg viewBox="0 0 1000 560" width="100%" style={{ display: 'block' }} role="img" aria-label="机坪态势图">
      {/* 草地 */}
      <rect x="0" y="0" width="1000" height="560" fill="#8aa084" />
      {/* 水泥机坪 */}
      <rect x="30" y="120" width="940" height="330" rx="10" fill="#a9b1b5" stroke="#8f979b" strokeWidth="2" />
      <line x1="30" y1="285" x2="970" y2="285" stroke="#98a1a6" strokeWidth="1.5" strokeDasharray="10 8" />
      {/* 航站楼与登机口 */}
      <rect x="170" y="66" width="600" height="42" rx="6" fill="#7b838d" stroke="#656d76" />
      <text x="470" y="93" textAnchor="middle" fontSize="15" fontWeight="700" fill="#f5f7f8">T1 航站楼</text>
      {[230, 340, 450, 560, 670].map((gx) => <rect key={gx} x={gx} y="108" width="26" height="14" rx="2" fill="#7b838d" />)}
      {/* 滑行道 */}
      <rect x="472" y="440" width="76" height="70" fill="#969ea3" stroke="#e5c04b" strokeWidth="2" />
      {/* 跑道 */}
      <rect x="30" y="510" width="940" height="40" rx="4" fill="#4b5257" />
      <line x1="70" y1="530" x2="930" y2="530" stroke="#e8ebed" strokeWidth="3" strokeDasharray="26 20" />
      {[66, 895].map((tx) => (
        <g key={tx} fill="#e8ebed">
          {[0, 1, 2].map((i) => <rect key={i} x={tx + i * 9} y="516" width="5" height="28" />)}
        </g>
      ))}
      <text x="112" y="537" fontSize="14" fontWeight="700" fill="#dfe4e7">18</text>
      <text x="866" y="537" fontSize="14" fontWeight="700" fill="#dfe4e7">36</text>
      {/* 航班机位 */}
      {flights.map((flight) => (
        <g key={flight.id} transform={`translate(${mapX(flight.x)}, ${mapY(flight.y)})`}>
          <circle r="22" fill="#c6cdd1" stroke="#99a2a7" strokeWidth="1.5" />
          <circle r="15" fill="none" stroke="#99a2a7" strokeDasharray="4 3" />
          <PlaneGlyph color={flight.priority === 3 ? '#c62828' : '#33608e'} />
          <text y="38" textAnchor="middle" fontSize="11.5" fontWeight="700" fill="#2f3a40">{flight.flight_no} · {flight.gate}</text>
          <title>{`${flight.flight_no} · ${flight.gate}`}</title>
        </g>
      ))}
      {/* 加油车 */}
      {vehicles.map((vehicle) => (
        <g key={vehicle.id} transform={`translate(${mapX(vehicle.x)}, ${mapY(vehicle.y)})`}>
          <circle r="12" fill={vehicleColor(vehicle.status)} stroke="#ffffff" strokeWidth="2" />
          <text y="4" textAnchor="middle" fontSize="10" fontWeight="700" fill="#ffffff">油</text>
          <title>{`${vehicle.code} · ${vehicle.driver}`}</title>
        </g>
      ))}
    </svg>
  );
}

function DispatchTimeline({ vehicles, tasks }) {
  const activeTasks = tasks.filter((task) => task.state === 'PENDING' || task.state === 'IN_PROGRESS');
  const marks = [0, 30, 60, 90];
  return (
    <Paper variant="outlined" sx={{ p: 2.25, overflow: 'hidden' }}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'start', mb: 1.5 }}>
        <Box><Typography variant="h6">车辆任务时间轴</Typography><Typography variant="caption" color="text.secondary">以当前时刻为起点，色块表示预计抵达后约 18 分钟的保障窗口。</Typography></Box>
        <Stack direction="row" spacing={1}><Chip size="small" color="info" label="作业中" /><Chip size="small" color="warning" label="待执行" /></Stack>
      </Stack>
      <Box sx={{ minWidth: 650 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: '120px 1fr', mb: 0.5 }}><Box />
          <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary', px: 0.5 }}>{marks.map((mark) => <Typography key={mark} variant="caption">{mark === 0 ? '现在' : `+${mark} 分钟`}</Typography>)}</Box>
        </Box>
        <Stack spacing={1}>{vehicles.map((vehicle) => {
          const vehicleTasks = activeTasks.filter((task) => task.vehicle_id === vehicle.id).sort((a, b) => (a.dispatch_order || 999) - (b.dispatch_order || 999));
          return <Box key={vehicle.id} sx={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 1 }}>
            <Box><Typography variant="body2" fontWeight={700}>{vehicle.code}</Typography><Typography variant="caption" color="text.secondary">{vehicle.driver} · {stateStyle[vehicle.status]?.[0]}</Typography></Box>
            <Box sx={{ height: 38, borderRadius: 1, position: 'relative', bgcolor: 'grey.100', overflow: 'hidden', backgroundImage: 'linear-gradient(90deg, transparent 33%, #d8dde5 33.2%, transparent 33.4%, transparent 66%, #d8dde5 66.2%, transparent 66.4%)' }}>
              {vehicleTasks.map((task, index) => {
                const start = task.state === 'IN_PROGRESS' ? 1 : Math.min(82, Math.max(3, task.eta_minutes || 5) + index * 4);
                const color = task.state === 'IN_PROGRESS' ? 'info.main' : task.locked ? 'primary.main' : 'warning.main';
                return <Box key={task.id} title={`${task.flight_no} · ${task.gate}`} sx={{ position: 'absolute', left: `${start}%`, width: '18%', minWidth: 72, top: 7, height: 24, px: 0.75, borderRadius: 1, bgcolor: color, color: 'common.white', display: 'flex', alignItems: 'center', fontSize: 11, fontWeight: 700, boxShadow: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{task.flight_no}{task.locked ? ' · 锁定' : ''}</Box>;
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
  const [selectedVehicle, setSelectedVehicle] = useState('');
  const [plannedEta, setPlannedEta] = useState('');
  const [plannedOrder, setPlannedOrder] = useState('');
  const [handlingAlert, setHandlingAlert] = useState(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [resolvingAlert, setResolvingAlert] = useState(false);
  const [activeSection, setActiveSection] = useState('overview');
  const [importing, setImporting] = useState(false);
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastContent, setBroadcastContent] = useState('');
  const [broadcastLevel, setBroadcastLevel] = useState('INFO');
  const [broadcastFlight, setBroadcastFlight] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API}/overview`, { headers: apiHeaders() });
      if (!response.ok) throw new Error('调度服务暂不可用，请确认后端已启动。');
      setData(await response.json());
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function command(path, payload = {}) {
    const response = await fetch(`${API}${path}`, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify(payload) });
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
    const file = event.target.files?.[0]; if (!file) return; setImporting(true);
    try {
      const content = await file.text(); const items = file.name.toLowerCase().endsWith('.json') ? JSON.parse(content) : csvRows(content);
      const response = await fetch(`${API}/admin/flights/import`, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify({ flights: items }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error);
      setMessage(`${body.message}${body.rejected?.length ? `；拒绝 ${body.rejected.length} 条格式错误数据` : ''}`);
      setError(''); await load();
    } catch (err) { setError(`导入失败：${err.message}`); } finally { setImporting(false); event.target.value = ''; }
  }

  async function sendBroadcast(event) {
    event.preventDefault(); setBroadcasting(true);
    try {
      await command('/admin/broadcasts', { title: broadcastTitle, content: broadcastContent, level: broadcastLevel, flightId: broadcastFlight || null });
      setBroadcastTitle(''); setBroadcastContent(''); setBroadcastLevel('INFO'); setBroadcastFlight('');
    } catch (err) { setError(`播报发送失败：${err.message}`); } finally { setBroadcasting(false); }
  }

  async function override() {
    try {
      await command(`/tasks/${overrideTask.id}/override`, {
        vehicleId: selectedVehicle,
        etaMinutes: plannedEta,
        dispatchOrder: plannedOrder
      });
      setOverrideTask(null);
    } catch (err) { setError(err.message); }
  }

  async function openAlertHandling(alert) {
    setHandlingAlert({ alert, loading: true, details: null });
    setResolutionNote('');
    try {
      const response = await fetch(`${API}/alerts/${alert.id}/recommendations`, { headers: apiHeaders() });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '无法获取处置建议');
      setHandlingAlert({ alert, loading: false, details: body });
    } catch (err) {
      setError(err.message);
      setHandlingAlert(null);
    }
  }

  async function resolveAlert() {
    setResolvingAlert(true);
    try {
      await command(`/alerts/${handlingAlert.alert.id}/resolve`, { resolution: resolutionNote });
      setHandlingAlert(null);
    } catch (err) { setError(err.message); } finally { setResolvingAlert(false); }
  }

  function jumpTo(id) {
    setActiveSection(id);
    document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

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
        <Box sx={{ display: 'flex', alignItems: { xs: 'start', sm: 'center' }, justifyContent: 'space-between', gap: 2, flexDirection: { xs: 'column', sm: 'row' } }}>
          <Box>
            <Typography variant="h4">调度人员工作台</Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>{currentUser()?.display_name}</Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={load}>刷新态势</Button>
            <Button variant="contained" onClick={optimize} disabled={assigning}>{assigning ? '计算中…' : '生成调度方案'}</Button>
          </Stack>
        </Box>

        <ApiError message={error} />
        {message && <Alert severity="success" onClose={() => setMessage('')}>{message}</Alert>}

        {data && <>
          <Grid id="section-overview" container spacing={2} sx={{ scrollMarginTop: '88px' }}>
            <Grid size={{ xs: 6, md: 3 }}><Metric label="待保障航班" value={data.stats.waiting} note="按优先级进入调度队列" tone="warning" /></Grid>
            <Grid size={{ xs: 6, md: 3 }}><Metric label="进行中工单" value={data.stats.activeTasks} note="含已下发与正在作业" tone="info" /></Grid>
            <Grid size={{ xs: 6, md: 3 }}><Metric label="车辆利用率" value={`${data.stats.vehicleUtilization}%`} note="当前班组实时占用" tone="success" /></Grid>
            <Grid size={{ xs: 6, md: 3 }}><Metric label="严重风险" value={data.stats.criticalAlerts} note="须由调度员尽快处理" tone="error" /></Grid>
          </Grid>

          <Grid container spacing={2}>
            <Grid id="section-map" size={{ xs: 12, xl: 7 }} sx={{ scrollMarginTop: '88px' }}>
              <Paper variant="outlined" sx={{ p: 2.25, height: '100%' }}>
                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                  <Box><Typography variant="h6">机坪态势</Typography><Typography variant="caption" color="text.secondary">示意布局，不代表真实机场地图</Typography></Box>
                  <Chip label={`${data.stats.availableVehicles} 辆可用`} color="success" size="small" />
                </Stack>
                <Box sx={{ borderRadius: 2, overflow: 'hidden', border: '1px solid', borderColor: 'divider' }}>
                  <ApronMap flights={data.flights.filter((f) => f.status !== 'COMPLETED')} vehicles={data.vehicles} />
                </Box>
                <Stack direction="row" spacing={2} useFlexGap sx={{ mt: 1.5, flexWrap: 'wrap' }}><Typography variant="caption">● 机位与航班</Typography><Typography variant="caption" color="success.main">● 可用加油车</Typography><Typography variant="caption" color="info.main">● 已预留/作业中</Typography><Typography variant="caption" color="text.secondary">● 维修中</Typography></Stack>
              </Paper>
            </Grid>
            <Grid id="section-alerts" size={{ xs: 12, xl: 5 }} sx={{ scrollMarginTop: '88px' }}>
              <Paper variant="outlined" sx={{ p: 2.25, height: '100%' }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.25 }}><WarningOutlined style={{ color: '#ed6c02' }} /><Typography variant="h6">风险预警</Typography></Stack>
                {data.alerts.length === 0 ? <Alert severity="success">当前没有未处理风险，所有约束校验通过。</Alert> : <Stack spacing={1}>{data.alerts.map((item) => <Alert key={item.id} severity={item.level === 'CRITICAL' ? 'error' : 'warning'} variant="outlined" action={<Button color="inherit" size="small" onClick={() => openAlertHandling(item)}>处置</Button>}><Typography variant="body2">{item.message}</Typography><Typography variant="caption" color="text.secondary">{item.type} · {new Date(item.created_at).toLocaleTimeString()}</Typography></Alert>)}</Stack>}
                {data.recentResolutions?.length > 0 && <Box sx={{ mt: 1.5, pt: 1.25, borderTop: '1px solid', borderColor: 'divider' }}><Typography variant="caption" color="text.secondary">最近已闭环：{data.recentResolutions[0].resolution}</Typography></Box>}
              </Paper>
            </Grid>
          </Grid>

          <Box id="section-timeline" sx={{ scrollMarginTop: '88px' }}><DispatchTimeline vehicles={data.vehicles} tasks={data.tasks} /></Box>

          <Paper id="section-tasks" variant="outlined" sx={{ overflow: 'hidden', scrollMarginTop: '88px' }}>
            <Box sx={{ p: 2.25, pb: 1 }}><Typography variant="h6">作业工单</Typography><Typography variant="body2" color="text.secondary">先由智能调度生成方案；调度员可对待执行工单微调车辆、预计到达时间和执行顺序。人工调整会锁定该工单，执行状态仍由对应油车工作人员上报。</Typography></Box>
            <Table size="small" sx={{ minWidth: 760 }}>
              <TableHead><TableRow><TableCell>顺序</TableCell><TableCell>航班 / 机位</TableCell><TableCell>优先级</TableCell><TableCell>已派车辆</TableCell><TableCell>预计到达</TableCell><TableCell>状态</TableCell><TableCell align="right">操作</TableCell></TableRow></TableHead>
              <TableBody>{data.tasks.map((task) => <TableRow key={task.id} hover><TableCell>{task.state === 'PENDING' ? <Chip size="small" label={`#${task.dispatch_order || '—'}`} variant="outlined" /> : '—'}</TableCell><TableCell><Typography fontWeight={600}>{task.flight_no}</Typography><Typography variant="caption" color="text.secondary">{task.gate} · 需油 {task.fuel_needed.toLocaleString()} L</Typography></TableCell><TableCell><Chip size="small" color={task.priority === 3 ? 'error' : task.priority === 2 ? 'warning' : 'default'} label={task.priority === 3 ? '高' : task.priority === 2 ? '中' : '低'} /></TableCell><TableCell>{task.vehicle_code ?? '未分配'}<Typography variant="caption" display="block" color="text.secondary">{task.driver ?? ''}</Typography></TableCell><TableCell>{task.eta_minutes ? `${task.eta_minutes} 分钟` : '—'}</TableCell><TableCell><Stack direction="row" spacing={0.5}><StateChip value={task.state} />{Boolean(task.locked) && <Chip size="small" label="人工锁定" variant="outlined" />}</Stack></TableCell><TableCell align="right">{task.state === 'PENDING' ? <Button size="small" variant="outlined" onClick={() => { setOverrideTask(task); setSelectedVehicle(task.vehicle_id ?? ''); setPlannedEta(task.eta_minutes ?? ''); setPlannedOrder(task.dispatch_order || 1); }}>微调方案</Button> : <Typography variant="caption" color="text.secondary">由司机上报</Typography>}</TableCell></TableRow>)}</TableBody>
            </Table>
          </Paper>

          <Grid container spacing={2}>
            <Grid id="section-resources" size={{ xs: 12, lg: 7 }} sx={{ scrollMarginTop: '88px' }}><Paper variant="outlined" sx={{ p: 2.25 }}><Typography variant="h6" mb={1.5}>加油车资源</Typography><Stack spacing={1.5}>{data.vehicles.map((vehicle) => <Box key={vehicle.id}><Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}><Typography variant="body2" fontWeight={600}>{vehicle.code} <Typography component="span" variant="caption" color="text.secondary">· {vehicle.driver}</Typography></Typography><Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}><Typography variant="caption">{vehicle.fuel_level.toLocaleString()} / {vehicle.capacity.toLocaleString()} L</Typography><StateChip value={vehicle.status} /></Stack></Stack><LinearProgress variant="determinate" value={Math.round(vehicle.fuel_level / vehicle.capacity * 100)} color={vehicle.fuel_level / vehicle.capacity < .35 ? 'warning' : 'primary'} /></Box>)}</Stack></Paper></Grid>
            <Grid size={{ xs: 12, lg: 5 }}><Paper variant="outlined" sx={{ p: 2.25, height: '100%' }}><Typography variant="h6">运行指标</Typography><Stack spacing={2} mt={2}><Box><Stack direction="row" sx={{ justifyContent: 'space-between' }}><Typography variant="body2">按时保障率</Typography><Typography variant="body2" fontWeight={700}>{data.stats.onTimeRate}%</Typography></Stack><LinearProgress variant="determinate" value={data.stats.onTimeRate} color="success" sx={{ mt: 0.75 }} /></Box></Stack></Paper></Grid>
          </Grid>

          <Paper id="section-import" variant="outlined" sx={{ p: 2.25, scrollMarginTop: '88px' }}>
            <Typography variant="h6">导入航班数据</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>支持 UTF-8 的 CSV 或 JSON 数组。CSV 表头：flightNo、gate、departureAt、fuelNeeded、priority、x、y。</Typography>
            <Stack direction="row" spacing={1.5} sx={{ mt: 2, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button component="label" variant="contained" disabled={importing}>{importing ? '导入中…' : '选择 CSV 或 JSON 文件'}<input hidden type="file" accept=".csv,.json,application/json,text/csv" onChange={importFile} /></Button>
              <Typography variant="caption" color="text.secondary">示例：{example}</Typography>
            </Stack>
          </Paper>

          <Paper id="section-broadcast" component="form" onSubmit={sendBroadcast} variant="outlined" sx={{ p: 2.25, scrollMarginTop: '88px' }}>
            <Typography variant="h6">现场情况播报</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>发布后会在右上角“运行通知”中出现，用于传达临时机位调整、天气影响、加油准备或其他现场情况。</Typography>
            <Stack spacing={1.5} sx={{ mt: 2 }}>
              <TextField required label="播报标题" value={broadcastTitle} onChange={(event) => setBroadcastTitle(event.target.value)} placeholder="例如：B 区机坪临时管制" inputProps={{ maxLength: 40 }} />
              <TextField required label="播报内容" multiline minRows={3} value={broadcastContent} onChange={(event) => setBroadcastContent(event.target.value)} placeholder="请描述当前实际情况、影响范围及需要关注的事项" inputProps={{ maxLength: 300 }} />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <Select aria-label="播报级别" value={broadcastLevel} onChange={(event) => setBroadcastLevel(event.target.value)} sx={{ minWidth: 150 }}>
                  <MenuItem value="INFO">普通播报</MenuItem>
                  <MenuItem value="WARNING">需关注</MenuItem>
                  <MenuItem value="CRITICAL">紧急播报</MenuItem>
                </Select>
                <Select aria-label="关联航班" value={broadcastFlight} onChange={(event) => setBroadcastFlight(event.target.value)} displayEmpty sx={{ minWidth: 220 }}>
                  <MenuItem value="">不关联航班</MenuItem>
                  {data.flights.map((flight) => <MenuItem key={flight.id} value={flight.id}>{flight.flight_no} · {flight.gate}</MenuItem>)}
                </Select>
              </Stack>
              <Box><Button type="submit" variant="contained" disabled={broadcasting}>{broadcasting ? '发送中…' : '发布播报'}</Button></Box>
            </Stack>
          </Paper>
        </>}
      </Stack>

      <Dialog open={Boolean(overrideTask)} onClose={() => setOverrideTask(null)} fullWidth maxWidth="xs">
        <DialogTitle>人工微调调度方案</DialogTitle>
        <DialogContent><Typography variant="body2" color="text.secondary" mb={2.5}>保存后将锁定本工单，后续自动调度不会覆盖你的车辆、时间和顺序安排。系统会校验车辆状态与可用油量。</Typography><Stack spacing={2.25}><Stack spacing={0.75}><Typography variant="body2" fontWeight={700}>指定加油车</Typography><Select aria-label="指定加油车" fullWidth value={selectedVehicle} onChange={(event) => setSelectedVehicle(event.target.value)}>{data?.vehicles.map((vehicle) => <MenuItem key={vehicle.id} value={vehicle.id}>{vehicle.code} · {vehicle.driver} · {vehicle.fuel_level.toLocaleString()} L · {stateStyle[vehicle.status]?.[0]}</MenuItem>)}</Select></Stack><Stack spacing={0.75}><Typography variant="body2" fontWeight={700}>预计到达（分钟）</Typography><TextField aria-label="预计到达（分钟）" fullWidth type="number" value={plannedEta} onChange={(event) => setPlannedEta(event.target.value)} inputProps={{ min: 1, max: 180 }} /></Stack><Stack spacing={0.75}><Typography variant="body2" fontWeight={700}>执行顺序</Typography><TextField aria-label="执行顺序" fullWidth type="number" value={plannedOrder} onChange={(event) => setPlannedOrder(event.target.value)} inputProps={{ min: 1, max: data?.tasks.filter((task) => task.state === 'PENDING').length ?? 1 }} /><Typography variant="caption" color="text.secondary">1 为当前待执行队列中的最优先工单</Typography></Stack></Stack></DialogContent>
        <DialogActions><Button onClick={() => setOverrideTask(null)}>取消</Button><Button variant="contained" onClick={override} disabled={!selectedVehicle || !plannedEta || !plannedOrder}>保存微调</Button></DialogActions>
      </Dialog>

      <Dialog open={Boolean(handlingAlert)} onClose={() => !resolvingAlert && setHandlingAlert(null)} fullWidth maxWidth="sm">
        <DialogTitle>异常处置与资源建议</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" mb={2}>{handlingAlert?.alert.message}</Typography>
          {handlingAlert?.loading ? <LinearProgress /> : <Stack spacing={1.25}>
            <Typography variant="subtitle2">可协调资源</Typography>
            {handlingAlert?.details?.candidates?.length ? handlingAlert.details.candidates.map((vehicle) => <Paper key={vehicle.id} variant="outlined" sx={{ p: 1.25 }}><Stack direction="row" sx={{ justifyContent: 'space-between', gap: 1 }}><Typography variant="body2" fontWeight={700}>{vehicle.code} · {vehicle.driver}</Typography><StateChip value={vehicle.status} /></Stack><Typography variant="caption" display="block" color="text.secondary" mt={0.5}>可用油量 {vehicle.fuel_level.toLocaleString()} L · {vehicle.recommendation}</Typography></Paper>) : <Alert severity="warning">当前没有满足油量约束的可协调车辆。请安排补油、外援或调整保障计划后再处置。</Alert>}
            <TextField label="处置说明" placeholder="例如：已协调 JF-03 完成当前任务后接续保障" multiline minRows={3} value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} helperText="处置完成后将归档，供交接班追溯。" />
          </Stack>}
        </DialogContent>
        <DialogActions><Button onClick={() => setHandlingAlert(null)} disabled={resolvingAlert}>取消</Button><Button variant="contained" onClick={resolveAlert} disabled={handlingAlert?.loading || resolutionNote.trim().length < 4 || resolvingAlert}>{resolvingAlert ? '归档中…' : '确认处置并归档'}</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
