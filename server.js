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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

fs.ensureDirSync(path.join(__dirname, 'uploads'));
fs.ensureDirSync(path.join(__dirname, 'proposals'));
fs.ensureDirSync(path.join(__dirname, 'tracking'));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const proposalId = req.body.proposalId || 'temp';
    const dir = path.join(__dirname, 'uploads', proposalId);
    fs.ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${uuidv4().slice(0,8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/upload', upload.array('images', 20), (req, res) => {
  try {
    const files = req.files.map(f => ({
      filename: f.filename,
      originalname: f.originalname,
      url: `/uploads/${req.body.proposalId}/${f.filename}`,
      category: req.body.category || 'general'
    }));
    res.json({ success: true, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  const { proposalData, images } = req.body;
  try {
    const prompt = buildPrompt(proposalData, images);
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });
    const htmlContent = message.content[0].text;
    const proposalId = proposalData.proposalId || uuidv4();
    const filename = `proposal-${proposalId}.html`;
    const filepath = path.join(__dirname, 'proposals', filename);
    const trackedHtml = injectTracking(htmlContent, proposalId);
    await fs.writeFile(filepath, trackedHtml);
    await fs.writeJson(path.join(__dirname, 'tracking', `${proposalId}.json`), {
      proposalId,
      clientName: proposalData.clientName,
      projectAddress: proposalData.projectAddress,
      totalAmount: proposalData.totalAmount,
      createdAt: new Date().toISOString(),
      views: [],
      totalTimeSeconds: 0,
      lastViewed: null
    });
    res.json({ success: true, proposalId, viewUrl: `/view/${proposalId}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/view/:proposalId', (req, res) => {
  const filepath = path.join(__dirname, 'proposals', `proposal-${req.params.proposalId}.html`);
  if (fs.existsSync(filepath)) {
    res.sendFile(filepath);
  } else {
    res.status(404).send('Proposal not found');
  }
});

app.post('/api/track', async (req, res) => {
  const { proposalId, event, duration } = req.body;
  const trackFile = path.join(__dirname, 'tracking', `${proposalId}.json`);
  if (!fs.existsSync(trackFile)) return res.json({ ok: true });
  try {
    const data = await fs.readJson(trackFile);
    if (event === 'open') {
      data.views.push({
        openedAt: new Date().toISOString(),
        userAgent: req.body.userAgent || '',
        referrer: req.body.referrer || '',
        duration: 0,
        sessionId: req.body.sessionId
      });
      data.lastViewed = new Date().toISOString();
    }
    if (event === 'close' || event === 'heartbeat') {
      const session = data.views.find(v => v.sessionId === req.body.sessionId);
      if (session) session.duration = duration || 0;
      data.totalTimeSeconds = data.views.reduce((sum, v) => sum + (v.duration || 0), 0);
    }
    await fs.writeJson(trackFile, data);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: true });
  }
});

app.get('/api/proposals', async (req, res) => {
  try {
    const trackingDir = path.join(__dirname, 'tracking');
    const files = await fs.readdir(trackingDir);
    const proposals = await Promise.all(
      files.filter(f => f.endsWith('.json')).map(f => fs.readJson(path.join(trackingDir, f)))
    );
    proposals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(proposals);
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/proposals/:id', async (req, res) => {
  try {
    const data = await fs.readJson(path.join(__dirname, 'tracking', `${req.params.id}.json`));
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: 'Not found' });
  }
});

app.use('/proposals', express.static(path.join(__dirname, 'proposals')));

function buildPrompt(data, images) {
  const { clientName, projectAddress, scopeItems, lineItems, totalAmount, companyTagline, notes, projectTitle } = data;
  const beforeAfterImages = images?.filter(i => i.category === 'before_after') || [];
  const renderImages = images?.filter(i => i.category === 'render') || [];
  const projectImages = images?.filter(i => i.category === 'project') || [];
  const imagesSection = images?.length ? `
IMAGES PROVIDED (use these src URLs directly in the HTML):
Before/After Photos: ${JSON.stringify(beforeAfterImages.map(i => i.url))}
3D Renders/Inspiration: ${JSON.stringify(renderImages.map(i => i.url))}
Project Photos: ${JSON.stringify(projectImages.map(i => i.url))}
` : '';

  return `You are a world-class proposal designer. Create a stunning, high-converting HTML proposal for a renovation company.

BRAND IDENTITY:
- Company: Formo Renovation LLC
- Colors: Background #191816 (near-black), Gold accent #C9A96E, Cream text #F8F4EF, Muted #cfc7b8
- Fonts: Use Google Fonts - "Cormorant Garamond" for headings (serif, elegant), "Jost" for body
- Tagline: "${companyTagline || 'Built on quality, driven by integrity'}"

PROJECT DETAILS:
- Client: ${clientName}
- Project: ${projectTitle || 'Renovation Project'}
- Address: ${projectAddress || ''}
- Notes: ${notes || ''}

SCOPE OF WORK:
${scopeItems?.map((item, i) => `${i + 1}. ${item}`).join('\n') || 'Full interior renovation'}

BUDGET BREAKDOWN:
${lineItems?.map(item => `- ${item.label}: $${Number(item.amount).toLocaleString()}`).join('\n') || ''}
TOTAL: $${Number(totalAmount).toLocaleString()}

${imagesSection}

DESIGN REQUIREMENTS:
Create a SINGLE complete self-contained HTML file. This is a client-facing sales proposal designed to CLOSE THE DEAL.

Sections:
1. HERO - Full viewport, dramatic. Company name, client name, project title. If project images exist, use one as background with dark overlay.
2. SCOPE OVERVIEW - Cards for each major scope category with inline SVG icons
3. ${beforeAfterImages.length > 0 ? 'BEFORE & AFTER - Side-by-side comparison layout' : 'PROJECT VISION - Scope details with clean list layout'}
4. ${renderImages.length > 0 ? 'RENDERINGS - Full-width showcase of 3D renders' : ''}
5. INVESTMENT - Elegant budget breakdown, each line item, bold total
6. WHY FORMO - 3 value props: Licensed & Insured, On-Time Delivery, Premium Craftsmanship
7. NEXT STEPS - CTA with: dan@formorenovation.com | 615-608-1220 | formorenovation.com

DESIGN:
- Google Fonts: Cormorant Garamond (300,400,600,700) + Jost (300,400,500)
- Generous padding, gold accents, fade-in scroll animations via IntersectionObserver
- Mobile responsive
- Feel like a luxury brand proposal, not a contractor quote
- NO Lorem ipsum

OUTPUT: Return ONLY the complete HTML starting with <!DOCTYPE html>. No markdown, no explanation.`;
}

function injectTracking(html, proposalId) {
  const script = `
<script>
(function() {
  var PID = '${proposalId}';
  var SID = Math.random().toString(36).slice(2);
  var BASE = window.location.origin;
  var t0 = Date.now();
  var on = true;
  function ping(ev) {
    var body = JSON.stringify({ proposalId:PID, sessionId:SID, event:ev, duration:Math.round((Date.now()-t0)/1000), userAgent:navigator.userAgent, referrer:document.referrer });
    try { navigator.sendBeacon(BASE+'/api/track', new Blob([body],{type:'application/json'})); } catch(e) {}
  }
  ping('open');
  setInterval(function(){ if(on) ping('heartbeat'); }, 30000);
  window.addEventListener('beforeunload', function(){ ping('close'); });
  document.addEventListener('visibilitychange', function(){
    if(document.hidden){ ping('close'); on=false; } else { t0=Date.now(); on=true; ping('open'); }
  });
})();
<\/script>`;
  return html.replace('</body>', script + '\n</body>');
}

app.listen(PORT, () => {
  console.log(`Formo Proposal Generator running on port ${PORT}`);
});
