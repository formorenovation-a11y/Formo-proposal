require('dotenv').config();
const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

// Firebase
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');
const { getStorage }          = require('firebase-admin/storage');

const app  = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── FIREBASE INIT ─────────────────────────────────────────────────────────────
const firebaseConfig = {
  credential: cert({
    projectId:    process.env.FIREBASE_PROJECT_ID,
    clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:   (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  }),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
};
initializeApp(firebaseConfig);
const db      = getFirestore();
const bucket  = getStorage().bucket();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Temp upload dir for multer (images go to Firebase Storage after)
const TMP = path.join(__dirname, 'tmp');
fs.ensureDirSync(TMP);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${uuidv4().slice(0,8)}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 30*1024*1024 } });

// ── RAM CACHE (fast reads, Firebase is source of truth) ───────────────────────
const RAM = { tracking: {}, proposals: {} };

// Warm RAM from Firestore on startup
(async () => {
  try {
    const snap = await db.collection('proposals').get();
    snap.forEach(doc => { RAM.tracking[doc.id] = doc.data(); });
    console.log(`Warmed ${snap.size} proposals from Firestore`);
  } catch(e) { console.log('Firestore warm-up skipped:', e.message); }
})();

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function uploadToFirebase(localPath, destPath, contentType) {
  await bucket.upload(localPath, {
    destination: destPath,
    metadata: { contentType }
  });
  const [url] = await bucket.file(destPath).getSignedUrl({
    action: 'read',
    expires: '2099-01-01'
  });
  return url;
}

async function saveProposalHtml(proposalId, html) {
  // Save to Firebase Storage
  const tmpFile = path.join(TMP, `${proposalId}.html`);
  await fs.writeFile(tmpFile, html);
  const url = await uploadToFirebase(tmpFile, `proposals/${proposalId}.html`, 'text/html');
  await fs.remove(tmpFile);
  // Also keep in RAM
  RAM.proposals[proposalId] = html;
  return url;
}

async function getProposalHtml(proposalId) {
  // RAM first
  if (RAM.proposals[proposalId]) return RAM.proposals[proposalId];
  // Fetch from Firebase Storage
  try {
    const file = bucket.file(`proposals/${proposalId}.html`);
    const [contents] = await file.download();
    const html = contents.toString('utf8');
    RAM.proposals[proposalId] = html; // warm cache
    return html;
  } catch(e) { return null; }
}

async function saveTracking(data) {
  RAM.tracking[data.proposalId] = data;
  await db.collection('proposals').doc(data.proposalId).set(data);
}

