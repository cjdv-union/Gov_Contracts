const axios = require("axios");
const fs = require("fs");
const path = require("path");

const HARMONIC_API_KEY = process.env.HARMONIC_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || "#deal-alerts";
const STATE_FILE = path.join(__dirname, "data/seen_companies.json");

const FILTERS = {
  stages: ["seed", "series_a", "series_b"],
  geography: "United States",
  excludeSectors: ["biotech", "life sciences", "pharmaceuticals", "healthcare"],
  minRoundSizeM: parseFloat(process.env.MIN_ROUND_SIZE_M) || null,
  maxRoundSizeM: parseFloat(process.env.MAX_ROUND_SIZE_M) || null,
  minEmployees: parseInt(process.env.MIN_EMPLOYEES) || null,
};

// ── Retry helper ──────────────────────────────────────────────────────────────

async function withRetry(fn, retries = 3, delayMs = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 429 || status === 500 || status === 502 || status === 503;
      if (isRetryable && attempt < retries) {
        const wait = delayMs * attempt;
        console.log(`⏳ Attempt ${attempt} failed (${status}). Retrying in ${wait / 1000}s...`);
        await new Promise((r) => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

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

  return withRetry(async () => {
    const response = await axios.get(
      "https://api.harmonic.ai/companies",
      {
        params: {
          last_funding_type: FILTERS.stages.join(","),
          country: "United States",
          size: 25,
          sort_by: "last_funding_date",
          order: "desc",
        },
        headers: {
          apikey: HARMONIC_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    console.log("📡 Harmonic response status:", response.status);

    const results =
      response.data?.results ||
      response.data?.companies ||
      response.data?.data ||
      (Array.isArray(response.data) ? response.data : []);

    return results;
  });
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function passesFilters(company) {
  const sector = (
    company.industry ||
    company.sector ||
    company.tags?.join(" ") ||
    ""
  ).toLowerCase();

  if (FILTERS.excludeSectors.some((e) => sector.includes(e))) return false;

  const fundingM =
    (company.last_funding_amount || company.funding_total || 0) / 1e6;
  if (FILTERS.minRoundSizeM && fundingM > 0 && fundingM < FILTERS.minRoundSizeM)
    return false;
  if (FILTERS.maxRoundSizeM && fundingM > FILTERS.maxRoundSizeM) return false;

  const employees =
    company.employee_count || company.headcount || company.team_size || 0;
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
        text: `Filters: *US only* · *Seed / Series A / Series B* · *Excl. Biotech/Life Sciences* · ${new Date().toLocaleDateString(
          "en-US",
          { month: "short", day: "numeric", year: "numeric" }
        )}`,
      },
    ],
  };

  const divider = { type: "divider" };

  const companyBlocks = companies.flatMap((c) => {
    const name = c.name || "Unknown";
    const stage = (c.last_funding_type || c.stage || "Unknown stage")
      .replace("_", " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());
    const amount = c.last_funding_amount
      ? `$${(c.last_funding_amount / 1e6).toFixed(1)}M`
      : c.funding_total
      ? `$${(c.funding_total / 1e6).toFixed(1)}M total raised`
      : null;
    const employees =
      c.employee_count || c.headcount || c.team_size || null;
    const description = c.description || c.short_description || "";
    const website = c.website?.url || c.website || "";
    const harmonicUrl = c.id
      ? `https://console.harmonic.ai/dashboard/company/${c.id}`
      : null;
    const location =
      c.location ||
      c.city ||
      (c.headquarters ? `${c.headquarters.city || ""} ${c.headquarters.state || ""}`.trim() : null);

    const meta = [
      stage,
      amount,
      employees ? `${employees} employees` : null,
      location ? `📍 ${location}` : null,
    ]
      .filter(Boolean)
      .join("  ·  ");

    const links = [
      website ? `<${website}|Website>` : null,
      harmonicUrl ? `<${harmonicUrl}|View on Harmonic>` : null,
    ]
      .filter(Boolean)
      .join("  ·  ");

    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${name}*\n${description ? `_${description}_\n` : ""}${meta}${
            links ? `\n${links}` : ""
          }`,
        },
      },
      divider,
    ];
  });

  return {
    channel: SLACK_CHANNEL,
    blocks: [header, context, divider, ...companyBlocks],
    text: `${companies.length} new funding round${
      companies.length !== 1 ? "s" : ""
    } found on Harmonic`,
  };
}

async function sendSlackMessage(payload) {
  console.log(`📨 Sending to ${SLACK_CHANNEL}...`);

  const response = await withRetry(() =>
    axios.post("https://slack.com/api/chat.postMessage", payload, {
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    })
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

  console.log("🚀 Starting deal tracker...");
  console.log(`📋 Filters: ${FILTERS.stages.join(", ")} · US only · Excl. biotech`);

  const seen = loadSeenCompanies();
  console.log(`👁  ${seen.size} companies already seen`);

  const rawResults = await searchHarmonic();
  console.log(`📊 Got ${rawResults.length} raw results from Harmonic`);

  if (rawResults.length === 0) {
    console.log("⚠️  Harmonic returned 0 results. Check your API key and plan access.");
    return;
  }

  const filtered = rawResults.filter(passesFilters);
  console.log(`🔎 ${filtered.length} pass filters`);

  const newCompanies = filtered.filter((c) => {
    const id = c.id || c.harmonic_id || c.urn || c.name;
    return id && !seen.has(String(id));
  });

  console.log(`🆕 ${newCompanies.length} are new (not seen before)`);

  if (newCompanies.length === 0) {
    console.log("✨ No new deals to report. All quiet.");
    return;
  }

  await sendSlackMessage(buildSlackMessage(newCompanies));

  newCompanies.forEach((c) => {
    const id = c.id || c.harmonic_id || c.urn || c.name;
    if (id) seen.add(String(id));
  });
  saveSeenCompanies(seen);

  console.log(`🎉 Done. Notified ${newCompanies.length} new deal(s).`);
}

run().catch((err) => {
  console.error("❌ Tracker failed:", err.message);
  if (err.response) {
    console.error("   Status:", err.response.status);
    console.error("   Body:", JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
