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

// Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Ensure directories exist
fs.ensureDirSync('./uploads');
fs.ensureDirSync('./proposals');
fs.ensureDirSync('./tracking');

// Multer config for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const proposalId = req.body.proposalId || 'temp';
    const dir = `./uploads/${proposalId}`;
    fs.ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${uuidv4().slice(0,8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Serve main app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Upload images for a proposal
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

// Generate proposal with AI
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
    const filepath = `./proposals/${filename}`;

    // Inject tracking script into HTML
    const trackedHtml = injectTracking(htmlContent, proposalId);
    await fs.writeFile(filepath, trackedHtml);

    // Initialize tracking record
    await fs.writeJson(`./tracking/${proposalId}.json`, {
      proposalId,
      clientName: proposalData.clientName,
      projectAddress: proposalData.projectAddress,
      totalAmount: proposalData.totalAmount,
      createdAt: new Date().toISOString(),
      views: [],
      totalTimeSeconds: 0,
      lastViewed: null
    });

    res.json({
      success: true,
      proposalId,
      viewUrl: `/view/${proposalId}`,
      downloadUrl: `/proposals/${filename}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Serve proposal for client viewing
app.get('/view/:proposalId', (req, res) => {
  const filepath = `./proposals/proposal-${req.params.proposalId}.html`;
  if (fs.existsSync(filepath)) {
    res.sendFile(path.resolve(filepath));
  } else {
    res.status(404).send('Proposal not found');
  }
});

// Tracking ping endpoint
app.post('/api/track', async (req, res) => {
  const { proposalId, event, duration, userAgent, referrer } = req.body;
  const trackFile = `./tracking/${proposalId}.json`;

  if (!fs.existsSync(trackFile)) return res.json({ ok: true });

  try {
    const data = await fs.readJson(trackFile);

    if (event === 'open') {
      data.views.push({
        openedAt: new Date().toISOString(),
        userAgent: userAgent || '',
        referrer: referrer || '',
        duration: 0,
        sessionId: req.body.sessionId
      });
      data.lastViewed = new Date().toISOString();
    }

    if (event === 'close' || event === 'heartbeat') {
      const session = data.views.find(v => v.sessionId === req.body.sessionId);
      if (session) {
        session.duration = duration || 0;
      }
      data.totalTimeSeconds = data.views.reduce((sum, v) => sum + (v.duration || 0), 0);
    }

    await fs.writeJson(trackFile, data);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: true });
  }
});

// Dashboard - get all proposals with tracking
app.get('/api/proposals', async (req, res) => {
  try {
    const files = await fs.readdir('./tracking');
    const proposals = await Promise.all(
      files.filter(f => f.endsWith('.json')).map(async f => {
        return await fs.readJson(`./tracking/${f}`);
      })
    );
    proposals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(proposals);
  } catch (err) {
    res.json([]);
  }
});

// Get single proposal tracking
app.get('/api/proposals/:id', async (req, res) => {
  try {
    const data = await fs.readJson(`./tracking/${req.params.id}.json`);
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: 'Not found' });
  }
});

// Serve proposal HTML files
app.use('/proposals', express.static('proposals'));

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function buildPrompt(data, images) {
  const {
    clientName, projectAddress, scopeItems, lineItems,
    totalAmount, companyTagline, notes, projectTitle
  } = data;

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
${lineItems?.map(item => `- ${item.label}: $${item.amount.toLocaleString()}`).join('\n') || ''}
TOTAL: $${Number(totalAmount).toLocaleString()}

${imagesSection}

DESIGN REQUIREMENTS:
Create a SINGLE complete self-contained HTML file (no external CSS files, all styles inline in <style> tag). This is a client-facing sales proposal designed to CLOSE THE DEAL.

The proposal must include these sections:
1. HERO - Full viewport, dramatic. Company name, client name, project title. If project images exist, use one as background with dark overlay.
2. SCOPE OVERVIEW - Cards for each major scope category with icons (use SVG inline icons, no emoji)
3. ${beforeAfterImages.length > 0 ? 'BEFORE & AFTER - Side-by-side comparison with slider or split layout' : 'PROJECT VISION - Scope details with clean list layout'}
4. ${renderImages.length > 0 ? 'RENDERINGS - Full-width showcase of 3D renders/inspiration images' : ''}
5. INVESTMENT - Elegant budget breakdown table, each line item, subtotals, bold total
6. WHY FORMO - 3 value props: Licensed & Insured, On-Time Delivery, Premium Craftsmanship
7. NEXT STEPS - CTA with Dan Lares contact info: dan@formorenovation.com | 615-608-1220 | formorenovation.com

DESIGN SPECIFICS:
- Import from Google Fonts: Cormorant Garamond (300,400,600,700) + Jost (300,400,500)
- Each section full-width, generous padding (80px vertical)
- Gold diamond separators between sections
- Smooth scroll behavior
- CSS animations: fade-in on scroll using IntersectionObserver
- The investment section should feel premium - large total amount displayed in gold
- Mobile responsive
- NO Lorem ipsum - use the real project data provided
- Make it feel like a luxury brand proposal, not a contractor quote

OUTPUT: Return ONLY the complete HTML. No explanation, no markdown, no code blocks. Start with <!DOCTYPE html>`;
}

function injectTracking(html, proposalId) {
  const trackingScript = `
<script>
(function() {
  const PROPOSAL_ID = '${proposalId}';
  const SESSION_ID = Math.random().toString(36).slice(2);
  const BASE_URL = window.location.origin;
  let startTime = Date.now();
  let active = true;

  function ping(event) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    navigator.sendBeacon(BASE_URL + '/api/track', JSON.stringify({
      proposalId: PROPOSAL_ID,
      sessionId: SESSION_ID,
      event,
      duration,
      userAgent: navigator.userAgent,
      referrer: document.referrer
    }));
  }

  // Open event
  ping('open');

  // Heartbeat every 30s
  setInterval(() => { if (active) ping('heartbeat'); }, 30000);

  // Close/blur events
  window.addEventListener('beforeunload', () => ping('close'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { ping('close'); active = false; }
    else { startTime = Date.now(); active = true; ping('open'); }
  });
})();
</script>`;

  // Also fix sendBeacon to send as JSON with proper content type
  const fixedScript = trackingScript.replace(
    "navigator.sendBeacon(BASE_URL + '/api/track', JSON.stringify({",
    `const blob = new Blob([JSON.stringify({`
  );

  // Inject before </body>
  return html.replace('</body>', `${trackingScript}\n</body>`);
}

app.listen(PORT, () => {
  console.log(`Formo Proposal Generator running on port ${PORT}`);
});
