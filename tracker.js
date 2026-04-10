const axios = require("axios");
const fs = require("fs");
const path = require("path");

const HARMONIC_API_KEY = process.env.HARMONIC_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || "#deal-alerts";
const STATE_FILE = path.join(__dirname, "../data/seen_companies.json");

const FILTERS = {
  stages: ["Seed", "Series A", "Series B"],
  geography: "United States",
  excludeSectors: ["Biotech", "Life Sciences", "Pharmaceuticals", "Healthcare"],
  minRoundSizeM: parseFloat(process.env.MIN_ROUND_SIZE_M) || null,
  maxRoundSizeM: parseFloat(process.env.MAX_ROUND_SIZE_M) || null,
  minEmployees: parseInt(process.env.MIN_EMPLOYEES) || null,
};

// ── State management ──────────────────────────────────────────────────────────

function loadSeenCompanies() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
    }
  } catch {}
  return new Set();
}

function saveSeenCompanies(seen) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify([...seen]), "utf8");
}

// ── Harmonic ──────────────────────────────────────────────────────────────────

async function searchHarmonic() {
  console.log("🔍 Querying Harmonic for new funding rounds...");

  const filterParts = [
    `Geography: ${FILTERS.geography}`,
    `Funding stages: ${FILTERS.stages.join(", ")}`,
    `Exclude sectors: ${FILTERS.excludeSectors.join(", ")}`,
    FILTERS.minRoundSizeM ? `Min round size: $${FILTERS.minRoundSizeM}M` : null,
    FILTERS.maxRoundSizeM ? `Max round size: $${FILTERS.maxRoundSizeM}M` : null,
    FILTERS.minEmployees ? `Min employees: ${FILTERS.minEmployees}` : null,
  ]
    .filter(Boolean)
    .join(". ");

  const query = `Find companies that have recently announced or closed a ${FILTERS.stages.join(" or ")} funding round. ${filterParts}. Focus on companies that have announced within the last 30 days. Return companies likely to still have room in their round.`;

  const response = await axios.post(
    "https://api.harmonic.ai/search/companies",
    {
      query,
      size: 25,
      filters: {
        country: ["United States"],
        last_funding_type: FILTERS.stages.map((s) => s.toLowerCase().replace(" ", "_")),
      },
    },
    {
      headers: {
        apikey: HARMONIC_API_KEY,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data?.results || response.data?.companies || [];
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function passesFilters(company) {
  const sector = (company.industry || company.sector || "").toLowerCase();
  const excluded = FILTERS.excludeSectors.map((s) => s.toLowerCase());
  if (excluded.some((e) => sector.includes(e))) return false;

  const fundingM = (company.last_funding_amount || company.funding_total || 0) / 1e6;
  if (FILTERS.minRoundSizeM && fundingM < FILTERS.minRoundSizeM) return false;
  if (FILTERS.maxRoundSizeM && fundingM > FILTERS.maxRoundSizeM) return false;

  const employees = company.employee_count || company.headcount || 0;
  if (FILTERS.minEmployees && employees < FILTERS.minEmployees) return false;

  return true;
}

// ── Slack ─────────────────────────────────────────────────────────────────────

function buildSlackMessage(companies) {
  const header = {
    type: "header",
    text: {
      type: "plain_text",
      text: `🎯 ${companies.length} New Deal${companies.length !== 1 ? "s" : ""} — Harmonic Alert`,
    },
  };

  const context = {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Filters: *US only* · *${FILTERS.stages.join(" / ")}* · *Excl. Biotech/Life Sciences* · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
      },
    ],
  };

  const divider = { type: "divider" };

  const companyBlocks = companies.flatMap((c) => {
    const name = c.name || "Unknown";
    const stage = c.last_funding_type || c.stage || "Unknown stage";
    const amount = c.last_funding_amount
      ? `$${(c.last_funding_amount / 1e6).toFixed(1)}M`
      : c.funding_total
      ? `$${(c.funding_total / 1e6).toFixed(1)}M total raised`
      : null;
    const employees = c.employee_count || c.headcount;
    const description = c.description || c.short_description || "";
    const website = c.website?.url || c.website || "";
    const harmonicUrl = c.harmonic_url || (c.id ? `https://console.harmonic.ai/dashboard/company/${c.id}` : null);

    const meta = [
      stage,
      amount,
      employees ? `${employees} employees` : null,
      c.location || c.city ? `📍 ${c.location || c.city}` : null,
    ]
      .filter(Boolean)
      .join("  ·  ");

    const links = [
      website ? `<${website}|Website>` : null,
      harmonicUrl ? `<${harmonicUrl}|Harmonic>` : null,
    ]
      .filter(Boolean)
      .join("  ·  ");

    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${name}*\n${description ? `_${description}_\n` : ""}${meta}${links ? `\n${links}` : ""}`,
        },
      },
      divider,
    ];
  });

  return {
    channel: SLACK_CHANNEL,
    blocks: [header, context, divider, ...companyBlocks],
    text: `${companies.length} new funding round${companies.length !== 1 ? "s" : ""} found on Harmonic`,
  };
}

async function sendSlackMessage(payload) {
  console.log(`📨 Sending ${payload.blocks.length} blocks to ${SLACK_CHANNEL}...`);

  const response = await axios.post(
    "https://slack.com/api/chat.postMessage",
    payload,
    {
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.data.ok) {
    throw new Error(`Slack API error: ${response.data.error}`);
  }

  console.log(`✅ Slack message sent (ts: ${response.data.ts})`);
  return response.data;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  if (!HARMONIC_API_KEY) throw new Error("Missing HARMONIC_API_KEY env var");
  if (!SLACK_BOT_TOKEN) throw new Error("Missing SLACK_BOT_TOKEN env var");

  const seen = loadSeenCompanies();
  const rawResults = await searchHarmonic();

  console.log(`📊 Got ${rawResults.length} raw results from Harmonic`);

  const filtered = rawResults.filter(passesFilters);
  console.log(`🔎 ${filtered.length} pass filters`);

  const newCompanies = filtered.filter((c) => {
    const id = c.id || c.harmonic_id || c.name;
    return id && !seen.has(String(id));
  });

  console.log(`🆕 ${newCompanies.length} are new (not seen before)`);

  if (newCompanies.length === 0) {
    console.log("✨ No new deals to report. All quiet.");
    return;
  }

  await sendSlackMessage(buildSlackMessage(newCompanies));

  newCompanies.forEach((c) => {
    const id = c.id || c.harmonic_id || c.name;
    if (id) seen.add(String(id));
  });
  saveSeenCompanies(seen);

  console.log(`🎉 Done. Notified ${newCompanies.length} new deal(s).`);
}

run().catch((err) => {
  console.error("❌ Tracker failed:", err.message);
  process.exit(1);
});
