import { Link as RouterLink, useRouteError } from 'react-router-dom';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';

export default function RouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : '页面暂时无法加载。';

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 3, bgcolor: 'grey.50' }}>
      <Paper sx={{ maxWidth: 460, width: '100%', p: 4, textAlign: 'center' }}>
        <Typography variant="h4" gutterBottom>页面未找到</Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>{message}</Typography>
        <Button component={RouterLink} to="/" variant="contained">返回调度指挥台</Button>
      </Paper>
    </Box>
  );
}
