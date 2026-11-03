// material-ui
import { useState } from 'react';
import Alert from '@mui/material/Alert';
import useMediaQuery from '@mui/material/useMediaQuery';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

// project imports
import Notification from './Notification';
import MobileSection from './MobileSection';
import { apiFetch, apiHeaders, clearUser, currentUser } from 'utils/auth';
import { useNavigate } from 'react-router-dom';

// ==============================|| HEADER - CONTENT ||============================== //

export default function HeaderContent() {
  const downLG = useMediaQuery((theme) => theme.breakpoints.down('lg'));
  const user = currentUser();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  async function logout() {
    setLoggingOut(true);
    setLogoutError('');
    try {
      const api = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8080/api';
      const response = await apiFetch(`${api}/auth/logout`, { method: 'POST', headers: apiHeaders(true), body: '{}' });
      if (!response.ok) throw new Error('退出失败，请重试');
      clearUser();
      navigate('/login', { replace: true });
    } catch (err) {
      setLogoutError(err.message);
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <>
      <Box sx={{ flexGrow: 1 }} />
      {logoutError && <Alert severity="error" sx={{ py: 0 }}>{logoutError}</Alert>}
      <Notification />
      {!downLG && <Typography variant="body2" sx={{ mr: 1.5 }}>{user?.display_name}</Typography>}
      <Button size="small" disabled={loggingOut} onClick={logout}>{loggingOut ? '退出中…' : '退出'}</Button>
      {downLG && <MobileSection />}
    </>
  );
}
