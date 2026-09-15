// assets
import { DeploymentUnitOutlined } from '@ant-design/icons';

// icons
const icons = {
  DeploymentUnitOutlined
};

// ==============================|| MENU ITEMS - DASHBOARD ||============================== //

const dashboard = {
  id: 'group-dashboard',
  title: '运行中心',
  type: 'group',
  children: [
    {
      id: 'dashboard',
      title: '我的工作台',
      type: 'item',
      url: '/',
      icon: icons.DeploymentUnitOutlined,
      breadcrumbs: false
    }
  ]
};

export default dashboard;
