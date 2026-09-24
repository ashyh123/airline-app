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
const WORK_LABEL = { ON_DUTY: '值班', STANDBY: '休闲', RESTING: '休息' };
const WORK_TONE = { ON_DUTY: 'success', STANDBY: 'info', RESTING: 'default' };
const ROLE_LABEL = { DISPATCHER: '调度人员', DRIVER: '加油人员' };

function genPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `Fuel@${suffix}`;
}

const EMPTY_FORM = { role: 'DRIVER', empNo: '', name: '', username: '', password: genPassword(), phone: '' };

export default function AdminWorkspace() {
  const [personnel, setPersonnel] = useState([]);
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', phone: '' });
  const [resetResult, setResetResult] = useState(null);
  const [toggleTarget, setToggleTarget] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (role) params.set('role', role);
      if (status) params.set('status', status);
      if (keyword.trim()) params.set('q', keyword.trim());
      const response = await fetch(`${API}/admin/personnel?${params.toString()}`, { headers: apiHeaders() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setPersonnel(data.personnel);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [role, status, keyword]);

  useEffect(() => { load(); }, [load]);

  async function post(path, body) {
    const response = await fetch(`${API}${path}`, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify(body ?? {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '操作未完成');
    return data;
  }

  async function createPerson(event) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const data = await post('/admin/personnel', form);
      setMessage(data.message);
      setCreateOpen(false);
      setForm({ ...EMPTY_FORM, password: genPassword() });
      setError('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function saveEdit() {
    setSubmitting(true);
    try {
      const response = await fetch(`${API}/admin/personnel/${editTarget.id}/profile`, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify(editForm) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMessage(data.message);
      setEditTarget(null);
      setError('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function resetPassword(person) {
    try {
      const data = await post(`/admin/personnel/${person.id}/reset-password`);
      setResetResult({ name: person.display_name, username: person.username, password: data.password });
      setMessage(data.message);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function confirmToggle() {
    setSubmitting(true);
    try {
      const action = toggleTarget.account_status === 'ENABLED' ? 'disable' : 'enable';
      const data = await post(`/admin/personnel/${toggleTarget.id}/${action}`);
      setMessage(data.message);
      setToggleTarget(null);
      setError('');
      await load();
    } catch (err) {
      setError(err.message);
      setToggleTarget(null);
    } finally {
      setSubmitting(false);
    }
  }

  const setField = (key) => (event) => setForm((previous) => ({ ...previous, [key]: event.target.value }));

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h4">人员与账号管理</Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5 }}>登记调度人员和加油人员并开通登录账号；工作状态与车辆由调度人员日常维护。</Typography>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      {message && <Alert severity="success" onClose={() => setMessage('')}>{message}</Alert>}

      <Paper variant="outlined" sx={{ p: 2.25 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Select aria-label="角色筛选" value={role} onChange={(event) => setRole(event.target.value)} displayEmpty sx={{ minWidth: 140 }}>
            <MenuItem value="">全部角色</MenuItem>
            <MenuItem value="DISPATCHER">调度人员</MenuItem>
            <MenuItem value="DRIVER">加油人员</MenuItem>
          </Select>
          <Select aria-label="账号状态筛选" value={status} onChange={(event) => setStatus(event.target.value)} displayEmpty sx={{ minWidth: 140 }}>
            <MenuItem value="">全部状态</MenuItem>
            <MenuItem value="ENABLED">启用</MenuItem>
            <MenuItem value="DISABLED">停用</MenuItem>
          </Select>
          <TextField aria-label="搜索" size="small" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="按工号、姓名、账号搜索" sx={{ minWidth: 220 }} />
          <Box sx={{ flexGrow: 1 }} />
          <Button variant="contained" onClick={() => setCreateOpen(true)}>创建人员账号</Button>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
        {loading ? (
          <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 200 }}><CircularProgress /></Box>
        ) : (
          <Table size="small" sx={{ minWidth: 900 }}>
            <TableHead>
              <TableRow>
                <TableCell>工号</TableCell><TableCell>姓名</TableCell><TableCell>登录账号</TableCell><TableCell>角色</TableCell>
                <TableCell>联系电话</TableCell><TableCell>工作状态</TableCell><TableCell>负责车辆</TableCell><TableCell>账号状态</TableCell>
                <TableCell>创建时间</TableCell><TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {personnel.map((person) => (
                <TableRow key={person.id} hover sx={{ opacity: person.account_status === 'DISABLED' ? 0.55 : 1 }}>
                  <TableCell>{person.emp_no ?? '—'}</TableCell>
                  <TableCell><Typography fontWeight={600}>{person.display_name}</Typography></TableCell>
                  <TableCell>{person.username}</TableCell>
                  <TableCell>{ROLE_LABEL[person.role] ?? person.role}</TableCell>
                  <TableCell>{person.phone ?? '—'}</TableCell>
                  <TableCell>{person.role === 'DRIVER' ? <Chip size="small" label={WORK_LABEL[person.work_status] ?? '—'} color={WORK_TONE[person.work_status] ?? 'default'} variant={person.work_status === 'RESTING' ? 'outlined' : 'filled'} /> : '—'}</TableCell>
                  <TableCell>{person.vehicle_code ?? '—'}</TableCell>
                  <TableCell><Chip size="small" label={person.account_status === 'ENABLED' ? '启用' : '停用'} color={person.account_status === 'ENABLED' ? 'success' : 'error'} variant="outlined" /></TableCell>
                  <TableCell>{person.created_at ? new Date(person.created_at).toLocaleString('zh-CN', { hour12: false }) : '—'}</TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
                      <Button size="small" variant="outlined" onClick={() => { setEditTarget(person); setEditForm({ name: person.display_name, phone: person.phone ?? '' }); }}>编辑</Button>
                      <Button size="small" variant="outlined" onClick={() => resetPassword(person)}>重置密码</Button>
                      <Button size="small" variant="outlined" color={person.account_status === 'ENABLED' ? 'error' : 'success'} onClick={() => setToggleTarget(person)}>{person.account_status === 'ENABLED' ? '停用' : '启用'}</Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
              {personnel.length === 0 && <TableRow><TableCell colSpan={10}><Typography color="text.secondary" sx={{ py: 2 }}>没有符合条件的人员</Typography></TableCell></TableRow>}
            </TableBody>
          </Table>
        )}
      </Paper>

      <Dialog open={createOpen} onClose={() => !submitting && setCreateOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>创建人员账号</DialogTitle>
        <DialogContent>
          <Stack component="form" id="create-person-form" onSubmit={createPerson} spacing={2} sx={{ mt: 1 }}>
            <Stack spacing={0.75}>
              <Typography variant="body2" fontWeight={700}>角色</Typography>
              <Select aria-label="角色" fullWidth value={form.role} onChange={setField('role')}>
                <MenuItem value="DRIVER">加油人员</MenuItem>
                <MenuItem value="DISPATCHER">调度人员</MenuItem>
              </Select>
              <Typography variant="caption" color="text.secondary">加油人员创建后默认为休息状态，由调度人员临时调用并绑定车辆。</Typography>
            </Stack>
            <TextField required label="工号" value={form.empNo} onChange={setField('empNo')} placeholder="如 V011" inputProps={{ maxLength: 20 }} />
            <TextField required label="姓名" value={form.name} onChange={setField('name')} placeholder="真实姓名" inputProps={{ maxLength: 20 }} />
            <TextField required label="登录账号" value={form.username} onChange={setField('username')} placeholder="3 至 20 位字母、数字或下划线" inputProps={{ maxLength: 20 }} />
            <Stack spacing={0.75}>
              <Typography variant="body2" fontWeight={700}>初始密码</Typography>
              <Stack direction="row" spacing={1}>
                <TextField required fullWidth value={form.password} onChange={setField('password')} placeholder="8 位以上，含字母和数字" />
                <Button variant="outlined" onClick={() => setForm((previous) => ({ ...previous, password: genPassword() }))}>生成</Button>
              </Stack>
              <Typography variant="caption" color="text.secondary">初始密码仅创建时展示，请线下交付本人；首次登录须修改。</Typography>
            </Stack>
            <TextField label="联系电话（选填）" value={form.phone} onChange={setField('phone')} placeholder="手机号码" inputProps={{ maxLength: 20 }} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)} disabled={submitting}>取消</Button>
          <Button type="submit" form="create-person-form" variant="contained" disabled={submitting}>{submitting ? '创建中…' : '创建账号'}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(editTarget)} onClose={() => !submitting && setEditTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>编辑人员资料</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">账号 {editTarget?.username}（{editTarget?.emp_no}）· 账号与工号创建后不可修改</Typography>
            <TextField required label="姓名" value={editForm.name} onChange={(event) => setEditForm((previous) => ({ ...previous, name: event.target.value }))} />
            <TextField label="联系电话" value={editForm.phone} onChange={(event) => setEditForm((previous) => ({ ...previous, phone: event.target.value }))} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditTarget(null)} disabled={submitting}>取消</Button>
          <Button variant="contained" onClick={saveEdit} disabled={submitting || editForm.name.trim().length < 2}>保存</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(resetResult)} onClose={() => setResetResult(null)} fullWidth maxWidth="xs">
        <DialogTitle>密码已重置</DialogTitle>
        <DialogContent>
          {resetResult && (
            <Stack spacing={1.5} sx={{ mt: 1 }}>
              <Typography variant="body2">请把新密码线下交付 {resetResult.name}（{resetResult.username}）。密码仅本次显示：</Typography>
              <Alert severity="warning" variant="outlined" action={<Button size="small" onClick={() => { navigator.clipboard?.writeText(resetResult.password); }}>复制</Button>}>{resetResult.password}</Alert>
              <Typography variant="caption" color="text.secondary">该账号已有会话已全部退出，首次登录须修改密码。</Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions><Button variant="contained" onClick={() => setResetResult(null)}>我已妥善保存</Button></DialogActions>
      </Dialog>

      <Dialog open={Boolean(toggleTarget)} onClose={() => !submitting && setToggleTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>{toggleTarget?.account_status === 'ENABLED' ? '停用账号' : '启用账号'}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mt: 1 }}>
            {toggleTarget?.account_status === 'ENABLED'
              ? `停用后 ${toggleTarget?.display_name}（${toggleTarget?.username}）将立即无法登录，已有会话失效；名下有待执行或作业中工单时将被阻止。`
              : `启用后 ${toggleTarget?.display_name}（${toggleTarget?.username}）可重新登录系统。`}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setToggleTarget(null)} disabled={submitting}>取消</Button>
          <Button color={toggleTarget?.account_status === 'ENABLED' ? 'error' : 'success'} variant="contained" onClick={confirmToggle} disabled={submitting}>确认</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
