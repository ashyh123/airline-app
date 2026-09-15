import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import useMediaQuery from '@mui/material/useMediaQuery';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemAvatar from '@mui/material/ListItemAvatar';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Popper from '@mui/material/Popper';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import MainCard from 'components/MainCard';
import IconButton from 'components/@extended/IconButton';
import Transitions from 'components/@extended/Transitions';
import { apiHeaders, currentUser } from 'utils/auth';

import BellOutlined from '@ant-design/icons/BellOutlined';
import CheckCircleOutlined from '@ant-design/icons/CheckCircleOutlined';
import ClockCircleOutlined from '@ant-design/icons/ClockCircleOutlined';
import NotificationOutlined from '@ant-design/icons/NotificationOutlined';
import SafetyCertificateOutlined from '@ant-design/icons/SafetyCertificateOutlined';
import WarningOutlined from '@ant-design/icons/WarningOutlined';

const API = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8080/api';
const avatarSX = { width: 36, height: 36, fontSize: '1rem' };

function formatTime(value) {
  if (!value) return '刚刚';
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function dispatcherNotices(data) {
  const broadcasts = (data.broadcasts ?? []).map((item) => ({
    id: `broadcast-${item.id}`,
    title: item.title,
    detail: item.content,
    createdAt: item.created_at,
    tone: item.level === 'CRITICAL' ? 'error' : item.level === 'WARNING' ? 'warning' : 'info',
    icon: <NotificationOutlined />
  }));
  const risks = (data.alerts ?? []).map((alert) => ({
    id: `alert-${alert.id}`,
    title: alert.level === 'CRITICAL' ? '需立即处置的运行风险' : '运行风险提醒',
    detail: alert.message,
    createdAt: alert.created_at,
    tone: alert.level === 'CRITICAL' ? 'error' : 'warning',
    icon: <WarningOutlined />
  }));
  const tasks = (data.tasks ?? []).filter((task) => task.state === 'PENDING' || task.state === 'IN_PROGRESS').map((task) => ({
    id: `task-${task.id}-${task.state}-${task.updated_at}`,
    title: task.locked ? '人工微调方案已锁定' : task.state === 'IN_PROGRESS' ? '加油作业正在进行' : '调度方案待执行',
    detail: `${task.flight_no} · ${task.gate}${task.vehicle_code ? ` · ${task.vehicle_code}` : ''}${task.eta_minutes ? ` · 预计 ${task.eta_minutes} 分钟到达` : ''}`,
    createdAt: task.updated_at,
    tone: task.locked ? 'primary' : task.state === 'IN_PROGRESS' ? 'info' : 'success',
    icon: task.locked ? <SafetyCertificateOutlined /> : <ClockCircleOutlined />
  }));
  return [...broadcasts, ...risks, ...tasks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 12);
}

function driverNotices(data) {
  return (data.tasks ?? []).map((task) => ({
    id: `driver-task-${task.id}-${task.state}-${task.updated_at}`,
    title: task.state === 'IN_PROGRESS' ? '你的加油工单正在执行' : '你有新的待执行加油工单',
    detail: `${task.flight_no} · ${task.gate} · 需油 ${task.fuel_needed.toLocaleString()} L${task.eta_minutes ? ` · 计划 ${task.eta_minutes} 分钟` : ''}`,
    createdAt: task.updated_at,
    tone: task.state === 'IN_PROGRESS' ? 'info' : 'success',
    icon: <ClockCircleOutlined />
  })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
}

export default function Notification() {
  const downMD = useMediaQuery((theme) => theme.breakpoints.down('md'));
  const user = currentUser();
  const anchorRef = useRef(null);
  const [notices, setNotices] = useState([]);
  const [readIds, setReadIds] = useState(() => new Set());
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  const loadNotices = useCallback(async () => {
    if (!user?.role) return;
    try {
      const endpoint = user.role === 'DRIVER' ? '/driver/tasks' : '/overview';
      const response = await fetch(`${API}${endpoint}`, { headers: apiHeaders() });
      if (!response.ok) throw new Error('运行通知暂不可用');
      const payload = await response.json();
      setNotices(user.role === 'DRIVER' ? driverNotices(payload) : dispatcherNotices(payload));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [user?.role]);

  useEffect(() => {
    loadNotices();
    const timer = window.setInterval(loadNotices, 10000);
    return () => window.clearInterval(timer);
  }, [loadNotices]);

  const unread = useMemo(() => notices.filter((notice) => !readIds.has(notice.id)).length, [notices, readIds]);
  const handleToggle = () => { setOpen((previous) => !previous); loadNotices(); };
  const handleClose = (event) => {
    if (anchorRef.current && anchorRef.current.contains(event.target)) return;
    setOpen(false);
  };
  const markAllRead = () => setReadIds(new Set(notices.map((notice) => notice.id)));

  return (
    <Box sx={{ flexShrink: 0, ml: 0.75 }}>
      <IconButton color="secondary" variant="light" sx={{ color: 'text.primary', bgcolor: open ? 'grey.100' : 'transparent' }} aria-label="打开运行通知" ref={anchorRef} aria-controls={open ? 'notice-grow' : undefined} aria-haspopup="true" onClick={handleToggle}>
        <Badge badgeContent={unread} color="error" max={9}><BellOutlined /></Badge>
      </IconButton>
      <Popper placement={downMD ? 'bottom' : 'bottom-end'} open={open} anchorEl={anchorRef.current} transition disablePortal popperOptions={{ modifiers: [{ name: 'offset', options: { offset: [downMD ? -5 : 0, 9] } }] }}>
        {({ TransitionProps }) => (
          <Transitions type="grow" position={downMD ? 'top' : 'top-right'} in={open} {...TransitionProps}>
            <Paper sx={(theme) => ({ boxShadow: theme.customShadows.z1, width: '100%', minWidth: 300, maxWidth: { xs: 320, md: 440 } })}>
              <ClickAwayListener onClickAway={handleClose}>
                <MainCard title="运行通知与实时播报" elevation={0} border={false} content={false} secondary={unread > 0 ? <Tooltip title="全部标为已读"><IconButton color="success" size="small" onClick={markAllRead}><CheckCircleOutlined style={{ fontSize: '1.15rem' }} /></IconButton></Tooltip> : null}>
                  {error ? <Alert severity="error" sx={{ m: 2 }}>{error}</Alert> : notices.length === 0 ? <Box sx={{ px: 2, py: 3 }}><Typography color="text.secondary" align="center">当前没有需要关注的航班或车辆运行情况。</Typography></Box> : <List component="nav" sx={{ p: 0, maxHeight: 420, overflow: 'auto', '& .MuiListItemButton-root': { py: 0.75, px: 2, '&.Mui-selected': { bgcolor: 'grey.50' }, '& .MuiAvatar-root': avatarSX } }}>
                    {notices.map((notice) => <ListItem key={notice.id} component={ListItemButton} divider selected={!readIds.has(notice.id)} onClick={() => setReadIds((previous) => new Set([...previous, notice.id]))} secondaryAction={<Typography variant="caption" noWrap>{formatTime(notice.createdAt)}</Typography>}>
                      <ListItemAvatar><Avatar sx={{ color: `${notice.tone}.main`, bgcolor: `${notice.tone}.lighter` }}>{notice.icon}</Avatar></ListItemAvatar>
                      <ListItemText primary={<Typography variant="subtitle2">{notice.title}</Typography>} secondary={notice.detail} slotProps={{ secondary: { sx: { pr: 5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } } }} />
                    </ListItem>)}
                  </List>}
                </MainCard>
              </ClickAwayListener>
            </Paper>
          </Transitions>
        )}
      </Popper>
    </Box>
  );
}
