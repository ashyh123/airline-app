const KEY = 'airport-fuel-dispatch-user';

export function currentUser() {
  try { return JSON.parse(sessionStorage.getItem(KEY)); } catch { return null; }
}

export function saveUser(user) {
  sessionStorage.setItem(KEY, JSON.stringify(user));
}

export function clearUser() {
  sessionStorage.removeItem(KEY);
}

export function apiHeaders(json = false) {
  const user = currentUser();
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(user?.token ? { Authorization: `Bearer ${user.token}` } : {})
  };
}

export async function apiFetch(url, options) {
  const response = await fetch(url, options);
  const denied = response.status === 403 ? await response.clone().json().catch(() => ({})) : null;
  if (response.status === 401 || denied?.code === 'PASSWORD_CHANGE_REQUIRED') {
    clearUser();
    const reason = denied?.code === 'PASSWORD_CHANGE_REQUIRED' ? 'password-change' : 'expired';
    const base = (import.meta.env.VITE_APP_BASE_NAME ?? '/').replace(/\/?$/, '/');
    window.location.replace(`${base}login?session=${reason}`);
    throw new Error(reason === 'expired' ? '登录已失效，请重新登录' : '请重新登录并修改初始密码');
  }
  return response;
}
