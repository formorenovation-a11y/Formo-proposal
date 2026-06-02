require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── IN-MEMORY STORES (survive restarts via disk if available, fallback to RAM) ──
const DATA_DIR = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(path.join(DATA_DIR, 'proposals'));
fs.ensureDirSync(path.join(DATA_DIR, 'tracking'));
fs.ensureDirSync(path.join(DATA_DIR, 'uploads'));

// RAM cache — always available even if disk resets
const RAM = { proposals: {}, tracking: {} };

// Load from disk into RAM on startup
async function loadFromDisk() {
  try {
    const tDir = path.join(DATA_DIR, 'tracking');
    const files = await fs.readdir(tDir);
    for (const f of files.filter(f => f.endsWith('.json'))) {
      const data = await fs.readJson(path.join(tDir, f));
      RAM.tracking[data.proposalId] = data;
    }
    console.log(`Loaded ${files.length} proposals from disk`);
  } catch(e) { console.log('No disk data yet'); }
}
loadFromDisk();

// Serve uploads from data dir
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const proposalId = req.body.proposalId || 'temp';
    const dir = path.join(DATA_DIR, 'uploads', proposalId);
    fs.ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${uuidv4().slice(0,8)}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Upload images
app.post('/api/upload', upload.array('images', 20), (req, res) => {
  try {
    const files = req.files.map(f => ({
      filename: f.filename,
      url: `/uploads/${req.body.proposalId}/${f.filename}`,
      category: req.body.category || 'general'
    }));
    res.json({ success: true, files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Parse PDF estimate
app.post('/api/parse-estimate', upload.single('pdf'), async (req, res) => {
  try {
    const pdfBuffer = await fs.readFile(req.file.path);
    const base64Pdf = pdfBuffer.toString('base64');
    await fs.remove(req.file.path);

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf } },
          { type: 'text', text: `Read this internal renovation estimate and return ONLY valid JSON (no markdown, no backticks):
{
  "clientName": "string",
  "projectAddress": "string",
  "projectTitle": "string (short, e.g. Kitchen Cabinet & Countertop Renovation)",
  "duration": "string (e.g. 10 days)",
  "grandTotal": number,
  "scopeCategories": [
    { "title": "clean client-facing name", "description": "1-2 sentence professional description, no prices", "icon": "general" }
  ],
  "lineItems": [
    { "label": "grouped category name", "amount": number }
  ],
  "notes": "string"
}
Group line items into 3-5 categories max. Never expose markup, subcontractor costs, or per-unit prices.` }
        ]
      }]
    });

    const raw = message.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('PDF parse error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Generate proposal
app.post('/api/generate', async (req, res) => {
  const { proposalData, images } = req.body;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: buildPrompt(proposalData, images) }]
    });

    let html = message.content[0].text;
    // Strip any markdown code fences Claude might add
    html = html.replace(/^```html\s*/i, '').replace(/\s*```\s*$/, '').trim();

    const proposalId = proposalData.proposalId || uuidv4();
    const finalHtml = postProcessHtml(html, proposalId);

    // Save to disk
    const filepath = path.join(DATA_DIR, 'proposals', `proposal-${proposalId}.html`);
    await fs.writeFile(filepath, finalHtml);

    // Save tracking to disk + RAM
    const trackData = {
      proposalId,
      clientName: proposalData.clientName,
      projectAddress: proposalData.projectAddress || '',
      projectTitle: proposalData.projectTitle || '',
      totalAmount: proposalData.grandTotal || proposalData.totalAmount || 0,
      createdAt: new Date().toISOString(),
      views: [],
      totalTimeSeconds: 0,
      lastViewed: null
    };
    RAM.tracking[proposalId] = trackData;
    await fs.writeJson(path.join(DATA_DIR, 'tracking', `${proposalId}.json`), trackData);

    res.json({ success: true, proposalId, viewUrl: `/view/${proposalId}` });
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve proposal — apply fixes on every read (heals old broken proposals too)
app.get('/view/:id', async (req, res) => {
  const id = req.params.id;
  const paths = [
    path.join(DATA_DIR, 'proposals', `proposal-${id}.html`),
    path.join(__dirname, 'proposals', `proposal-${id}.html`)
  ];
  let html = null;
  for (const fp of paths) {
    if (fs.existsSync(fp)) { html = await fs.readFile(fp, 'utf8'); break; }
  }
  if (!html) return res.status(404).send('<h1 style="color:#F8F4EF;background:#191816;text-align:center;padding:80px;margin:0;font-family:sans-serif">Proposal not found</h1>');
  const fixed = postProcessHtml(html, id);
  res.setHeader('Content-Type', 'text/html');
  res.send(fixed);
});

