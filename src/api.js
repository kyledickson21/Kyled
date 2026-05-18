const BASE = "/api";

let token = localStorage.getItem("nexus_token") || "";

export const setToken = t => { token = t; localStorage.setItem("nexus_token", t); };
export const clearToken = () => { token = ""; localStorage.removeItem("nexus_token"); };

const hdrs = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

export const authStatus = () => fetch(`${BASE}/auth/status`).then(r => r.json());
export const setupUser = (username, password) =>
  fetch(`${BASE}/auth/setup`, { method: "POST", headers: hdrs(), body: JSON.stringify({ username, password }) }).then(r => r.json());
export const login = (username, password) =>
  fetch(`${BASE}/auth/login`, { method: "POST", headers: hdrs(), body: JSON.stringify({ username, password }) }).then(r => r.json());

export const getData = () => fetch(`${BASE}/data`, { headers: hdrs() }).then(r => { if (r.status === 401) throw new Error("unauthorized"); return r.json(); });
export const saveData = (data) => fetch(`${BASE}/data`, { method: "POST", headers: hdrs(), body: JSON.stringify(data) }).then(r => r.json());
export const exportCSV = () => { window.location.href = `${BASE}/export/csv?token=${token}`; };
export const exportJSON = () => { window.location.href = `${BASE}/export/json?token=${token}`; };
