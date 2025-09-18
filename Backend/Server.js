// --- Load environment first ---
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const app = express();

// --- Middleware ---
app.use(cors());
app.use(helmet());
app.use(express.json());

// --- Rate limiter ---
const withdrawLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 5,
  message: { error: "Too many withdrawal attempts, try later." }
});

// --- Persistence ---
const DATA_FILE = path.join(__dirname, "data.json");

let store = {
  users: {},
  usdToNGN: config.usdToNGN,
  davCoinValueUSD: config.davCoinValueUSD
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      store = { ...store, ...parsed };
      console.log("✅ Data loaded");
    }
  } catch (err) {
    console.error("⚠️ Load error:", err.message);
  }
}

function persistData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error("⚠️ Save error:", err.message);
  }
}

function ensureUser(username) {
  if (!store.users[username]) {
    store.users[username] = { balanceDC: 0 };
    persistData();
  }
  return store.users[username];
}

loadData();

// --- Routes ---
app.get("/", (_, res) => res.send("🚀 Mine App Backend is live ✅"));

app.get("/user/:username", (req, res) => {
  const u = ensureUser(req.params.username);
  res.json({
    username: req.params.username,
    balanceDC: u.balanceDC,
    usdToNGN: store.usdToNGN,
    davCoinValueUSD: store.davCoinValueUSD
  });
});

app.post("/mine", (req, res) => {
  const { username, amount } = req.body;
  if (!username || typeof amount !== "number") {
    return res.status(400).json({ error: "Invalid payload" });
  }
  const user = ensureUser(username);
  user.balanceDC += amount;
  persistData();
  res.json({ message: "DavCoins mined", balanceDC: user.balanceDC });
});

app.post("/withdraw", withdrawLimiter, async (req, res) => {
  const { username, amountNGN, recipientAccount } = req.body;
  if (!username || !recipientAccount || typeof amountNGN !== "number") {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const user = store.users[username];
  if (!user) return res.status(404).json({ error: "User not found" });

  const availableNGN = Math.round(
    user.balanceDC * store.davCoinValueUSD * store.usdToNGN
  );
  if (availableNGN < amountNGN) {
    return res.status(400).json({ error: "Insufficient funds" });
  }

  const dcToDeduct = amountNGN / (store.davCoinValueUSD * store.usdToNGN);
  user.balanceDC = Math.max(0, user.balanceDC - dcToDeduct);

  try {
    const response = await axios.post(
      "https://sandbox.moniepoint.com/api/v1/transfer",
      { amount: amountNGN, recipient: recipientAccount },
      {
        headers: {
          Authorization: `Bearer ${config.moniepointAPIKey}`,
          "Secret-Key": config.moniepointSecret,
          "Content-Type": "application/json"
        }
      }
    );
    persistData();
    res.json({ message: "Withdrawal successful", transaction: response.data });
  } catch (err) {
    user.balanceDC += dcToDeduct; // rollback
    persistData();
    res.status(500).json({
      error: "Moniepoint transfer failed",
      details: err.response?.data || err.message
    });
  }
});

// --- Serve frontend ---
app.use(express.static(path.join(__dirname, "../frontend")));

// --- Start server (force port 5000) ---
const PORT = 5000;
app.listen(PORT, () =>
  console.log(`✅ Server is live at http://localhost:${PORT}`)
);
