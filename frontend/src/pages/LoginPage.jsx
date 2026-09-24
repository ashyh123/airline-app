import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { saveUser } from 'utils/auth';

const API = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8080/api';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingUser, setPendingUser] = useState(null);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const navigate = useNavigate();

  async function login(event) {
    event.preventDefault();
    setLoading(true);
    try {
      const response = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? '登录失败');
      if (data.user.must_change) {
        setPendingUser(data.user);
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        saveUser(data.user);
        navigate('/', { replace: true });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`${API}/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pendingUser.token}` },
        body: JSON.stringify({ oldPassword, newPassword })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? '密码修改失败');
      saveUser({ ...data.user, token: pendingUser.token });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (pendingUser) {
    return (
      <Box sx={{ minHeight: '100vh', p: { xs: 2, sm: 3 }, display: 'grid', placeItems: 'center', bgcolor: '#f4f7fb' }}>
        <Box sx={{ width: '100%', maxWidth: 460 }}>
          <Card sx={{ overflow: 'hidden' }}>
            <Box sx={{ px: { xs: 2.5, sm: 3.5 }, pt: { xs: 3, sm: 3.5 }, pb: 2.5 }}>
              <Typography variant="h4">首次登录，请修改初始密码</Typography>
              <Typography color="text.secondary" sx={{ mt: 1 }}>{pendingUser.display_name}（{pendingUser.emp_no ?? pendingUser.username}）· 为保障账号安全，使用初始密码登录后必须先设置新密码</Typography>
            </Box>
            <Divider />
            <Stack component="form" spacing={2} onSubmit={changePassword} sx={{ px: { xs: 2.5, sm: 3.5 }, py: 3.5 }}>
              <Stack spacing={0.75}><Typography variant="body2" fontWeight={700}>初始密码</Typography><TextField autoFocus required fullWidth type="password" aria-label="初始密码" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} placeholder="请输入管理员交付的初始密码" /></Stack>
              <Stack spacing={0.75}><Typography variant="body2" fontWeight={700}>新密码</Typography><TextField required fullWidth type="password" aria-label="新密码" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="8 位以上，须包含字母和数字" /></Stack>
              <Stack spacing={0.75}><Typography variant="body2" fontWeight={700}>确认新密码</Typography><TextField required fullWidth type="password" aria-label="确认新密码" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入新密码" /></Stack>
              {error && <Alert severity="error">{error}</Alert>}
              <Button type="submit" variant="contained" size="large" disabled={loading}>{loading ? <CircularProgress size={22} color="inherit" /> : '保存并进入工作台'}</Button>
            </Stack>
          </Card>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: '100vh', p: { xs: 2, sm: 3 }, display: 'grid', placeItems: 'center', bgcolor: '#f4f7fb' }}>
      <Box sx={{ width: '100%', maxWidth: 460 }}>
        <Card sx={{ overflow: 'hidden' }}>
          <Box sx={{ px: { xs: 2.5, sm: 3.5 }, pt: { xs: 3, sm: 3.5 }, pb: 2.5 }}>
            <Typography variant="h4">机场加油车智能调度系统</Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>登录后，系统会根据账号权限自动进入对应工作台</Typography>
          </Box>
          <Divider />
          <Stack component="form" spacing={2} onSubmit={login} sx={{ px: { xs: 2.5, sm: 3.5 }, py: 3.5 }}>
            <Typography variant="h5">账号登录</Typography>
            <Stack spacing={0.75}><Typography variant="body2" fontWeight={700}>账号</Typography><TextField autoFocus required fullWidth aria-label="账号" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="请输入账号" /></Stack>
            <Stack spacing={0.75}><Typography variant="body2" fontWeight={700}>密码</Typography><TextField required fullWidth aria-label="密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" /></Stack>
            {error && <Alert severity="error">{error}</Alert>}
            <Button type="submit" variant="contained" size="large" disabled={loading}>{loading ? <CircularProgress size={22} color="inherit" /> : '登录'}</Button>
            <Alert severity="info" variant="outlined"><Typography variant="caption" display="block">演示账号：dispatch01 / dispatch123；driver03 / driver123；admin01 / admin123。</Typography><Typography variant="caption">新建账号首次登录须修改初始密码。</Typography></Alert>
          </Stack>
        </Card>
      </Box>
    </Box>
  );
}
