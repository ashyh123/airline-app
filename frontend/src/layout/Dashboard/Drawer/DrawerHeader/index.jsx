import PropTypes from 'prop-types';

// project imports
import DrawerHeaderStyled from './DrawerHeaderStyled';
import Typography from '@mui/material/Typography';

// ==============================|| DRAWER HEADER ||============================== //

export default function DrawerHeader({ open }) {
  return (
    <DrawerHeaderStyled
      open={open}
      sx={{
        minHeight: '60px',
        width: 'initial',
        paddingTop: '8px',
        paddingBottom: '8px',
        paddingLeft: open ? '24px' : 0
      }}
    >
      {open ? (
        <BoxTitle />
      ) : (
        <Typography variant="h6" color="primary">航</Typography>
      )}
    </DrawerHeaderStyled>
  );
}

DrawerHeader.propTypes = { open: PropTypes.bool };

function BoxTitle() {
  return <Typography variant="subtitle1" fontWeight={700}>航油智能调度</Typography>;
}
