import { Navigate } from 'react-router-dom';
import DispatchConsole from 'pages/dispatch';
import DriverWorkspace from 'pages/driver';
import AdminWorkspace from 'pages/admin';
import { currentUser } from 'utils/auth';

export default function RoleHome() {
  const user = currentUser();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === 'DISPATCHER') return <DispatchConsole />;
  if (user.role === 'DRIVER') return <DriverWorkspace />;
  if (user.role === 'ADMIN') return <AdminWorkspace />;
  return <Navigate to="/login" replace />;
}
