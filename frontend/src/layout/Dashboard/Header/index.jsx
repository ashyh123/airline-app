import { useMemo } from 'react';

// material-ui
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';

// project imports
import HeaderContent from './HeaderContent';

// ==============================|| MAIN LAYOUT - HEADER ||============================== //

export default function Header() {
  // header content
  const headerContent = useMemo(() => <HeaderContent />, []);

  return (
    <AppBar
      position="fixed"
      color="inherit"
      elevation={0}
      sx={{ borderBottom: '1px solid', borderBottomColor: 'divider', zIndex: 1200, width: '100%' }}
    >
      <Toolbar>{headerContent}</Toolbar>
    </AppBar>
  );
}