// Tracking
app.post('/api/track', async (req, res) => {
  const { proposalId, event, duration, sessionId, userAgent, referrer } = req.body;
  let data = RAM.tracking[proposalId];
  if (!data) return res.json({ ok: true });

  if (event === 'open') {
    data.views.push({ openedAt: new Date().toISOString(), userAgent: userAgent||'', referrer: referrer||'', duration: 0, sessionId });
    data.lastViewed = new Date().toISOString();
  }
  if (event === 'close' || event === 'heartbeat') {
    const s = data.views.find(v => v.sessionId === sessionId);
    if (s) s.duration = duration || 0;
    data.totalTimeSeconds = data.views.reduce((sum, v) => sum + (v.duration||0), 0);
  }

  // Persist to disk async (don't await)
  fs.writeJson(path.join(DATA_DIR, 'tracking', `${proposalId}.json`), data).catch(() => {});
  res.json({ ok: true });
});

// Get all proposals
app.get('/api/proposals', (req, res) => {
  const list = Object.values(RAM.tracking).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

// Get single proposal tracking
app.get('/api/proposals/:id', (req, res) => {
  const data = RAM.tracking[req.params.id];
  if (data) res.json(data);
  else res.status(404).json({ error: 'Not found' });
});

// ── HTML POST-PROCESSING ──────────────────────────────────────────────────────

function postProcessHtml(html, proposalId) {
  // 1. Fix hero overlays — max 0.42 opacity so photos show through
  let out = html.replace(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*(0\.\d+)\s*\)/g, (m, a) =>
    parseFloat(a) > 0.5 ? 'rgba(0,0,0,0.42)' : m
  );

  // 2. Nuke opacity:0 from CSS (catches both ; and } endings)
  out = out.replace(/opacity\s*:\s*0\s*([;!}])/g, 'opacity:1 $1');
  // Also catch opacity:0 without semicolon at end of rule
  out = out.replace(/opacity:\s*0\b/g, 'opacity:1');

  // 3. Kill translateY that hides content below viewport
  out = out.replace(/transform\s*:\s*translateY\(\s*[1-9]\d*px\s*\)/g, 'transform:translateY(0)');
  out = out.replace(/transform\s*:\s*translate\(\s*0\s*,\s*[1-9]\d*px\s*\)/g, 'transform:translate(0,0)');

  // 4. Kill visibility:hidden
  out = out.replace(/visibility\s*:\s*hidden/g, 'visibility:visible');

  // 5. Inject a <style> block right after <head> for maximum priority override
  const headFix = `<style id="formo-force">
/* === FORMO VISIBILITY OVERRIDE === */
body { background: #191816 !important; color: #F8F4EF !important; }
section, .section, .slide, main > div, article {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
  display: block !important;
}
.fade, .fade-in, .reveal, .scroll-reveal,
[class*="animate"], [data-aos], [class*="hidden"] {
  opacity: 1 !important;
  transform: none !important;
  visibility: visible !important;
}
</style>`;
  out = out.replace('<head>', '<head>' + headFix);

  // 6. Inject force-visible JS + tracking at end of body
  const inject = `
<style id="formo-override">
/* Formo visibility override — prevents animation lockout */
body,body *{color:inherit;}
.fade:not(.visible),.scroll-reveal:not(.visible),[class*="animate-"]:not([class*="-done"]){
  opacity:1!important;transform:none!important;visibility:visible!important;
}
</style>
<script id="formo-track">
(function(){
  // Force visible — run immediately and after delays
  function fv(){
    var all=document.querySelectorAll('section,div,p,h1,h2,h3,ul,li,span,img,a');
    for(var i=0;i<all.length;i++){
      var cs=window.getComputedStyle(all[i]);
      if(cs.opacity==='0'){all[i].style.setProperty('opacity','1','important');}
      if(cs.visibility==='hidden'){all[i].style.setProperty('visibility','visible','important');}
    }
    // Also force all .fade classes visible
    document.querySelectorAll('.fade,.scroll-reveal,[data-aos]').forEach(function(el){
      el.style.opacity='1';el.style.transform='none';el.style.visibility='visible';
    });
  }
  fv();
  setTimeout(fv,50);setTimeout(fv,300);setTimeout(fv,1000);

  // Tracking
  var PID='${proposalId}',SID=Math.random().toString(36).slice(2);
  var BASE=window.location.origin,t0=Date.now(),on=true;
  function ping(ev){
    try{navigator.sendBeacon(BASE+'/api/track',new Blob([JSON.stringify({
      proposalId:PID,sessionId:SID,event:ev,
      duration:Math.round((Date.now()-t0)/1000),
      userAgent:navigator.userAgent,referrer:document.referrer
    })],{type:'application/json'}));}catch(e){}
  }
  ping('open');
  setInterval(function(){if(on)ping('heartbeat');},30000);
  window.addEventListener('beforeunload',function(){ping('close');});
  document.addEventListener('visibilitychange',function(){
    if(document.hidden){ping('close');on=false;}else{t0=Date.now();on=true;ping('open');}
  });
})();
<\/script>`;

  return out.replace('</body>', inject + '\n</body>');
}

