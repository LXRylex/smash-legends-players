import express from "express";
import rateLimit from "express-rate-limit";

const app = express();

// Render proxy support
app.set("trust proxy", 1);

app.use(express.json());

// Open CORS for testing
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const UPSTREAM =
  "https://ewy35wnciyp7vdwrsknczl5p7a0njcji.lambda-url.us-east-1.on.aws/api/v1/profile/user";

// ===== ENV =====
function getEnvToken() {
  return (
    process.env.SL_JWT ||
    process.env.JWT_TOKEN ||
    process.env.BEARER_TOKEN ||
    process.env.TOKEN ||
    ""
  ).trim();
}

function getGitHubConfig() {
  return {
    token: String(process.env.GITHUB_TOKEN || "").trim(),
    owner: String(process.env.GITHUB_OWNER || "").trim(),
    repo: String(process.env.GITHUB_REPO || "").trim(),
    branch: String(process.env.GITHUB_BRANCH || "main").trim(),
  };
}

// ===== Rate limit =====
const profileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests, please try again later.",
  },
});

// ===== Normalize =====
function normalizeProfilePayload(raw, userUid, meta = {}) {
  const user = raw?.user || {};
  const rankDetails = Array.isArray(raw?.rankDetails) ? raw.rankDetails : [];
  const statsAll = raw?.statsAll ?? null;

  return {
    schema_version: 1,
    saved_at: new Date().toISOString(),
    source: {
      upstream: UPSTREAM,
      cache: meta.xcache || "",
      cache_date: meta.xdate || "",
    },
    player: {
      user_uid: String(user?.user_uid || userUid || ""),
      name: user?.name ?? null,
      level: user?.level ?? null,
      trophy: user?.trophy ?? null,
      highestTrophy: user?.highestTrophy ?? null,
      fame: user?.fame ?? null,
      iconId: user?.iconId ?? null,
      frameId: user?.frameId ?? null,
      clan_name: user?.clan_name ?? null,
      updatedAt: user?.updatedAt ?? null,
    },
    rankDetails,
    statsAll,
  };
}

// ===== GitHub helpers =====
async function getGitHubFileSha({ owner, repo, branch, path, token }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "render-sl-backup-service",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (r.status === 404) return null;

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GitHub read failed: ${r.status} ${text}`);
  }

  const data = await r.json();
  return data?.sha || null;
}

async function putGitHubFile({ owner, repo, branch, path, contentString, message, token }) {
  const existingSha = await getGitHubFileSha({ owner, repo, branch, path, token });

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  const body = {
    message,
    content: Buffer.from(contentString, "utf8").toString("base64"),
    branch,
    ...(existingSha ? { sha: existingSha } : {}),
  };

  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "render-sl-backup-service",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GitHub write failed: ${r.status} ${text}`);
  }

  return await r.json();
}

async function backupProfileToGitHub(normalized) {
  const { token, owner, repo, branch } = getGitHubConfig();

  if (!token || !owner || !repo) {
    return { skipped: true, reason: "Missing GitHub env config" };
  }

  const uid = String(normalized?.player?.user_uid || "unknown").trim();
  const path = `players/${uid}.json`;
  const contentString = JSON.stringify(normalized, null, 2);

  const result = await putGitHubFile({
    owner,
    repo,
    branch,
    path,
    contentString,
    message: `backup/update player ${uid} @ ${new Date().toISOString()}`,
    token,
  });

  return {
    skipped: false,
    uid,
    path,
    result,
  };
}

// ===== Routes =====

// Health
app.get("/", (req, res) => {
  res.send("Backup proxy OK");
});

// Main route
app.get("/profile", profileLimiter, async (req, res) => {
  try {
    const uid = String(req.query.user_uid || "").trim();
    const force = String(req.query.force || "").trim() === "1";

    if (!uid) {
      return res.status(400).json({ error: "Missing user_uid" });
    }

    let token = getEnvToken();

    // local fallback only if env token missing
    if (!token) {
      const auth = String(req.headers.authorization || "").trim();
      if (auth.toLowerCase().startsWith("bearer ")) {
        token = auth.replace(/^bearer\s+/i, "").trim();
      }
    }

    if (!token) {
      return res.status(401).json({
        error: "Missing JWT token (set SL_JWT / JWT_TOKEN / BEARER_TOKEN / TOKEN in Render env)",
      });
    }

    const url = `${UPSTREAM}?user_uid=${encodeURIComponent(uid)}${force ? "&force=1" : ""}`;

    const upstreamRes = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "X-APP-STORE": "steam",
      },
    });

    const xcache = upstreamRes.headers.get("X-Cache") || "";
    const xdate = upstreamRes.headers.get("X-Cache-Date") || "";

    if (xcache) res.setHeader("X-Cache", xcache);
    if (xdate) res.setHeader("X-Cache-Date", xdate);

    const text = await upstreamRes.text();

    // Always return upstream result to client
    res.status(upstreamRes.status).send(text);

    // Only backup successful JSON responses
    if (!upstreamRes.ok) return;

    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      console.warn("Backup skipped: upstream response was not valid JSON");
      return;
    }

    const normalized = normalizeProfilePayload(raw, uid, { xcache, xdate });

    try {
      const info = await backupProfileToGitHub(normalized);
      if (info.skipped) {
        console.warn("GitHub backup skipped:", info.reason);
      } else {
        console.log(`GitHub backup saved for ${info.uid} -> ${info.path}`);
      }
    } catch (backupErr) {
      console.error("GitHub backup failed:", backupErr);
    }
  } catch (e) {
    res.status(500).json({
      error: String(e?.message || e),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backup proxy running on", PORT);
});
