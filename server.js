require('dotenv').config();
const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');
fs.ensureDirSync(path.join(DATA_DIR, 'proposals'));
fs.ensureDirSync(path.join(DATA_DIR, 'tracking'));
fs.ensureDirSync(path.join(DATA_DIR, 'uploads'));
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

const RAM = { tracking: {} };
(async () => {
  try {
    const files = await fs.readdir(path.join(DATA_DIR, 'tracking'));
    for (const f of files.filter(f => f.endsWith('.json'))) {
      const d = await fs.readJson(path.join(DATA_DIR, 'tracking', f));
      RAM.tracking[d.proposalId] = d;
    }
    console.log('Loaded', Object.keys(RAM.tracking).length, 'proposals');
  } catch(e) {}
})();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(DATA_DIR, 'uploads', req.body.proposalId || 'tmp');
    fs.ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${uuidv4().slice(0,8)}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 30*1024*1024 } });

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.post('/api/upload', upload.array('images',20), (req,res) => {
  try {
    const files = req.files.map(f => ({
      filename: f.filename,
      url: `/uploads/${req.body.proposalId}/${f.filename}`,
      category: req.body.category || 'general'
    }));
    res.json({ success:true, files });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/parse-estimate', upload.single('pdf'), async (req,res) => {
  try {
    const buf = await fs.readFile(req.file.path);
    await fs.remove(req.file.path);
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-5', max_tokens: 2000,
      messages: [{ role:'user', content: [
        { type:'document', source:{ type:'base64', media_type:'application/pdf', data:buf.toString('base64') }},
        { type:'text', text:`Extract data from this renovation estimate. Return ONLY raw JSON, no markdown, no backticks, no explanation. Schema:
{"clientName":"","projectAddress":"","projectTitle":"","duration":"","grandTotal":0,"scopeCategories":[{"title":"","description":"","icon":"general"}],"lineItems":[{"label":"","amount":0}],"notes":""}
Rules: group scope into 3-6 service categories. For lineItems, create 3-6 items named after the SERVICES being sold (e.g. "Countertop Replacement", "Cabinet Door Installation", "Cabinet Painting & Refinishing", "Trim & Millwork Build") — NOT by cost type (not "Labor", "Materials"). Distribute the grandTotal across these service line items proportionally based on the scope of each service. Never show markup, unit costs, or internal cost breakdowns.` }
      ]}]
    });
    const raw = msg.content[0].text.replace(/```[\w]*\n?/g,'').trim();
    res.json({ success:true, data:JSON.parse(raw) });
  } catch(e) {
    console.error('PDF error:',e.message);
    res.status(500).json({ error:e.message });
  }
});

app.post('/api/generate', async (req,res) => {
  const { proposalData, images } = req.body;
  try {
    const proposalId = proposalData.proposalId || uuidv4();
    const html = buildHtml(proposalData, images||[], proposalId);
    await fs.writeFile(path.join(DATA_DIR,'proposals',`proposal-${proposalId}.html`), html);
    const track = {
      proposalId,
      clientName:     proposalData.clientName||'',
      projectAddress: proposalData.projectAddress||'',
      projectTitle:   proposalData.projectTitle||'',
      totalAmount:    proposalData.grandTotal||0,
      createdAt:      new Date().toISOString(),
      views:[], totalTimeSeconds:0, lastViewed:null
    };
    RAM.tracking[proposalId] = track;
    fs.writeJson(path.join(DATA_DIR,'tracking',`${proposalId}.json`), track).catch(()=>{});
    res.json({ success:true, proposalId, viewUrl:`/view/${proposalId}` });
  } catch(e) {
    console.error('Generate error:',e.message);
    res.status(500).json({ error:e.message });
  }
});

app.get('/view/:id', (req,res) => {
  const fp = path.join(DATA_DIR,'proposals',`proposal-${req.params.id}.html`);
  if (fs.existsSync(fp)) res.sendFile(fp);
  else res.status(404).send('<body style="background:#191816;color:#F8F4EF;font-family:sans-serif;text-align:center;padding:80px"><h2>Proposal not found</h2></body>');
});

app.post('/api/track', async (req,res) => {
  const { proposalId, event, duration, sessionId, userAgent } = req.body;
  const d = RAM.tracking[proposalId];
  if (!d) return res.json({ ok:true });
  if (event==='open') {
    d.views.push({ openedAt:new Date().toISOString(), userAgent:userAgent||'', duration:0, sessionId });
    d.lastViewed = new Date().toISOString();
  }
  if (event==='close'||event==='heartbeat') {
    const s = d.views.find(v=>v.sessionId===sessionId);
    if (s) s.duration = duration||0;
    d.totalTimeSeconds = d.views.reduce((sum,v)=>sum+(v.duration||0),0);
  }
  fs.writeJson(path.join(DATA_DIR,'tracking',`${proposalId}.json`),d).catch(()=>{});
  res.json({ ok:true });
});

app.get('/api/proposals', (req,res) => {
  res.json(Object.values(RAM.tracking).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)));
});

app.get('/api/proposals/:id', (req,res) => {
  const d = RAM.tracking[req.params.id];
  d ? res.json(d) : res.status(404).json({ error:'Not found' });
});

// ── HTML BUILDER (no Claude for HTML — pure template) ─────────────────────────

function esc(s){ return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

const ICON = {
  general:    `<svg viewBox="0 0 36 36" fill="none" width="36" height="36"><circle cx="18" cy="18" r="14" stroke="#C9A96E" stroke-width="1.5"/><path d="M18 11v7l4 2" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  countertop: `<svg viewBox="0 0 36 36" fill="none" width="36" height="36"><rect x="3" y="14" width="30" height="5" rx="1" stroke="#C9A96E" stroke-width="1.5"/><rect x="6" y="19" width="24" height="10" rx="1" stroke="#C9A96E" stroke-width="1.4"/><path d="M10 14V9h16v5" stroke="#C9A96E" stroke-width="1.4"/></svg>`,
  cabinet:    `<svg viewBox="0 0 36 36" fill="none" width="36" height="36"><rect x="3" y="4" width="30" height="28" rx="1.5" stroke="#C9A96E" stroke-width="1.5"/><path d="M3 18h30M18 4v28" stroke="#C9A96E" stroke-width="1.4"/><circle cx="13" cy="18" r="1.5" fill="#C9A96E"/><circle cx="23" cy="18" r="1.5" fill="#C9A96E"/></svg>`,
  paint:      `<svg viewBox="0 0 36 36" fill="none" width="36" height="36"><path d="M9 27l13-13" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/><rect x="18" y="5" width="11" height="8" rx="1.5" stroke="#C9A96E" stroke-width="1.4"/><path d="M23 13v5" stroke="#C9A96E" stroke-width="1.4" stroke-linecap="round"/><circle cx="9" cy="27" r="3" stroke="#C9A96E" stroke-width="1.4"/></svg>`,
  plumbing:   `<svg viewBox="0 0 36 36" fill="none" width="36" height="36"><path d="M10 8v12a8 8 0 008 8v0a8 8 0 008-8V8" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/><path d="M7 8h22" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  trim:       `<svg viewBox="0 0 36 36" fill="none" width="36" height="36"><rect x="4" y="4" width="28" height="28" rx="1.5" stroke="#C9A96E" stroke-width="1.5"/><rect x="9" y="9" width="18" height="18" rx="1" stroke="#C9A96E" stroke-width="1.2"/></svg>`,
  flooring:   `<svg viewBox="0 0 36 36" fill="none" width="36" height="36"><rect x="3" y="3" width="30" height="30" rx="1" stroke="#C9A96E" stroke-width="1.5"/><path d="M3 13h30M3 23h30M13 3v30M23 3v30" stroke="#C9A96E" stroke-width="1"/></svg>`,
  cleanup:    `<svg viewBox="0 0 36 36" fill="none" width="36" height="36"><path d="M13 16l-4 13h18l-4-13" stroke="#C9A96E" stroke-width="1.5" stroke-linejoin="round"/><path d="M18 7v9M10 11l8-4 8 4" stroke="#C9A96E" stroke-width="1.4" stroke-linecap="round"/></svg>`
};

function buildHtml(data, images, proposalId) {
  const { clientName='', projectTitle='', projectAddress='', duration='', scopeCategories=[], lineItems=[], grandTotal=0 } = data;

  const heroImgs   = images.filter(i=>i.category==='project');
  const renderImgs = images.filter(i=>i.category==='render');
  const baImgs     = images.filter(i=>i.category==='before_after');

  const heroBg = heroImgs.length
    ? `background-image:url('${heroImgs[0].url}');background-size:cover;background-position:center`
    : `background:linear-gradient(135deg,#1f1d1a 0%,#2a2520 100%)`;

  // Distribute grandTotal across scope categories by service
  const total = Number(grandTotal) || 0;
  function distributeAmounts(categories, total) {
    if (!categories.length) return [];
    const weightMap = { countertop:0.30, cabinet:0.28, paint:0.18, trim:0.10, plumbing:0.06, cleanup:0.04, flooring:0.25, demo:0.08, general:0.15 };
    const weights = categories.map(c => weightMap[c.icon] || 0.15);
    const totalWeight = weights.reduce((s,w)=>s+w,0);
    let dist = weights.map((w,i) => ({ label:categories[i].title, amount:Math.round((w/totalWeight)*total) }));
    const sum = dist.slice(0,-1).reduce((s,d)=>s+d.amount,0);
    dist[dist.length-1].amount = total - sum;
    return dist;
  }
  const isServiceBased = lineItems.length > 0 && !lineItems.some(l => /^labor|^material|^suppli|^subcon|^debris|^dump/i.test(l.label));
  const displayItems = isServiceBased ? lineItems : distributeAmounts(scopeCategories, total);

  // ── SCOPE CARDS paired with images ──
  // Match each scope category with a render image if available
  const scopeCards = scopeCategories.map((s, idx) => {
    const img = renderImgs[idx] || null;
    const icon = ICON[s.icon] || ICON.general;
    return `
    <div style="border:1px solid rgba(201,169,110,0.22);background:rgba(255,255,255,0.02);overflow:hidden;display:flex;flex-direction:column">
      ${img ? `<div style="height:280px;overflow:hidden"><img src="${img.url}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;transition:transform 0.4s ease" onmouseover="this.style.transform='scale(1.03)'" onmouseout="this.style.transform='scale(1)'"></div>` : ''}
      <div style="padding:26px 24px;flex:1;display:flex;flex-direction:column">
        <div style="margin-bottom:12px;opacity:0.7">${icon}</div>
        <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#C9A96E;margin-bottom:8px">${esc(s.icon==='countertop'?'Surfaces':s.icon==='cabinet'?'Cabinetry':s.icon==='paint'?'Finishes':s.icon==='trim'?'Millwork':s.icon==='plumbing'?'Plumbing':s.icon==='flooring'?'Flooring':'Renovation')}</div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;color:#F8F4EF;margin-bottom:10px;line-height:1.2">${esc(s.title)}</div>
        <div style="font-size:14px;color:#b8b0a2;line-height:1.7;flex:1">${esc(s.description)}</div>
      </div>
    </div>`;
  }).join('');

  // ── EXTRA images not paired with scope ──
  const extraRenders = renderImgs.slice(scopeCategories.length);
  const extraGallery = extraRenders.length ? `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">
      ${extraRenders.map(i=>`<img src="${i.url}" alt="" style="width:100%;height:340px;object-fit:cover;border:1px solid rgba(201,169,110,0.18);display:block">`).join('')}
    </div>` : '';

  // ── BEFORE / AFTER — "Current State" vs "After Renovation" ──
  const baSection = baImgs.length ? (() => {
    const pairs = [];
    for (let i = 0; i < baImgs.length; i += 2) {
      pairs.push({ before: baImgs[i], after: baImgs[i+1]||null });
    }
    return `
    <section style="padding:80px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="max-width:1100px;margin:0 auto;padding:0 6%">
        <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">The Transformation</div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,44px);font-weight:300;color:#F8F4EF;margin-bottom:10px">Current State &amp; Vision</div>
        <div style="font-size:14px;color:#b8b0a2;margin-bottom:40px;max-width:560px">A side-by-side view of where your space stands today, and the elevated result we'll deliver.</div>
        ${pairs.map(p=>`
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-bottom:3px">
          <div style="position:relative;overflow:hidden">
            <img src="${p.before.url}" alt="Current" style="width:100%;height:460px;object-fit:cover;display:block;filter:brightness(0.92)">
            <div style="position:absolute;top:20px;left:20px;background:rgba(25,24,22,0.82);padding:7px 16px;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#b8b0a2;border:1px solid rgba(255,255,255,0.12)">Current State</div>
          </div>
          ${p.after ? `
          <div style="position:relative;overflow:hidden">
            <img src="${p.after.url}" alt="After Renovation" style="width:100%;height:460px;object-fit:cover;display:block">
            <div style="position:absolute;top:20px;left:20px;background:rgba(201,169,110,0.15);padding:7px 16px;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#C9A96E;border:1px solid rgba(201,169,110,0.4)">After Renovation</div>
          </div>` : `<div style="background:#1f1d1a;height:460px;display:flex;align-items:center;justify-content:center"><span style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#b8b0a2">Coming Soon</span></div>`}
        </div>`).join('')}
      </div>
    </section>
    <div style="text-align:center;padding:10px 0;color:#C9A96E;font-size:10px;letter-spacing:8px;opacity:0.5">◆ &nbsp; ◆ &nbsp; ◆</div>`;
  })() : '';

  const invRows = displayItems.map(l=>`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:18px 36px;border-bottom:1px solid rgba(255,255,255,0.05)">
      <span style="color:#b8b0a2;font-size:16px">${esc(l.label)}</span>
      <span style="color:#F8F4EF;font-size:16px;font-weight:500">$${Number(l.amount).toLocaleString('en-US',{minimumFractionDigits:2})}</span>
    </div>`).join('');

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

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(clientName)} — Formo Renovation</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,400;1,600&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{background:#191816;color:#F8F4EF;font-family:'Jost',sans-serif;-webkit-font-smoothing:antialiased}
img{display:block;max-width:100%}
a{color:#C9A96E;text-decoration:none}
@media(max-width:768px){
  .scope-grid{grid-template-columns:1fr!important}
  .why-grid{grid-template-columns:1fr!important}
  .two-col{grid-template-columns:1fr!important}
  .inv-amount{font-size:42px!important}
  .hero-name{font-size:46px!important}
  .cta-box{padding:28px 24px!important}
}
</style>
</head>
<body>

<!-- HERO -->
<section style="position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden">
  <div style="position:absolute;inset:0;${heroBg}"></div>
  <!-- Gradient overlay: dark top + dark bottom, lighter in middle to show photo -->
  <div style="position:absolute;inset:0;background:linear-gradient(to bottom,rgba(25,24,22,0.72) 0%,rgba(25,24,22,0.25) 45%,rgba(25,24,22,0.72) 100%)"></div>
  <div style="position:relative;z-index:1;padding:80px 6%;max-width:920px;width:100%">
    <!-- Brand bar -->
    <div style="display:inline-flex;align-items:center;gap:14px;margin-bottom:44px;padding:9px 22px;border:1px solid rgba(201,169,110,0.35);background:rgba(25,24,22,0.5)">
      <div style="width:18px;height:1px;background:#C9A96E;opacity:0.7"></div>
      <span style="font-size:10px;letter-spacing:5px;text-transform:uppercase;color:#C9A96E;opacity:0.9">Formo Renovation</span>
      <div style="width:18px;height:1px;background:#C9A96E;opacity:0.7"></div>
    </div>
    <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:rgba(248,244,239,0.5);margin-bottom:18px">Prepared For</div>
    <h1 class="hero-name" style="font-family:'Cormorant Garamond',serif;font-size:clamp(50px,8vw,88px);font-weight:300;letter-spacing:2px;line-height:1;color:#F8F4EF;margin-bottom:20px;text-shadow:0 2px 24px rgba(0,0,0,0.5)">${esc(clientName)}</h1>
    <div style="width:48px;height:1px;background:#C9A96E;margin:0 auto 20px;opacity:0.5"></div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:clamp(17px,2.5vw,23px);font-style:italic;color:#C9A96E;margin-bottom:12px">${esc(projectTitle)}</div>
    <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:rgba(248,244,239,0.45);margin-bottom:26px">${esc(projectAddress)}</div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:14px;font-style:italic;color:rgba(248,244,239,0.35)">"Built on quality, driven by integrity"</div>
  </div>
  <div style="position:absolute;bottom:32px;left:50%;transform:translateX(-50%);color:#C9A96E;font-size:18px;opacity:0.45">↓</div>
</section>

<div style="text-align:center;padding:10px 0;color:#C9A96E;font-size:10px;letter-spacing:8px;opacity:0.45">◆ &nbsp; ◆ &nbsp; ◆</div>

<!-- SCOPE + IMAGES PAIRED -->
<section style="padding:80px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
  <div style="max-width:1100px;margin:0 auto;padding:0 6%">
    <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">Scope of Work</div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,44px);font-weight:300;color:#F8F4EF;margin-bottom:10px">What We'll Deliver</div>
    <div style="font-size:14px;color:#b8b0a2;margin-bottom:40px;max-width:560px">Each service crafted with precision, premium materials, and an uncompromising eye for detail.</div>
    <div class="scope-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px">
      ${scopeCards}
    </div>
    ${extraGallery}
  </div>
</section>

<div style="text-align:center;padding:10px 0;color:#C9A96E;font-size:10px;letter-spacing:8px;opacity:0.45">◆ &nbsp; ◆ &nbsp; ◆</div>

${baSection}

<!-- INVESTMENT -->
<section style="padding:80px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
  <div style="max-width:1100px;margin:0 auto;padding:0 6%">
    <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">Your Investment</div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,44px);font-weight:300;color:#F8F4EF;margin-bottom:10px">Project Investment</div>
    <div style="font-size:14px;color:#b8b0a2;margin-bottom:40px;max-width:560px">A transparent summary of the services included in your renovation — priced by what we deliver.</div>
    <div style="max-width:680px;border:1px solid rgba(201,169,110,0.25);background:rgba(255,255,255,0.02)">
      ${duration?`<div style="text-align:center;padding:13px;border-bottom:1px solid rgba(201,169,110,0.18);font-size:10px;letter-spacing:3.5px;text-transform:uppercase;color:#C9A96E">${esc(duration)} Estimated Timeline</div>`:''}
      ${invRows}
      <div style="padding:28px 36px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(201,169,110,0.18)">
        <div>
          <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#b8b0a2;margin-bottom:4px">Total Investment</div>
          <div style="font-size:12px;color:rgba(201,169,110,0.5);letter-spacing:1px">All services included</div>
        </div>
        <span class="inv-amount" style="font-family:'Cormorant Garamond',serif;font-size:58px;font-weight:600;color:#C9A96E;line-height:1">$${Number(grandTotal).toLocaleString('en-US',{minimumFractionDigits:2})}</span>
      </div>
      <!-- All-inclusive note -->
      <div style="padding:16px 36px;background:rgba(201,169,110,0.05);border-top:1px solid rgba(201,169,110,0.12);display:flex;align-items:center;gap:10px">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="#C9A96E" stroke-width="1.2"/><path d="M7 6v4M7 4v.5" stroke="#C9A96E" stroke-width="1.3" stroke-linecap="round"/></svg>
        <span style="font-size:12px;color:#b8b0a2;letter-spacing:0.5px">Price includes <strong style="color:#C9A96E;font-weight:500">materials, labor, logistics &amp; cleanup</strong> — no hidden costs.</span>
      </div>
    </div>
  </div>
</section>

<div style="text-align:center;padding:10px 0;color:#C9A96E;font-size:10px;letter-spacing:8px;opacity:0.45">◆ &nbsp; ◆ &nbsp; ◆</div>

<!-- MATERIALS & LOGISTICS -->
<section style="padding:80px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
  <div style="max-width:1100px;margin:0 auto;padding:0 6%">
    <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">What's Included</div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,44px);font-weight:300;color:#F8F4EF;margin-bottom:10px">Materials &amp; Logistics</div>
    <div style="font-size:14px;color:#b8b0a2;margin-bottom:44px;max-width:560px;line-height:1.7">Everything needed to complete your renovation is covered — from the first tool to the final cleanup. No surprises, no add-ons.</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:3px">
      <div style="padding:32px 28px;border:1px solid rgba(201,169,110,0.22);background:rgba(255,255,255,0.02)">
        <div style="margin-bottom:16px;opacity:0.75">
          <svg viewBox="0 0 38 38" fill="none" width="36" height="36"><rect x="4" y="8" width="30" height="22" rx="1.5" stroke="#C9A96E" stroke-width="1.5"/><path d="M4 14h30M11 8v6M27 8v6" stroke="#C9A96E" stroke-width="1.4" stroke-linecap="round"/><circle cx="19" cy="22" r="2.5" stroke="#C9A96E" stroke-width="1.3"/></svg>
        </div>
        <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#C9A96E;margin-bottom:8px">Materials</div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:#F8F4EF;margin-bottom:10px">Premium Materials</div>
        <div style="font-size:13px;color:#b8b0a2;line-height:1.7">All paints, primers, adhesives, hardware, and finishing supplies are sourced at professional grade and included in your investment — no separate material invoices.</div>
      </div>
      <div style="padding:32px 28px;border:1px solid rgba(201,169,110,0.22);background:rgba(255,255,255,0.02)">
        <div style="margin-bottom:16px;opacity:0.75">
          <svg viewBox="0 0 38 38" fill="none" width="36" height="36"><rect x="3" y="14" width="26" height="16" rx="1.5" stroke="#C9A96E" stroke-width="1.5"/><path d="M29 20h4l2 4v4h-6" stroke="#C9A96E" stroke-width="1.4" stroke-linejoin="round"/><circle cx="10" cy="32" r="2.5" stroke="#C9A96E" stroke-width="1.3"/><circle cx="24" cy="32" r="2.5" stroke="#C9A96E" stroke-width="1.3"/><path d="M8 14V9a3 3 0 013-3h6a3 3 0 013 3v5" stroke="#C9A96E" stroke-width="1.4"/></svg>
        </div>
        <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#C9A96E;margin-bottom:8px">Logistics</div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:#F8F4EF;margin-bottom:10px">Delivery &amp; Transport</div>
        <div style="font-size:13px;color:#b8b0a2;line-height:1.7">All material delivery, tool transport, and crew logistics are fully coordinated and covered. You don't lift a finger — we handle the entire operational side.</div>
      </div>
      <div style="padding:32px 28px;border:1px solid rgba(201,169,110,0.22);background:rgba(255,255,255,0.02)">
        <div style="margin-bottom:16px;opacity:0.75">
          <svg viewBox="0 0 38 38" fill="none" width="36" height="36"><path d="M10 28l14-14M10 26L8 28l2-2z" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/><path d="M20 8l10 10-4 2-8-8 2-4z" stroke="#C9A96E" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 30l2-2" stroke="#C9A96E" stroke-width="1.4" stroke-linecap="round"/></svg>
        </div>
        <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#C9A96E;margin-bottom:8px">Labor</div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:#F8F4EF;margin-bottom:10px">Skilled Labor</div>
        <div style="font-size:13px;color:#b8b0a2;line-height:1.7">Our experienced crew handles every trade involved in your project. Fully supervised, professionally managed, and held to the highest standard of finish quality.</div>
      </div>
      <div style="padding:32px 28px;border:1px solid rgba(201,169,110,0.22);background:rgba(255,255,255,0.02)">
        <div style="margin-bottom:16px;opacity:0.75">
          <svg viewBox="0 0 38 38" fill="none" width="36" height="36"><path d="M12 16l-4 14h22l-4-14" stroke="#C9A96E" stroke-width="1.5" stroke-linejoin="round"/><path d="M19 7v9M11 11l8-4 8 4" stroke="#C9A96E" stroke-width="1.4" stroke-linecap="round"/><path d="M15 30v-6h8v6" stroke="#C9A96E" stroke-width="1.3"/></svg>
        </div>
        <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#C9A96E;margin-bottom:8px">Site Care</div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:#F8F4EF;margin-bottom:10px">Protection &amp; Cleanup</div>
        <div style="font-size:13px;color:#b8b0a2;line-height:1.7">Your home is treated with care throughout the entire process — surfaces protected, debris removed daily, and a full post-project cleanup before we hand the space back to you.</div>
      </div>
    </div>
  </div>
</section>

<div style="text-align:center;padding:10px 0;color:#C9A96E;font-size:10px;letter-spacing:8px;opacity:0.45">◆ &nbsp; ◆ &nbsp; ◆</div>

<!-- WHY FORMO -->
<section style="padding:80px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
  <div style="max-width:1100px;margin:0 auto;padding:0 6%">
    <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">The Formo Standard</div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,44px);font-weight:300;color:#F8F4EF;margin-bottom:40px">Why Our Clients Choose Us</div>
    <div class="why-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:2px">
      <div style="padding:36px 28px;border:1px solid rgba(201,169,110,0.25);background:rgba(255,255,255,0.02);text-align:center">
        <div style="margin:0 auto 18px;width:38px;opacity:0.7"><svg viewBox="0 0 38 38" fill="none" width="38" height="38"><circle cx="19" cy="19" r="16" stroke="#C9A96E" stroke-width="1.5"/><path d="M12 19l5 5 9-9" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:21px;font-weight:600;color:#F8F4EF;margin-bottom:12px">Licensed &amp; Insured</div>
        <div style="font-size:13px;color:#b8b0a2;line-height:1.7">Fully licensed and insured on every project, giving you complete peace of mind throughout the renovation process.</div>
      </div>
      <div style="padding:36px 28px;border:1px solid rgba(201,169,110,0.25);background:rgba(255,255,255,0.02);text-align:center">
        <div style="margin:0 auto 18px;width:38px;opacity:0.7"><svg viewBox="0 0 38 38" fill="none" width="38" height="38"><circle cx="19" cy="19" r="16" stroke="#C9A96E" stroke-width="1.5"/><path d="M19 10v9l6 3" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/></svg></div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:21px;font-weight:600;color:#F8F4EF;margin-bottom:12px">On-Time Delivery</div>
        <div style="font-size:13px;color:#b8b0a2;line-height:1.7">We set clear milestones, communicate daily, and respect your timeline. Your project, delivered as promised.</div>
      </div>
      <div style="padding:36px 28px;border:1px solid rgba(201,169,110,0.25);background:rgba(255,255,255,0.02);text-align:center">
        <div style="margin:0 auto 18px;width:38px;opacity:0.7"><svg viewBox="0 0 38 38" fill="none" width="38" height="38"><circle cx="19" cy="19" r="16" stroke="#C9A96E" stroke-width="1.5"/><path d="M19 13l2.5 5h5.5l-4.5 3.5 1.5 5.5L19 24l-4.5 3 1.5-5.5L11.5 18h5.5z" stroke="#C9A96E" stroke-width="1.4" stroke-linejoin="round"/></svg></div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:21px;font-weight:600;color:#F8F4EF;margin-bottom:12px">Premium Craftsmanship</div>
        <div style="font-size:13px;color:#b8b0a2;line-height:1.7">Every surface, joint, and finish is executed with master-level precision. We don't settle for good — we deliver exceptional.</div>
      </div>
    </div>
  </div>
</section>

<div style="text-align:center;padding:10px 0;color:#C9A96E;font-size:10px;letter-spacing:8px;opacity:0.45">◆ &nbsp; ◆ &nbsp; ◆</div>

<!-- CTA -->
<section style="padding:100px 0;text-align:center">
  <div style="max-width:1100px;margin:0 auto;padding:0 6%">
    <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">Begin Your Renovation</div>
    <h2 style="font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,52px);font-weight:300;color:#F8F4EF;margin-bottom:12px">Ready to transform your space?</h2>
    <p style="font-size:14px;color:#b8b0a2;max-width:480px;margin:0 auto 48px;line-height:1.7">We'd love to schedule a walkthrough and lock in your start date. Reach out — we typically respond within a few hours.</p>
    <div class="cta-box" style="display:inline-block;text-align:left;border:1px solid rgba(201,169,110,0.28);padding:36px 52px;background:rgba(255,255,255,0.02)">
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">Your Project Lead</div>
      <div style="font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:600;color:#F8F4EF;margin-bottom:20px">Dan Lares</div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2h4l1.5 3-1.8 1a7 7 0 003.3 3.3L10 7.5l3 1.5v3a1 1 0 01-1 1A11 11 0 011 3a1 1 0 011-1z" stroke="#C9A96E" stroke-width="1.2"/></svg>
        <a href="tel:6156081220" style="font-size:15px;color:#b8b0a2">615-608-1220</a>
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="3" width="12" height="9" rx="1" stroke="#C9A96E" stroke-width="1.2"/><path d="M1 4l6 3.5L13 4" stroke="#C9A96E" stroke-width="1.2"/></svg>
        <a href="mailto:dan@formorenovation.com" style="font-size:15px;color:#b8b0a2">dan@formorenovation.com</a>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="#C9A96E" stroke-width="1.2"/><path d="M7 1.5a8 8 0 010 11M1.5 7h11" stroke="#C9A96E" stroke-width="1.2"/></svg>
        <a href="https://formorenovation.com" target="_blank" style="font-size:15px;color:#b8b0a2">formorenovation.com</a>
      </div>
    </div>
  </div>
</section>

${trackScript}
</body>
</html>`;
}


app.listen(PORT, () => console.log(`Formo running on port ${PORT}`));
