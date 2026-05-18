const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const db = require("./db");
const { signToken, requireAuth } = require("./auth");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── Utility: compute transaction history (mirrors frontend logic) ─────────────
function computeHistory(data) {
  const TODAY = new Date().toISOString().split("T")[0];

  const daysBetween = (d1, d2) => {
    if (!d1 || !d2) return 0;
    return Math.max(0, Math.floor((new Date(d2) - new Date(d1)) / 864e5));
  };

  const calcInterest = (principal, rate, start, end) =>
    (principal || 0) * ((rate || 0) / 100) * (daysBetween(start, end) / 365);

  const calcBalance = (loan, asOf = TODAY) => {
    if (!loan?.startDate || !loan?.principal) return loan?.principal ?? 0;
    const end = loan.endDate && loan.endDate <= asOf ? loan.endDate : asOf;
    if (loan.startDate > end) return loan.principal;
    return loan.principal + calcInterest(loan.principal, loan.interestRate, loan.startDate, end);
  };

  const rawEvents = [];
  (data.properties || []).forEach(prop => {
    (prop.loans || []).forEach(loan => {
      rawEvents.push({
        date: loan.startDate, sortSuffix: "b",
        lender: loan.lenderName, loanType: loan.loanType, etype: "start",
        amount: loan.principal || 0, principal: loan.principal || 0,
        property: prop.address, rate: loan.interestRate || 0, loanId: loan.id,
      });
      const end = loan.endDate || prop.dateSold;
      if (end) {
        const finBal = calcBalance(loan, end);
        const intEarned = finBal - (loan.principal || 0);
        rawEvents.push({
          date: end, sortSuffix: "a",
          lender: loan.lenderName, loanType: loan.loanType,
          etype: prop.dateSold && !loan.endDate ? "sold" : "closed",
          amount: finBal, principal: loan.principal || 0, interest: intEarned,
          property: prop.address, rate: loan.interestRate || 0, loanId: loan.id,
        });
      }
    });
  });

  rawEvents.sort((a, b) => ((a.date || "") + a.sortSuffix).localeCompare((b.date || "") + b.sortSuffix));

  const lenderPending = {};
  const lenderCumLent = {};
  const events = rawEvents.map(ev => {
    lenderPending[ev.lender] = lenderPending[ev.lender] ?? 0;
    lenderCumLent[ev.lender] = lenderCumLent[ev.lender] ?? 0;
    let netChange, prevPayoff;
    if (ev.etype === "start") {
      lenderCumLent[ev.lender] += ev.amount;
      prevPayoff = lenderPending[ev.lender];
      netChange = prevPayoff > 0 ? ev.amount - prevPayoff : ev.amount;
      lenderPending[ev.lender] = 0;
    } else {
      netChange = ev.interest ?? 0;
      lenderPending[ev.lender] += ev.amount;
    }
    return { ...ev, netChange, prevPayoff, cumLent: lenderCumLent[ev.lender] };
  });

  return events;
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

// GET /api/auth/status
app.get("/api/auth/status", (req, res) => {
  res.json({ hasUsers: db.hasUsers() });
});

// POST /api/auth/setup — create first admin user (only if no users exist)
app.post("/api/auth/setup", async (req, res) => {
  try {
    if (db.hasUsers()) {
      return res.status(400).json({ error: "Setup already complete — users exist" });
    }
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    const password_hash = await bcrypt.hash(password, 12);
    const user = db.createUser(username, password_hash);
    const token = signToken({ id: user.id, username });
    res.json({ token, username });
  } catch (err) {
    if (err.message && err.message.includes("UNIQUE")) {
      return res.status(400).json({ error: "Username already taken" });
    }
    console.error("Setup error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/auth/login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }
    const user = db.getUser(username);
    if (!user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const token = signToken({ id: user.id, username: user.username });
    res.json({ token, username: user.username });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Data Routes (require auth) ───────────────────────────────────────────────

// GET /api/data
app.get("/api/data", requireAuth, (req, res) => {
  try {
    res.json(db.getAppData());
  } catch (err) {
    console.error("Get data error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/data — full replace
app.post("/api/data", requireAuth, (req, res) => {
  try {
    const { properties = [], unassigned = [] } = req.body;
    db.setAppData({ properties, unassigned });
    res.json({ ok: true });
  } catch (err) {
    console.error("Save data error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Export Routes (require auth via query param token) ───────────────────────

// GET /api/export/csv
app.get("/api/export/csv", requireAuth, (req, res) => {
  try {
    const data = db.getAppData();
    const events = computeHistory(data);

    const today = new Date().toISOString().split("T")[0];
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="nexus-history-${today}.csv"`);

    const headers = [
      "Date",
      "Event Type",
      "Lender",
      "Loan Type",
      "Amount",
      "Property",
      "Rate (%)",
      "Interest Earned",
      "Net Change",
      "Cumulative Lent with Nexus",
    ];

    const escapeCSV = (val) => {
      if (val === null || val === undefined) return "";
      const str = String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const lines = [headers.join(",")];
    events.forEach(ev => {
      const row = [
        ev.date || "",
        ev.etype === "start" ? "Loan Started" : ev.etype === "closed" ? "Loan Closed" : "Property Sold",
        ev.lender || "",
        ev.loanType === "hard" ? "Hard Money" : "Private Money",
        Math.round(ev.amount || 0),
        ev.property || "",
        ev.rate || 0,
        Math.round(ev.interest || 0),
        Math.round(ev.netChange || 0),
        Math.round(ev.cumLent || 0),
      ].map(escapeCSV);
      lines.push(row.join(","));
    });

    res.send(lines.join("\n"));
  } catch (err) {
    console.error("CSV export error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/export/json
app.get("/api/export/json", requireAuth, (req, res) => {
  try {
    const data = db.getAppData();
    const today = new Date().toISOString().split("T")[0];

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="nexus-data-${today}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("JSON export error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Nexus Homes server running on http://localhost:${PORT}`);
});
