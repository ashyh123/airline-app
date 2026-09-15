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
