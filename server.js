const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

const OPENSKY_USER = process.env.OPENSKY_USER;
const OPENSKY_PASS = process.env.OPENSKY_PASS;
const OPENSKY_BASE = "https://opensky-network.org/api";

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Flight proxy running" });
});

// Single flight: GET /flight?callsign=AAL100
app.get("/flight", async (req, res) => {
  const { callsign } = req.query;
  if (!callsign) return res.status(400).json({ error: "Missing ?callsign= parameter" });

  try {
    const results = await fetchBatch([callsign]);
    res.json(results[0]);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Batch flights: POST /flights  { callsigns: ["AAL100", ...] }
app.post("/flights", async (req, res) => {
  const { callsigns } = req.body;
  if (!Array.isArray(callsigns) || callsigns.length === 0) {
    return res.status(400).json({ error: 'Body must be { callsigns: ["AAL100", ...] }' });
  }
  if (callsigns.length > 50) {
    return res.status(400).json({ error: "Max 50 callsigns per batch" });
  }

  try {
    const flights = await fetchBatch(callsigns);
    res.json({ flights });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

async function fetchBatch(callsigns) {
  const icaoCallsigns = callsigns.map(toIcao);
  const params = icaoCallsigns
    .map((c) => `callsign=${encodeURIComponent(c.padEnd(8))}`)
    .join("&");

  const credentials = Buffer.from(`${OPENSKY_USER}:${OPENSKY_PASS}`).toString("base64");

  const response = await fetch(`${OPENSKY_BASE}/states/all?${params}`, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  if (!response.ok) throw new Error(`OpenSky error: ${response.status}`);

  const raw = await response.json();

  const stateMap = new Map();
  if (raw.states) {
    for (const state of raw.states) {
      stateMap.set((state[1] || "").trim(), state);
    }
  }

  return callsigns.map((original, i) => {
    const icao = icaoCallsigns[i].padEnd(8);
    const state = stateMap.get(icao) || stateMap.get(icao.trim());
    return normalise(original, state);
  });
}

function normalise(callsign, state) {
  if (!state) {
    return { callsign, found: false, status: "unknown" };
  }
  const onGround = state[8];
  const velocity = state[9];
  const altitude = state[7];
  let status = "On Time";
  if (onGround && (!velocity || velocity < 5)) status = "Landed";
  else if (onGround && velocity > 5) status = "Boarding";
  else if (!onGround && altitude && altitude > 100) status = "In Transit";

  return {
    callsign,
    found: true,
    status,
    position: {
      latitude: state[6],
      longitude: state[5],
      altitude_ft: altitude ? Math.round(altitude * 3.281) : null,
      on_ground: onGround,
    },
    velocity: {
      speed_knots: velocity ? Math.round(velocity * 1.944) : null,
      heading: state[10] ? Math.round(state[10]) : null,
    },
    last_contact: state[4] ? new Date(state[4] * 1000).toISOString() : null,
  };
}

const ICAO_MAP = {
  AA: "AAL", DL: "DAL", UA: "UAL", WN: "SWA", B6: "JBU",
  AS: "ASA", NK: "NKS", F9: "FFT", HA: "HAL", BA: "BAW",
  LH: "DLH", AF: "AFR", KL: "KLM", IB: "IBE", EK: "UAE",
  QR: "QTR", SQ: "SIA", CX: "CPA", JL: "JAL", NH: "ANA",
  TK: "THY", MH: "MAS", ET: "ETH", KE: "KAL", AI: "AIC",
  TG: "THA", CA: "CCA", EY: "ETD", AK: "AXM", BR: "EVA",
  LA: "LAN", KQ: "KQA", VS: "VIR", RO: "ROT",
};

function toIcao(iata) {
  const code = iata.slice(0, 2).toUpperCase();
  return (ICAO_MAP[code] || code) + iata.slice(2);
}

app.listen(PORT, () => {
  console.log(`Flight proxy running on port ${PORT}`);
});
