import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export default function AdminWorkspace() {
  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h4">系统管理</Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5 }}>航班数据导入与现场情况播报已移交调度人员工作台。</Typography>
      </Box>
    </Stack>
  );
}
