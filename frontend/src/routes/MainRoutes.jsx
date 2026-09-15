import { Navigate } from 'react-router-dom';
import DashboardLayout from 'layout/Dashboard';
import DispatchConsole from 'pages/dispatch';
import RouteError from 'pages/RouteError';
import RoleHome from 'pages/RoleHome';

// render- Dashboard
const MainRoutes = {
  path: '/',
  element: <DashboardLayout />,
  errorElement: <RouteError />,
  children: [
    {
      index: true,
      element: <RoleHome />
    },
    {
      // Compatibility with the original dashboard template and old bookmarks.
      path: 'dashboard/default',
      element: <Navigate to="/" replace />
    },
    {
      path: '*',
      element: <Navigate to="/" replace />
    }
  ]
};

export default MainRoutes;
