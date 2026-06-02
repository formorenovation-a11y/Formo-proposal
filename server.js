require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── STORAGE ──────────────────────────────────────────────────────────────────
// Use RENDER_DISK_PATH if available (persistent disk), else fallback to local
const DATA_DIR = process.env.RENDER_DISK_PATH
  ? path.join(process.env.RENDER_DISK_PATH)
  : path.join(__dirname, 'data');

fs.ensureDirSync(path.join(DATA_DIR, 'proposals'));
fs.ensureDirSync(path.join(DATA_DIR, 'tracking'));
fs.ensureDirSync(path.join(DATA_DIR, 'uploads'));

// RAM cache — always current, survives even if disk is slow
const RAM = { tracking: {} };

// Warm RAM from disk on startup
(async () => {
  try {
    const files = await fs.readdir(path.join(DATA_DIR, 'tracking'));
    for (const f of files.filter(f => f.endsWith('.json'))) {
      const d = await fs.readJson(path.join(DATA_DIR, 'tracking', f));
      RAM.tracking[d.proposalId] = d;
    }
    console.log(`Loaded ${files.length} proposals into RAM`);
  } catch (e) { /* fresh start */ }
})();

app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

// ── MULTER ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(DATA_DIR, 'uploads', req.body.proposalId || 'tmp');
    fs.ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${uuidv4().slice(0,8)}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Upload images
