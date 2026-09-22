// material-ui
import useMediaQuery from '@mui/material/useMediaQuery';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

// project imports
import Notification from './Notification';
import MobileSection from './MobileSection';
import { clearUser, currentUser } from 'utils/auth';
import { useNavigate } from 'react-router-dom';

// ==============================|| HEADER - CONTENT ||============================== //

export default function HeaderContent() {
  const downLG = useMediaQuery((theme) => theme.breakpoints.down('lg'));
  const user = currentUser();
  const navigate = useNavigate();

  function logout() {
    clearUser();
    navigate('/login', { replace: true });
  }

  return (
    <>
      <Box sx={{ flexGrow: 1 }} />
      <Notification />
      {!downLG && <Typography variant="body2" sx={{ mr: 1.5 }}>{user?.display_name}</Typography>}
      <Button size="small" onClick={logout}>退出</Button>
      {downLG && <MobileSection />}
    </>
  );
}
