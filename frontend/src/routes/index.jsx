import { createBrowserRouter } from 'react-router-dom';

// project imports
import MainRoutes from './MainRoutes';
import LoginPage from 'pages/LoginPage';

// ==============================|| ROUTING RENDER ||============================== //

const router = createBrowserRouter([MainRoutes, { path: '/login', element: <LoginPage /> }], { basename: import.meta.env.VITE_APP_BASE_NAME });

export default router;