app.post('/api/upload', upload.array('images', 20), (req, res) => {
  try {
    const files = req.files.map(f => ({
      filename: f.filename,
      url: `/uploads/${req.body.proposalId}/${f.filename}`,
      category: req.body.category || 'general'
    }));
    res.json({ success: true, files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Parse PDF → JSON data only
app.post('/api/parse-estimate', upload.single('pdf'), async (req, res) => {
  try {
    const buf = await fs.readFile(req.file.path);
    await fs.remove(req.file.path);

    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
          { type: 'text', text: `Read this internal renovation estimate. Return ONLY a JSON object (no markdown, no backticks, no explanation):
{
  "clientName": "string",
  "projectAddress": "string",
  "projectTitle": "string",
  "duration": "string (e.g. 10 days)",
  "grandTotal": number,
  "scopeCategories": [
    { "title": "Client-facing category name", "description": "1-2 sentences, no prices" }
  ],
  "lineItems": [
    { "label": "Grouped budget category", "amount": number }
  ],
  "notes": "string"
}
Rules: group scope into 3-6 categories. Group line items into 3-5 budget lines. NEVER show markup, unit costs, or subcontractor fees.` }
        ]
      }]
    });

    const raw = msg.content[0].text.replace(/```json|```/g,'').trim();
    res.json({ success: true, data: JSON.parse(raw) });
  } catch (e) {
    console.error('PDF parse error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Generate proposal using fixed template
app.post('/api/generate', async (req, res) => {
  const { proposalData, images } = req.body;
  try {
    const proposalId = proposalData.proposalId || uuidv4();
    const html = buildProposalHtml(proposalData, images || [], proposalId);

    await fs.writeFile(path.join(DATA_DIR, 'proposals', `proposal-${proposalId}.html`), html);

    const track = {
      proposalId,
      clientName:     proposalData.clientName     || '',
      projectAddress: proposalData.projectAddress  || '',
      projectTitle:   proposalData.projectTitle    || '',
      totalAmount:    proposalData.grandTotal      || 0,
      createdAt:      new Date().toISOString(),
      views: [],
      totalTimeSeconds: 0,
      lastViewed: null
    };
    RAM.tracking[proposalId] = track;
    fs.writeJson(path.join(DATA_DIR, 'tracking', `${proposalId}.json`), track).catch(() => {});

    res.json({ success: true, proposalId, viewUrl: `/view/${proposalId}` });
  } catch (e) {
    console.error('Generate error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Serve proposal (static file — no post-processing needed, template is clean)
app.get('/view/:id', async (req, res) => {
  const fp = path.join(DATA_DIR, 'proposals', `proposal-${req.params.id}.html`);
  if (fs.existsSync(fp)) {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile(fp);
  } else {
    res.status(404).send(`<body style="background:#191816;color:#F8F4EF;font-family:sans-serif;text-align:center;padding:80px">
      <h2>Proposal not found</h2><p style="color:#9a9080;margin-top:12px">This link may have expired.</p></body>`);
  }
});

// Tracking
app.post('/api/track', async (req, res) => {
  const { proposalId, event, duration, sessionId, userAgent } = req.body;
  const d = RAM.tracking[proposalId];
  if (!d) return res.json({ ok: true });

  if (event === 'open') {
    d.views.push({ openedAt: new Date().toISOString(), userAgent: userAgent||'', duration: 0, sessionId });
    d.lastViewed = new Date().toISOString();
  }
  if (event === 'close' || event === 'heartbeat') {
    const s = d.views.find(v => v.sessionId === sessionId);
    if (s) s.duration = duration || 0;
    d.totalTimeSeconds = d.views.reduce((sum, v) => sum + (v.duration||0), 0);
  }
  fs.writeJson(path.join(DATA_DIR, 'tracking', `${proposalId}.json`), d).catch(() => {});
  res.json({ ok: true });
});

app.get('/api/proposals', (req, res) => {
  const list = Object.values(RAM.tracking).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

app.get('/api/proposals/:id', (req, res) => {
  const d = RAM.tracking[req.params.id];
  d ? res.json(d) : res.status(404).json({ error: 'Not found' });
});

// ── TEMPLATE ENGINE ───────────────────────────────────────────────────────────

function buildProposalHtml(data, images, proposalId) {
  const {
    clientName = '', projectTitle = '', projectAddress = '',
    duration = '', scopeCategories = [], lineItems = [], grandTotal = 0
  } = data;

  const heroImgs    = images.filter(i => i.category === 'project');
  const renderImgs  = images.filter(i => i.category === 'render');
  const baImgs      = images.filter(i => i.category === 'before_after');

  // ── Hero background
  const heroBg = heroImgs.length ? heroImgs[0].url : '';

  // ── Scope cards
  const scopeIcons = {
    countertop: `<svg class="scope-card-icon" viewBox="0 0 36 36" fill="none"><rect x="3" y="14" width="30" height="5" rx="1" stroke="#C9A96E" stroke-width="1.5"/><rect x="6" y="19" width="24" height="10" rx="1" stroke="#C9A96E" stroke-width="1.4"/><path d="M10 14V9h16v5" stroke="#C9A96E" stroke-width="1.4"/></svg>`,
    cabinet:     `<svg class="scope-card-icon" viewBox="0 0 36 36" fill="none"><rect x="3" y="4" width="30" height="28" rx="1.5" stroke="#C9A96E" stroke-width="1.5"/><path d="M3 18h30M18 4v28" stroke="#C9A96E" stroke-width="1.4"/><circle cx="14" cy="18" r="1.5" fill="#C9A96E"/><circle cx="22" cy="18" r="1.5" fill="#C9A96E"/></svg>`,
    paint:       `<svg class="scope-card-icon" viewBox="0 0 36 36" fill="none"><path d="M8 28l14-14M10 26L8 28l2-2z" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/><rect x="18" y="6" width="12" height="8" rx="1.5" stroke="#C9A96E" stroke-width="1.4"/><path d="M24 14v4" stroke="#C9A96E" stroke-width="1.4"/></svg>`,
    plumbing:    `<svg class="scope-card-icon" viewBox="0 0 36 36" fill="none"><path d="M10 8v12a6 6 0 006 6h4a6 6 0 006-6V8" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/><path d="M7 8h22" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    trim:        `<svg class="scope-card-icon" viewBox="0 0 36 36" fill="none"><rect x="4" y="4" width="28" height="28" rx="1.5" stroke="#C9A96E" stroke-width="1.5"/><rect x="9" y="9" width="18" height="18" rx="1" stroke="#C9A96E" stroke-width="1.2"/></svg>`,
    demo:        `<svg class="scope-card-icon" viewBox="0 0 36 36" fill="none"><path d="M10 26L26 10M10 10l16 16" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    cleanup:     `<svg class="scope-card-icon" viewBox="0 0 36 36" fill="none"><path d="M12 16l-4 12h20l-4-12" stroke="#C9A96E" stroke-width="1.5" stroke-linejoin="round"/><path d="M18 8v8M10 12l8-4 8 4" stroke="#C9A96E" stroke-width="1.4" stroke-linecap="round"/></svg>`,
    general:     `<svg class="scope-card-icon" viewBox="0 0 36 36" fill="none"><circle cx="18" cy="18" r="14" stroke="#C9A96E" stroke-width="1.5"/><path d="M18 12v6l4 2" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/></svg>`
  };

  const scopeCards = scopeCategories.map(s => {
    const icon = scopeIcons[s.icon] || scopeIcons.general;
    return `<div class="scope-card">${icon}<div class="scope-card-title">${esc(s.title)}</div><div class="scope-card-desc">${esc(s.description)}</div></div>`;
  }).join('\n');

  // ── Render images
  const renderHtml  = renderImgs.map(i => `<img src="${i.url}" alt="Render" loading="lazy">`).join('\n');
  const rendersHidden = renderImgs.length === 0 ? 'hidden' : '';
  const rendersDivider = renderImgs.length ? '<div class="divider">◆ &nbsp; ◆ &nbsp; ◆</div>' : '';

  // ── Before/After
  const baHtml = baImgs.map((img, idx) => `
    <div class="ba-item">
      <img src="${img.url}" alt="${idx % 2 === 0 ? 'Before' : 'After'}" loading="lazy">
      <div class="ba-label">${idx % 2 === 0 ? 'Before' : 'After'}</div>
    </div>`).join('\n');
  const baHidden   = baImgs.length === 0 ? 'hidden' : '';
  const baDivider  = baImgs.length ? '<div class="divider">◆ &nbsp; ◆ &nbsp; ◆</div>' : '';

  // ── Line items
  const invRows = lineItems.map(l =>
    `<div class="inv-row"><span class="inv-row-label">${esc(l.label)}</span><span class="inv-row-amount">$${Number(l.amount).toLocaleString('en-US', {minimumFractionDigits:2})}</span></div>`
  ).join('\n');

  // ── Tracking script
  const trackScript = `<script>
(function(){
  var PID='${proposalId}',SID=Math.random().toString(36).slice(2);
  var BASE=window.location.origin,t0=Date.now(),on=true;
  function ping(ev){try{navigator.sendBeacon(BASE+'/api/track',new Blob([JSON.stringify({proposalId:PID,sessionId:SID,event:ev,duration:Math.round((Date.now()-t0)/1000),userAgent:navigator.userAgent})],{type:'application/json'}));}catch(e){}}
  ping('open');
  setInterval(function(){if(on)ping('heartbeat');},30000);
  window.addEventListener('beforeunload',function(){ping('close');});
  document.addEventListener('visibilitychange',function(){if(document.hidden){ping('close');on=false;}else{t0=Date.now();on=true;ping('open');}});
})();
</script>`;

  // ── Fill template
  const template = fs.readFileSync(path.join(__dirname, 'public', 'template.html'), 'utf8');

  return template
    .replace('{{CLIENT_NAME}}',     esc(clientName))
    .replace('{{CLIENT_NAME}}',     esc(clientName))  // title tag too
    .replace('{{PROJECT_TITLE}}',   esc(projectTitle))
    .replace('{{PROJECT_ADDRESS}}', esc(projectAddress))
    .replace(/\{\{HERO_IMAGE\}\}/g, heroBg)
    .replace('{{SCOPE_CARDS}}',     scopeCards)
    .replace('{{RENDER_IMAGES}}',   renderHtml)
    .replace('{{RENDERS_HIDDEN}}',  rendersHidden)
    .replace('{{RENDERS_DIVIDER}}', rendersDivider)
    .replace('{{BA_IMAGES}}',       baHtml)
    .replace('{{BA_HIDDEN}}',       baHidden)
    .replace('{{BA_DIVIDER}}',      baDivider)
    .replace('{{INV_ROWS}}',        invRows)
    .replace('{{DURATION}}',        esc(duration || ''))
    .replace('{{GRAND_TOTAL}}',     '$' + Number(grandTotal).toLocaleString('en-US', {minimumFractionDigits:2}))
    .replace('{{TRACKING_SCRIPT}}', trackScript);
}

function esc(s) {
  return String(s||'').replace(/[&<>"']/g,
    m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

app.listen(PORT, () => console.log(`Formo running on port ${PORT}`));