// ── PROMPT ────────────────────────────────────────────────────────────────────

function buildPrompt(data, images) {
  const { clientName, projectAddress, scopeCategories, lineItems, grandTotal,
          companyTagline, notes, projectTitle, duration } = data;

  const beforeAfter = images?.filter(i => i.category === 'before_after') || [];
  const renders = images?.filter(i => i.category === 'render') || [];
  const heroImgs = images?.filter(i => i.category === 'project') || [];

  const imgBlock = images?.length ? `
IMAGES — embed these URLs as <img src="..."> directly:
Hero photos: ${JSON.stringify(heroImgs.map(i=>i.url))}
Before/After: ${JSON.stringify(beforeAfter.map(i=>i.url))}
3D Renders: ${JSON.stringify(renders.map(i=>i.url))}` : '';

  return `Create a complete, self-contained HTML renovation proposal. Return ONLY the HTML starting with <!DOCTYPE html>. No markdown fences.

===BRAND===
Company: Formo Renovation LLC
Background: #191816 | Gold: #C9A96E | Text: #F8F4EF | Muted: #cfc7b8
Fonts (Google Fonts): Cormorant Garamond (headings, 300/400/600/700) + Jost (body, 300/400/500)
Tagline: "${companyTagline || 'Built on quality, driven by integrity'}"

===PROJECT===
Client: ${clientName}
Title: ${projectTitle || 'Renovation Project'}
Address: ${projectAddress || ''}
Duration: ${duration || ''}
Notes: ${notes || ''}

===SCOPE (no prices — these are the service cards)===
${(scopeCategories||[]).map((s,i)=>`${i+1}. ${s.title} — ${s.description}`).join('\n')}

===INVESTMENT (client-visible totals only)===
${(lineItems||[]).map(l=>`${l.label}: $${Number(l.amount).toLocaleString()}`).join('\n')}
GRAND TOTAL: $${Number(grandTotal).toLocaleString()}

${imgBlock}

===SECTIONS===
1. HERO: Full-viewport. Large client name in Cormorant Garamond. Project title in gold italic. Address small. Tagline. ${heroImgs.length ? 'Use first hero photo as background-image with overlay rgba(0,0,0,0.40).' : 'Use gradient background.'} Scroll-down arrow.
2. THE WORK: Grid of cards, one per scope category. Each card: inline SVG icon, title, description. No prices. Dark cards with gold border on hover.
3. ${beforeAfter.length ? 'BEFORE & AFTER: Side-by-side image comparison.' : 'PROJECT VISION: Three feature callout boxes with gold numbers 01 02 03.'}
4. ${renders.length ? 'RENDERINGS: Full-width image gallery of renders.' : ''}
5. INVESTMENT: Elegant table. Each line item with label and amount. Separator line. TOTAL in Cormorant Garamond at 64px in gold. Duration badge.
6. WHY FORMO: Three columns — Licensed & Insured | On-Time Delivery | Premium Craftsmanship. Gold icons.
7. NEXT STEPS: Dark section. "Ready to begin?" heading. Dan Lares contact block: dan@formorenovation.com · 615-608-1220 · formorenovation.com

===CRITICAL CSS RULES===
- ALL text must use color: #F8F4EF or #cfc7b8 or #C9A96E — never black, never inherit from a white background
- body { background: #191816; color: #F8F4EF; }
- DO NOT use opacity:0 anywhere. DO NOT use visibility:hidden anywhere.
- NO scroll animations that start hidden. If you want fade-in, start at opacity:1 and use this ONLY:
  .fade { opacity:1; transition: opacity 0.6s; }
  Never set .fade to opacity:0 in the initial CSS.
- Each section: padding 80px 8%; border-bottom: 1px solid rgba(255,255,255,0.06);
- Mobile responsive with @media(max-width:768px)

Return ONLY valid HTML. Start with <!DOCTYPE html>.`;
}

app.listen(PORT, () => console.log(`Formo running on port ${PORT}`));