async function updateTracking(proposalId, data) {
  RAM.tracking[proposalId] = data;
  await db.collection('proposals').doc(proposalId).set(data);
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

// Upload images → Firebase Storage
app.post('/api/upload', upload.array('images',20), async (req,res) => {
  try {
    const { proposalId, category } = req.body;
    const files = await Promise.all(req.files.map(async f => {
      const dest = `uploads/${proposalId}/${category}/${f.filename}`;
      const url  = await uploadToFirebase(f.path, dest, f.mimetype || 'image/jpeg');
      await fs.remove(f.path);
      return { filename: f.filename, url, category };
    }));
    res.json({ success:true, files });
  } catch(e) {
    console.error('Upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Parse PDF estimate
app.post('/api/parse-estimate', upload.single('pdf'), async (req,res) => {
  try {
    const buf = await fs.readFile(req.file.path);
    await fs.remove(req.file.path);
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-5', max_tokens: 2000,
      messages: [{ role:'user', content: [
        { type:'document', source:{ type:'base64', media_type:'application/pdf', data:buf.toString('base64') }},
        { type:'text', text:`Extract data from this renovation estimate. Return ONLY raw JSON, no markdown, no backticks:
{"clientName":"","projectAddress":"","projectTitle":"","duration":"","grandTotal":0,
"scopeCategories":[{"title":"","description":"","icon":"general"}],
"lineItems":[{"label":"","amount":0}],"notes":""}
Rules: group scope into 3-6 service categories. LineItems named after SERVICES (e.g. "Countertop Replacement", "Cabinet Door Installation") — NOT cost types. Distribute grandTotal across services. Never show markup or unit costs.` }
      ]}]
    });
    const raw = msg.content[0].text.replace(/```[\w]*\n?/g,'').trim();
    res.json({ success:true, data:JSON.parse(raw) });
  } catch(e) {
    console.error('PDF error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Generate proposal
app.post('/api/generate', async (req,res) => {
  const { proposalData, images } = req.body;
  try {
    const proposalId = proposalData.proposalId || uuidv4();
    const html = buildHtml(proposalData, images||[], proposalId);

    // Save HTML to Firebase Storage
    await saveProposalHtml(proposalId, html);

    // Save tracking to Firestore
    const track = {
      proposalId,
      clientName:     proposalData.clientName||'',
      projectAddress: proposalData.projectAddress||'',
      projectTitle:   proposalData.projectTitle||'',
      totalAmount:    proposalData.grandTotal||0,
      createdAt:      new Date().toISOString(),
      views: [], totalTimeSeconds:0, lastViewed:null
    };
    await saveTracking(track);

    res.json({ success:true, proposalId, viewUrl:`/view/${proposalId}` });
  } catch(e) {
    console.error('Generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Serve proposal — from RAM or Firebase Storage
app.get('/view/:id', async (req,res) => {
  const html = await getProposalHtml(req.params.id);
  if (html) {
    res.setHeader('Content-Type','text/html');
    return res.send(html);
  }
  res.status(404).send(`<body style="background:#191816;color:#F8F4EF;font-family:sans-serif;text-align:center;padding:80px;margin:0">
    <h2>Proposal not found</h2>
    <p style="color:#9a9080;margin-top:12px">This proposal may have expired. Please generate a new one.</p>
  </body>`);
});

// Tracking
app.post('/api/track', async (req,res) => {
  const { proposalId, event, duration, sessionId, userAgent } = req.body;
  const d = RAM.tracking[proposalId];
  if (!d) return res.json({ ok:true });
  if (event==='open') {
    if (!d.views) d.views = [];
    d.views.push({ openedAt:new Date().toISOString(), userAgent:userAgent||'', duration:0, sessionId });
    d.lastViewed = new Date().toISOString();
  }
  if (event==='close'||event==='heartbeat') {
    const s = (d.views||[]).find(v=>v.sessionId===sessionId);
    if (s) s.duration = duration||0;
    d.totalTimeSeconds = (d.views||[]).reduce((sum,v)=>sum+(v.duration||0),0);
  }
  // Save to Firestore async
  updateTracking(proposalId, d).catch(()=>{});
  res.json({ ok:true });
});

// Get all proposals
app.get('/api/proposals', (req,res) => {
  const list = Object.values(RAM.tracking).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  res.json(list);
});

// Get single proposal
app.get('/api/proposals/:id', (req,res) => {
  const d = RAM.tracking[req.params.id];
  d ? res.json(d) : res.status(404).json({ error:'Not found' });
});

// ── HTML BUILDER ──────────────────────────────────────────────────────────────

function esc(s){ return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

const ICON = {
  general:    `<svg viewBox="0 0 38 38" fill="none" width="36" height="36"><circle cx="19" cy="19" r="14" stroke="#C9A96E" stroke-width="1.5"/><path d="M19 11v8l4 2" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  countertop: `<svg viewBox="0 0 38 38" fill="none" width="36" height="36"><rect x="3" y="15" width="32" height="5" rx="1" stroke="#C9A96E" stroke-width="1.5"/><rect x="6" y="20" width="26" height="10" rx="1" stroke="#C9A96E" stroke-width="1.4"/><path d="M10 15V9h18v6" stroke="#C9A96E" stroke-width="1.4"/></svg>`,
  cabinet:    `<svg viewBox="0 0 38 38" fill="none" width="36" height="36"><rect x="3" y="4" width="32" height="30" rx="1.5" stroke="#C9A96E" stroke-width="1.5"/><path d="M3 19h32M19 4v30" stroke="#C9A96E" stroke-width="1.4"/><circle cx="13" cy="19" r="1.5" fill="#C9A96E"/><circle cx="25" cy="19" r="1.5" fill="#C9A96E"/></svg>`,
  paint:      `<svg viewBox="0 0 38 38" fill="none" width="36" height="36"><path d="M9 29l14-14" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/><rect x="19" y="5" width="11" height="8" rx="1.5" stroke="#C9A96E" stroke-width="1.4"/><path d="M24 13v5" stroke="#C9A96E" stroke-width="1.4" stroke-linecap="round"/><circle cx="9" cy="29" r="3" stroke="#C9A96E" stroke-width="1.4"/></svg>`,
  plumbing:   `<svg viewBox="0 0 38 38" fill="none" width="36" height="36"><path d="M10 8v13a9 9 0 009 9v0a9 9 0 009-9V8" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/><path d="M7 8h24" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  trim:       `<svg viewBox="0 0 38 38" fill="none" width="36" height="36"><rect x="4" y="4" width="30" height="30" rx="1.5" stroke="#C9A96E" stroke-width="1.5"/><rect x="9" y="9" width="20" height="20" rx="1" stroke="#C9A96E" stroke-width="1.2"/></svg>`,
  flooring:   `<svg viewBox="0 0 38 38" fill="none" width="36" height="36"><rect x="3" y="3" width="32" height="32" rx="1" stroke="#C9A96E" stroke-width="1.5"/><path d="M3 14h32M3 24h32M14 3v32M24 3v32" stroke="#C9A96E" stroke-width="1"/></svg>`,
  cleanup:    `<svg viewBox="0 0 38 38" fill="none" width="36" height="36"><path d="M13 17l-4 14h20l-4-14" stroke="#C9A96E" stroke-width="1.5" stroke-linejoin="round"/><path d="M19 7v10M11 12l8-5 8 5" stroke="#C9A96E" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  demo:       `<svg viewBox="0 0 38 38" fill="none" width="36" height="36"><path d="M10 28L28 10M10 10l18 18" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/></svg>`
};

const CAT_LABEL = {countertop:'Surfaces',cabinet:'Cabinetry',paint:'Finishes',trim:'Millwork',plumbing:'Plumbing',flooring:'Flooring',cleanup:'Site Care',demo:'Demo',general:'Renovation'};

function buildHtml(data, images, proposalId) {
  const { clientName='', projectTitle='', projectAddress='', duration='', scopeCategories=[], lineItems=[], grandTotal=0 } = data;

  const heroImgs  = images.filter(i=>i.category==='project');
  const baImgs    = images.filter(i=>i.category==='before_after');
  const afterImgs = images.filter(i=>i.category==='render');
  const svcImgs   = idx => images.filter(i=>i.category===`service_${idx}`);

  const heroBg = heroImgs.length
    ? `background-image:url('${heroImgs[0].url}');background-size:cover;background-position:center`
    : `background:linear-gradient(135deg,#1f1d1a 0%,#2a2520 100%)`;

  // Budget distribution
  const total = Number(grandTotal)||0;
  const wm = {countertop:0.30,cabinet:0.28,paint:0.18,trim:0.10,plumbing:0.06,cleanup:0.04,flooring:0.25,demo:0.08,general:0.15};
  function distribute(cats,total){
    if(!cats.length)return[];
    const ws=cats.map(c=>wm[c.icon]||0.15),tw=ws.reduce((s,w)=>s+w,0);
    let d=ws.map((w,i)=>({label:cats[i].title,amount:Math.round((w/tw)*total)}));
    d[d.length-1].amount=total-d.slice(0,-1).reduce((s,x)=>s+x.amount,0);
    return d;
  }
  const isService = lineItems.length>0 && !lineItems.some(l=>/^labor|^material|^suppli|^subcon|^debris|^dump/i.test(l.label));
  const displayItems = isService ? lineItems : distribute(scopeCategories,total);

  // Scope cards
  const scopeCards = scopeCategories.map((s,idx)=>{
    const imgs = svcImgs(idx);
    return `
    <div style="border:1px solid rgba(201,169,110,0.22);background:rgba(255,255,255,0.02);overflow:hidden">
      ${imgs.length?`<div style="display:grid;grid-template-columns:repeat(${Math.min(imgs.length,3)},1fr);gap:2px">${imgs.map(i=>`<img src="${i.url}" alt="" style="width:100%;height:200px;object-fit:cover;display:block">`).join('')}</div>`:''}
      <div style="padding:28px 26px">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
          <div style="opacity:0.7;flex-shrink:0">${ICON[s.icon]||ICON.general}</div>
          <div>
            <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#C9A96E;margin-bottom:4px">${CAT_LABEL[s.icon]||'Renovation'}</div>
            <div style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;color:#F8F4EF;line-height:1.2">${esc(s.title)}</div>
          </div>
        </div>
        <div style="font-size:14px;color:#b8b0a2;line-height:1.75">${esc(s.description)}</div>
      </div>
    </div>`;
  }).join('');

  // Comparison section
  const maxPairs = Math.max(baImgs.length, afterImgs.length);
  const compareSection = maxPairs ? `
<section style="padding:80px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
  <div style="max-width:1100px;margin:0 auto;padding:0 6%">
    <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">The Transformation</div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,44px);font-weight:300;color:#F8F4EF;margin-bottom:10px">Today vs. After Renovation</div>
    <div style="font-size:14px;color:#b8b0a2;margin-bottom:44px;max-width:560px;line-height:1.7">A side-by-side look at your space today, and the elevated result we will deliver.</div>
    ${Array.from({length:maxPairs},(_,i)=>{
      const before = baImgs[i]||null;
      const after  = afterImgs[i]||null;
      return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-bottom:3px">
        ${before
          ?`<div style="position:relative"><img src="${before.url}" alt="Today" style="width:100%;display:block;max-height:500px;object-fit:contain;background:#111"><div style="position:absolute;top:16px;left:16px;background:rgba(25,24,22,0.85);padding:7px 16px;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#b8b0a2;border:1px solid rgba(255,255,255,0.12)">Today</div></div>`
          :`<div style="background:#111;min-height:300px;display:flex;align-items:center;justify-content:center"><span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#333">—</span></div>`}
        ${after
          ?`<div style="position:relative"><img src="${after.url}" alt="After Renovation" style="width:100%;display:block;max-height:500px;object-fit:contain;background:#111"><div style="position:absolute;top:16px;left:16px;background:rgba(201,169,110,0.15);padding:7px 16px;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#C9A96E;border:1px solid rgba(201,169,110,0.4)">After Renovation</div></div>`
          :`<div style="background:#111;min-height:300px;display:flex;align-items:center;justify-content:center;border:1px dashed rgba(201,169,110,0.2)"><span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#C9A96E;opacity:0.4">Coming Soon</span></div>`}
      </div>`;
    }).join('')}
  </div>
</section>
<div style="text-align:center;padding:10px 0;color:#C9A96E;font-size:10px;letter-spacing:8px;opacity:0.45">◆ &nbsp; ◆ &nbsp; ◆</div>` : '';

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
  ping('open');setInterval(function(){if(on)ping('heartbeat');},30000);
  window.addEventListener('beforeunload',function(){ping('close');});
  document.addEventListener('visibilitychange',function(){if(document.hidden){ping('close');on=false;}else{t0=Date.now();on=true;ping('open');}});
})();
</script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(clientName)} — Formo Renovation</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,400;1,600&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}html{scroll-behavior:smooth}
body{background:#191816;color:#F8F4EF;font-family:'Jost',sans-serif;-webkit-font-smoothing:antialiased}
img{display:block;max-width:100%}a{color:#C9A96E;text-decoration:none}
@media(max-width:768px){.sg{grid-template-columns:1fr!important}.wg{grid-template-columns:1fr!important}.cg{grid-template-columns:1fr!important}.ml{grid-template-columns:1fr 1fr!important}.ia{font-size:42px!important}.hn{font-size:46px!important}.cb{padding:28px 24px!important}}
@media(max-width:480px){.ml{grid-template-columns:1fr!important}}
</style>
</head>
<body>

<section style="position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden">
  <div style="position:absolute;inset:0;${heroBg}"></div>
  <div style="position:absolute;inset:0;background:linear-gradient(to bottom,rgba(25,24,22,0.72) 0%,rgba(25,24,22,0.25) 45%,rgba(25,24,22,0.72) 100%)"></div>
  <div style="position:relative;z-index:1;padding:80px 6%;max-width:920px;width:100%">
    <div style="display:inline-flex;align-items:center;gap:14px;margin-bottom:44px;padding:9px 22px;border:1px solid rgba(201,169,110,0.35);background:rgba(25,24,22,0.5)">
      <div style="width:18px;height:1px;background:#C9A96E;opacity:0.7"></div>
      <span style="font-size:10px;letter-spacing:5px;text-transform:uppercase;color:#C9A96E">Formo Renovation</span>
      <div style="width:18px;height:1px;background:#C9A96E;opacity:0.7"></div>
    </div>
    <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:rgba(248,244,239,0.5);margin-bottom:18px">Prepared For</div>
    <h1 class="hn" style="font-family:'Cormorant Garamond',serif;font-size:clamp(50px,8vw,88px);font-weight:300;letter-spacing:2px;line-height:1;color:#F8F4EF;margin-bottom:20px;text-shadow:0 2px 24px rgba(0,0,0,0.5)">${esc(clientName)}</h1>
    <div style="width:48px;height:1px;background:#C9A96E;margin:0 auto 20px;opacity:0.5"></div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:clamp(17px,2.5vw,23px);font-style:italic;color:#C9A96E;margin-bottom:12px">${esc(projectTitle)}</div>
    <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:rgba(248,244,239,0.45);margin-bottom:26px">${esc(projectAddress)}</div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:14px;font-style:italic;color:rgba(248,244,239,0.35)">"Built on quality, driven by integrity"</div>
  </div>
  <div style="position:absolute;bottom:32px;left:50%;transform:translateX(-50%);color:#C9A96E;font-size:18px;opacity:0.45">↓</div>
</section>

<div style="text-align:center;padding:10px 0;color:#C9A96E;font-size:10px;letter-spacing:8px;opacity:0.45">◆ &nbsp; ◆ &nbsp; ◆</div>

<section style="padding:80px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
  <div style="max-width:1100px;margin:0 auto;padding:0 6%">
    <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">Scope of Work</div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,44px);font-weight:300;color:#F8F4EF;margin-bottom:10px">What We'll Deliver</div>
    <div style="font-size:14px;color:#b8b0a2;margin-bottom:40px;max-width:560px;line-height:1.7">Each service crafted with precision, premium materials, and an uncompromising eye for detail.</div>
    <div class="sg" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px">${scopeCards}</div>
  </div>
</section>

<div style="text-align:center;padding:10px 0;color:#C9A96E;font-size:10px;letter-spacing:8px;opacity:0.45">◆ &nbsp; ◆ &nbsp; ◆</div>

${compareSection}

<section style="padding:80px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
  <div style="max-width:1100px;margin:0 auto;padding:0 6%">
    <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">Your Investment</div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,44px);font-weight:300;color:#F8F4EF;margin-bottom:10px">Project Investment</div>
    <div style="font-size:14px;color:#b8b0a2;margin-bottom:40px;max-width:560px;line-height:1.7">A transparent breakdown by service — priced by what we deliver.</div>
    <div style="max-width:680px;border:1px solid rgba(201,169,110,0.25);background:rgba(255,255,255,0.02)">
      ${duration?`<div style="text-align:center;padding:13px;border-bottom:1px solid rgba(201,169,110,0.18);font-size:10px;letter-spacing:3.5px;text-transform:uppercase;color:#C9A96E">${esc(duration)} Estimated Timeline</div>`:''}
      ${invRows}
      <div style="padding:28px 36px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(201,169,110,0.18)">
        <div><div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#b8b0a2;margin-bottom:4px">Total Investment</div><div style="font-size:12px;color:rgba(201,169,110,0.5)">All services included</div></div>
        <span class="ia" style="font-family:'Cormorant Garamond',serif;font-size:58px;font-weight:600;color:#C9A96E;line-height:1">$${Number(grandTotal).toLocaleString('en-US',{minimumFractionDigits:2})}</span>
      </div>
      <div style="padding:16px 36px;background:rgba(201,169,110,0.05);border-top:1px solid rgba(201,169,110,0.12);display:flex;align-items:center;gap:10px">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="#C9A96E" stroke-width="1.2"/><path d="M7 6v4M7 4v.5" stroke="#C9A96E" stroke-width="1.3" stroke-linecap="round"/></svg>
        <span style="font-size:12px;color:#b8b0a2">Price includes <strong style="color:#C9A96E;font-weight:500">materials, labor, logistics &amp; cleanup</strong> — no hidden costs.</span>
      </div>
    </div>
  </div>
</section>

<div style="text-align:center;padding:10px 0;color:#C9A96E;font-size:10px;letter-spacing:8px;opacity:0.45">◆ &nbsp; ◆ &nbsp; ◆</div>

<section style="padding:80px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
  <div style="max-width:1100px;margin:0 auto;padding:0 6%">
    <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">What's Included</div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,44px);font-weight:300;color:#F8F4EF;margin-bottom:10px">Materials &amp; Logistics</div>
    <div style="font-size:14px;color:#b8b0a2;margin-bottom:44px;max-width:560px;line-height:1.7">Everything needed is covered — from the first tool to the final cleanup. No surprises, no add-ons.</div>
    <div class="ml" style="display:grid;grid-template-columns:repeat(4,1fr);gap:3px">
      ${[['Materials','Premium Materials','All paints, primers, adhesives, hardware, and finishing supplies at professional grade — included.','<svg viewBox="0 0 38 38" fill="none" width="34" height="34"><rect x="4" y="8" width="30" height="22" rx="1.5" stroke="#C9A96E" stroke-width="1.5"/><path d="M4 14h30M11 8v6M27 8v6" stroke="#C9A96E" stroke-width="1.4" stroke-linecap="round"/><circle cx="19" cy="22" r="2.5" stroke="#C9A96E" stroke-width="1.3"/></svg>'],
        ['Logistics','Delivery &amp; Transport','All material delivery, tool transport, and crew logistics fully coordinated. You don\'t lift a finger.','<svg viewBox="0 0 38 38" fill="none" width="34" height="34"><rect x="3" y="14" width="26" height="16" rx="1.5" stroke="#C9A96E" stroke-width="1.5"/><path d="M29 20h4l2 4v4h-6" stroke="#C9A96E" stroke-width="1.4" stroke-linejoin="round"/><circle cx="10" cy="32" r="2.5" stroke="#C9A96E" stroke-width="1.3"/><circle cx="24" cy="32" r="2.5" stroke="#C9A96E" stroke-width="1.3"/></svg>'],
        ['Labor','Skilled Labor','Experienced crew handles every trade involved — fully supervised, held to the highest standard of finish.','<svg viewBox="0 0 38 38" fill="none" width="34" height="34"><path d="M10 29l14-14M10 27L8 29l2-2z" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/><path d="M20 9l10 10-4 2-8-8 2-4z" stroke="#C9A96E" stroke-width="1.4" stroke-linejoin="round"/></svg>'],
        ['Site Care','Protection &amp; Cleanup','Surfaces protected daily, debris removed, and a full post-project cleanup before we hand your space back.','<svg viewBox="0 0 38 38" fill="none" width="34" height="34"><path d="M13 17l-4 14h20l-4-14" stroke="#C9A96E" stroke-width="1.5" stroke-linejoin="round"/><path d="M19 7v10M11 12l8-5 8 5" stroke="#C9A96E" stroke-width="1.4" stroke-linecap="round"/></svg>']
      ].map(([cat,title,desc,icon])=>`
      <div style="padding:32px 24px;border:1px solid rgba(201,169,110,0.22);background:rgba(255,255,255,0.02)">
        <div style="margin-bottom:16px;opacity:0.75">${icon}</div>
        <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#C9A96E;margin-bottom:8px">${cat}</div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:19px;font-weight:600;color:#F8F4EF;margin-bottom:10px">${title}</div>
        <div style="font-size:13px;color:#b8b0a2;line-height:1.7">${desc}</div>
      </div>`).join('')}
    </div>
  </div>
</section>

<div style="text-align:center;padding:10px 0;color:#C9A96E;font-size:10px;letter-spacing:8px;opacity:0.45">◆ &nbsp; ◆ &nbsp; ◆</div>

<section style="padding:80px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
  <div style="max-width:1100px;margin:0 auto;padding:0 6%">
    <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">The Formo Standard</div>
    <div style="font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,44px);font-weight:300;color:#F8F4EF;margin-bottom:40px">Why Our Clients Choose Us</div>
    <div class="wg" style="display:grid;grid-template-columns:repeat(3,1fr);gap:2px">
      ${[['Licensed &amp; Insured','Fully licensed and insured on every project — complete peace of mind throughout your renovation.','<path d="M12 19l5 5 9-9" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'],
         ['On-Time Delivery','Clear milestones, daily communication, and a genuine commitment to your timeline.','<path d="M19 10v9l6 3" stroke="#C9A96E" stroke-width="1.5" stroke-linecap="round"/>'],
         ['Premium Craftsmanship','Master-level execution with meticulous attention to every detail. We don\'t settle — we deliver exceptional.','<path d="M19 13l2.5 5h5.5l-4.5 3.5 1.5 5.5L19 24l-4.5 3 1.5-5.5L11.5 18h5.5z" stroke="#C9A96E" stroke-width="1.4" stroke-linejoin="round"/>']
      ].map(([title,desc,iconPath])=>`
      <div style="padding:36px 28px;border:1px solid rgba(201,169,110,0.25);background:rgba(255,255,255,0.02);text-align:center">
        <div style="margin:0 auto 18px;width:38px;opacity:0.7"><svg viewBox="0 0 38 38" fill="none" width="38" height="38"><circle cx="19" cy="19" r="16" stroke="#C9A96E" stroke-width="1.5"/>${iconPath}</svg></div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:21px;font-weight:600;color:#F8F4EF;margin-bottom:12px">${title}</div>
        <div style="font-size:13px;color:#b8b0a2;line-height:1.7">${desc}</div>
      </div>`).join('')}
    </div>
  </div>
</section>

<div style="text-align:center;padding:10px 0;color:#C9A96E;font-size:10px;letter-spacing:8px;opacity:0.45">◆ &nbsp; ◆ &nbsp; ◆</div>

<section style="padding:100px 0;text-align:center">
  <div style="max-width:1100px;margin:0 auto;padding:0 6%">
    <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">Begin Your Renovation</div>
    <h2 style="font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,52px);font-weight:300;color:#F8F4EF;margin-bottom:12px">Ready to transform your space?</h2>
    <p style="font-size:14px;color:#b8b0a2;max-width:480px;margin:0 auto 48px;line-height:1.7">We'd love to schedule a walkthrough and lock in your start date. We typically respond within a few hours.</p>
    <div class="cb" style="display:inline-block;text-align:left;border:1px solid rgba(201,169,110,0.28);padding:36px 52px;background:rgba(255,255,255,0.02)">
      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#C9A96E;margin-bottom:14px">Your Project Lead</div>
      <div style="font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:600;color:#F8F4EF;margin-bottom:20px">Dan Lares</div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2h4l1.5 3-1.8 1a7 7 0 003.3 3.3L10 7.5l3 1.5v3a1 1 0 01-1 1A11 11 0 011 3a1 1 0 011-1z" stroke="#C9A96E" stroke-width="1.2"/></svg><a href="tel:6156081220" style="font-size:15px;color:#b8b0a2">615-608-1220</a></div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="3" width="12" height="9" rx="1" stroke="#C9A96E" stroke-width="1.2"/><path d="M1 4l6 3.5L13 4" stroke="#C9A96E" stroke-width="1.2"/></svg><a href="mailto:dan@formorenovation.com" style="font-size:15px;color:#b8b0a2">dan@formorenovation.com</a></div>
      <div style="display:flex;align-items:center;gap:12px"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="#C9A96E" stroke-width="1.2"/><path d="M7 1.5a8 8 0 010 11M1.5 7h11" stroke="#C9A96E" stroke-width="1.2"/></svg><a href="https://formorenovation.com" target="_blank" style="font-size:15px;color:#b8b0a2">formorenovation.com</a></div>
    </div>
  </div>
</section>

${trackScript}
</body></html>`;
}

app.listen(PORT, () => console.log(`Formo running on port ${PORT}`));
