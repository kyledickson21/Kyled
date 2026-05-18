const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE = path.join(__dirname, "..", "nexus-data.json");

function readStore() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {}
  return { users: [], appData: { properties: [], unassigned: [] } };
}

function writeStore(store) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

// Initialize store file if absent
if (!fs.existsSync(DATA_FILE)) writeStore({ users: [], appData: { properties: [], unassigned: [] } });

// Thin API that mirrors the old sqlite interface used by index.js
const db = {
  getUser(username) {
    return readStore().users.find(u => u.username === username) || null;
  },
  hasUsers() {
    return readStore().users.length > 0;
  },
  createUser(username, password_hash) {
    const store = readStore();
    if (store.users.find(u => u.username === username)) throw new Error("UNIQUE constraint failed");
    const user = { id: store.users.length + 1, username, password_hash, created_at: new Date().toISOString() };
    store.users.push(user);
    writeStore(store);
    return user;
  },
  getAppData() {
    return readStore().appData;
  },
  setAppData(payload) {
    const store = readStore();
    store.appData = payload;
    writeStore(store);
  },
};

module.exports = db;
