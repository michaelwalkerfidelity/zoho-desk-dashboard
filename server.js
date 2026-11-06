require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

function getJulianDay(date = new Date()) {
  const startOfYear = new Date(Date.UTC(date.getFullYear(), 0, 0));
  const diffMs = date.getTime() - startOfYear.getTime();
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor(diffMs / msPerDay) + 1;
}

function getUnlockCode(date = new Date()) {
  const day = String(getJulianDay(date)).padStart(3, '0');
  return `8426${day}`;
}

let cachedAccessToken = null;
let tokenExpiresAt = 0;
let refreshPromise = null;

// Cache view names by ID in memory
const viewNameCache = new Map();

// Automatic token refresher using refresh_token
async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const response = await axios.post(`${process.env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
        params: {
          refresh_token: process.env.ZOHO_REFRESH_TOKEN.trim(),
          client_id: process.env.ZOHO_CLIENT_ID.trim(),
          client_secret: process.env.ZOHO_CLIENT_SECRET.trim(),
          grant_type: 'refresh_token'
        }
      });

      if (!response.data.access_token) {
        throw new Error(JSON.stringify(response.data));
      }

      cachedAccessToken = response.data.access_token;
      tokenExpiresAt = now + (response.data.expires_in * 1000);
      console.log('Successfully refreshed Zoho access token');
      return cachedAccessToken;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/unlock-code', (req, res) => {
  if (!req.get('x-ms-client-principal')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const code = getUnlockCode();
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  res.json({ code });
});

// Fetch view name metadata with dual lookup (direct + dynamic department sweep)
app.get('/api/views/:viewId', async (req, res) => {
  let { viewId } = req.params;

  if (viewId === 'default' || !viewId) {
    viewId = process.env.DEFAULT_VIEW_ID;
  }

  if (!viewId) {
    return res.status(400).json({ error: 'No viewId provided or configured' });
  }

  const cleanViewId = String(viewId).trim();

  if (viewNameCache.has(cleanViewId)) {
    return res.json({ id: cleanViewId, name: viewNameCache.get(cleanViewId) });
  }

  try {
    const token = await getAccessToken();

    // 1. Direct fetch using module=tickets
    try {
      const directRes = await axios.get(`${process.env.ZOHO_DESK_API_URL}/views/${cleanViewId}`, {
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`,
          'orgId': process.env.ZOHO_ORG_ID.trim()
        },
        params: { module: 'tickets' }
      });

      const name = directRes.data?.name || directRes.data?.viewName;
      if (name) {
        viewNameCache.set(cleanViewId, name);
        return res.json({ id: cleanViewId, name });
      }
    } catch (directErr) {
      // Direct lookup fallback
    }

    // 2. Department sweep fallback
    const deptListRes = await axios.get(`${process.env.ZOHO_DESK_API_URL}/departments`, {
      headers: {
        'Authorization': `Zoho-oauthtoken ${token}`,
        'orgId': process.env.ZOHO_ORG_ID.trim()
      },
      params: { limit: 50 }
    });

    const allDepts = (deptListRes.data?.data || []).map(d => d.id);
    allDepts.unshift(undefined);

    for (const deptId of allDepts) {
      try {
        const params = { module: 'tickets', limit: 100 };
        if (deptId) params.departmentId = deptId;

        const vRes = await axios.get(`${process.env.ZOHO_DESK_API_URL}/views`, {
          headers: {
            'Authorization': `Zoho-oauthtoken ${token}`,
            'orgId': process.env.ZOHO_ORG_ID.trim()
          },
          params
        });

        for (const v of vRes.data?.data || []) {
          if (v.id && v.name) {
            viewNameCache.set(String(v.id), v.name);
          }
        }

        if (viewNameCache.has(cleanViewId)) {
          return res.json({ id: cleanViewId, name: viewNameCache.get(cleanViewId) });
        }
      } catch (deptErr) {}
    }

    res.json({ id: cleanViewId, name: 'Support Queue' });
  } catch (error) {
    console.error('View Name API Error:', error.response?.data || error.message);
    res.json({ id: cleanViewId, name: 'Support Queue' });
  }
});

// Tickets queue endpoint: includes 'contacts,assignee' (strictly valid Zoho values)
app.get('/api/tickets', async (req, res) => {
  try {
    const viewId = req.query.viewId || process.env.DEFAULT_VIEW_ID;
    const token = await getAccessToken();

    const response = await axios.get(`${process.env.ZOHO_DESK_API_URL}/tickets`, {
      headers: {
        'Authorization': `Zoho-oauthtoken ${token}`,
        'orgId': process.env.ZOHO_ORG_ID.trim()
      },
      params: {
        viewId: viewId.trim(),
        limit: 50,
        sortBy: '-createdTime',
        include: 'contacts,assignee' // Only valid include keys
      }
    });

    res.json(response.data.data || []);
  } catch (error) {
    console.error('Tickets API Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

app.listen(PORT, () => {
  console.log(`Zoho Desk Dashboard running at http://localhost:${PORT}`);
});
