const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const USERNAME = process.env.AUTH_USER || 'kimg2';
const PASSWORD = process.env.AUTH_PASS || 'changeme';
const REPO_DIR = process.env.REPO_DIR || '/data/repo';
const TODO_FILE = path.join(REPO_DIR, 'TODO.md');
const GH_TOKEN = process.env.GH_TOKEN || '';
const GH_REPO = process.env.GH_REPO || 'spqw/todo';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path === '/login') return next();
  res.redirect('/login');
}

// --- Git helpers ---
function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: REPO_DIR, encoding: 'utf8', timeout: 30000 });
}

function ensureRepo() {
  if (!fs.existsSync(path.join(REPO_DIR, '.git'))) {
    fs.mkdirSync(REPO_DIR, { recursive: true });
    const url = GH_TOKEN
      ? `https://${GH_TOKEN}@github.com/${GH_REPO}.git`
      : `https://github.com/${GH_REPO}.git`;
    execSync(`git clone ${url} ${REPO_DIR}`, { encoding: 'utf8', timeout: 30000 });
    git('config user.email "todo@spqw.net"');
    git('config user.name "todo-app"');
  }
}

function pullLatest() {
  try {
    git('fetch origin');
    git('reset --hard origin/master');
  } catch (e) {
    console.error('Pull failed:', e.message);
  }
}

function commitAndPush(message) {
  try {
    git('add TODO.md');
    const status = git('status --porcelain');
    if (!status.trim()) return;
    git(`commit -m "${message.replace(/"/g, '\\"')}"`);
    git('push origin master');
  } catch (e) {
    console.error('Push failed:', e.message);
  }
}

// --- Parse / serialize TODO.md ---
function parseTodoMd() {
  pullLatest();
  if (!fs.existsSync(TODO_FILE)) return { sections: [{ name: 'General', items: [] }] };

  const content = fs.readFileSync(TODO_FILE, 'utf8');
  const lines = content.split('\n');
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^## (.+)$/);
    if (sectionMatch) {
      currentSection = { name: sectionMatch[1].trim(), items: [] };
      sections.push(currentSection);
      continue;
    }
    const itemMatch = line.match(/^- \[([ xX])\] (.+)$/);
    if (itemMatch && currentSection) {
      currentSection.items.push({
        done: itemMatch[1] !== ' ',
        text: itemMatch[2].trim()
      });
    }
  }
  if (sections.length === 0) sections.push({ name: 'General', items: [] });
  return { sections };
}

function serializeTodoMd(data) {
  let md = '# Todo List\n';
  for (const section of data.sections) {
    md += `\n## ${section.name}\n\n`;
    for (const item of section.items) {
      md += `- [${item.done ? 'x' : ' '}] ${item.text}\n`;
    }
  }
  return md;
}

function saveTodoMd(data, message) {
  const md = serializeTodoMd(data);
  fs.writeFileSync(TODO_FILE, md, 'utf8');
  commitAndPush(message || 'Update todos');
}

// --- Init repo on startup ---
ensureRepo();

// --- Routes ---
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  const error = req.query.error ? '<p style="color:#e74c3c">Invalid credentials</p>' : '';
  res.send(loginPage(error));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === USERNAME && password === PASSWORD) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.use(requireAuth);

app.get('/', (req, res) => {
  const data = parseTodoMd();
  res.send(mainPage(data));
});

// API endpoints
app.get('/api/todos', (req, res) => {
  res.json(parseTodoMd());
});

app.post('/api/todos', (req, res) => {
  const data = parseTodoMd();
  const { section, text } = req.body;
  const sec = data.sections.find(s => s.name === section);
  if (sec) {
    sec.items.push({ done: false, text });
    saveTodoMd(data, `Add: ${text}`);
  }
  res.json(data);
});

app.put('/api/todos/toggle', (req, res) => {
  const data = parseTodoMd();
  const { section, index } = req.body;
  const sec = data.sections.find(s => s.name === section);
  if (sec && sec.items[index]) {
    sec.items[index].done = !sec.items[index].done;
    const item = sec.items[index];
    saveTodoMd(data, `${item.done ? 'Complete' : 'Reopen'}: ${item.text}`);
  }
  res.json(data);
});

app.put('/api/todos/edit', (req, res) => {
  const data = parseTodoMd();
  const { section, index, text } = req.body;
  const sec = data.sections.find(s => s.name === section);
  if (sec && sec.items[index]) {
    const old = sec.items[index].text;
    sec.items[index].text = text;
    saveTodoMd(data, `Edit: "${old}" → "${text}"`);
  }
  res.json(data);
});

app.delete('/api/todos', (req, res) => {
  const data = parseTodoMd();
  const { section, index } = req.body;
  const sec = data.sections.find(s => s.name === section);
  if (sec && sec.items[index] !== undefined) {
    const removed = sec.items.splice(index, 1)[0];
    saveTodoMd(data, `Remove: ${removed.text}`);
  }
  res.json(data);
});

app.post('/api/sections', (req, res) => {
  const data = parseTodoMd();
  const { name } = req.body;
  if (name && !data.sections.find(s => s.name === name)) {
    data.sections.push({ name, items: [] });
    saveTodoMd(data, `Add section: ${name}`);
  }
  res.json(data);
});

app.delete('/api/sections', (req, res) => {
  const data = parseTodoMd();
  const { name } = req.body;
  data.sections = data.sections.filter(s => s.name !== name);
  if (data.sections.length === 0) data.sections.push({ name: 'General', items: [] });
  saveTodoMd(data, `Remove section: ${name}`);
  res.json(data);
});

// GitHub webhook for incoming pushes
app.post('/webhook/github', (req, res) => {
  pullLatest();
  res.json({ ok: true });
});

app.post('/api/sync', (req, res) => {
  pullLatest();
  res.json(parseTodoMd());
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Todo app running on port ${PORT}`);
});

// --- HTML Templates ---
function loginPage(error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Todo - Login</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f0f;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh}
.login-box{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:40px;width:360px;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
h1{font-size:1.5rem;margin-bottom:24px;text-align:center;color:#fff}
label{display:block;font-size:.85rem;color:#999;margin-bottom:6px;margin-top:16px}
input{width:100%;padding:10px 14px;background:#111;border:1px solid #333;border-radius:8px;color:#fff;font-size:.95rem;outline:none;transition:border .2s}
input:focus{border-color:#4f8cff}
button{width:100%;margin-top:24px;padding:12px;background:#4f8cff;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer;transition:background .2s}
button:hover{background:#3a6fd8}
p{text-align:center;margin-bottom:8px;font-size:.9rem}
</style></head><body>
<div class="login-box">
<h1>Todo</h1>
${error}
<form method="POST" action="/login">
<label for="username">Username</label>
<input type="text" id="username" name="username" autocomplete="username" required autofocus>
<label for="password">Password</label>
<input type="password" id="password" name="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form>
</div></body></html>`;
}

function mainPage(data) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Todo</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f0f;color:#e0e0e0;min-height:100vh}
.topbar{display:flex;justify-content:space-between;align-items:center;padding:16px 24px;border-bottom:1px solid #222;background:#111}
.topbar h1{font-size:1.2rem;color:#fff}
.topbar .actions{display:flex;gap:12px;align-items:center}
.topbar a,.topbar button{background:none;border:1px solid #333;color:#999;padding:6px 14px;border-radius:6px;font-size:.8rem;cursor:pointer;text-decoration:none;transition:all .2s}
.topbar a:hover,.topbar button:hover{color:#fff;border-color:#555}
.container{max-width:700px;margin:0 auto;padding:24px 16px}
.section{margin-bottom:32px}
.section-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.section-header h2{font-size:1.1rem;color:#aaa;font-weight:500}
.section-header .del-section{background:none;border:none;color:#555;cursor:pointer;font-size:.8rem;padding:4px 8px;border-radius:4px;transition:color .2s}
.section-header .del-section:hover{color:#e74c3c}
.todo-item{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#1a1a1a;border:1px solid #252525;border-radius:8px;margin-bottom:6px;transition:all .15s}
.todo-item:hover{border-color:#333;background:#1e1e1e}
.todo-item.done .todo-text{text-decoration:line-through;color:#555}
.todo-check{width:20px;height:20px;border-radius:50%;border:2px solid #444;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .2s}
.todo-check:hover{border-color:#4f8cff}
.todo-check.checked{background:#4f8cff;border-color:#4f8cff}
.todo-check.checked::after{content:'✓';color:#fff;font-size:12px}
.todo-text{flex:1;font-size:.95rem;cursor:text;padding:2px 4px;border-radius:4px;outline:none;min-height:1.2em;word-break:break-word}
.todo-text:focus{background:#222}
.todo-text em{font-style:normal;color:#888}
.todo-delete{background:none;border:none;color:#444;cursor:pointer;font-size:1rem;padding:4px 8px;border-radius:4px;opacity:0;transition:all .2s}
.todo-item:hover .todo-delete{opacity:1}
.todo-delete:hover{color:#e74c3c}
.add-row{display:flex;gap:8px;margin-top:8px}
.add-row input{flex:1;padding:10px 14px;background:#111;border:1px solid #333;border-radius:8px;color:#fff;font-size:.9rem;outline:none}
.add-row input:focus{border-color:#4f8cff}
.add-row button{padding:10px 18px;background:#4f8cff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:.9rem;white-space:nowrap}
.add-row button:hover{background:#3a6fd8}
.add-section-row{margin-top:24px;display:flex;gap:8px}
.add-section-row input{flex:1;padding:10px 14px;background:#111;border:1px solid #333;border-radius:8px;color:#fff;font-size:.9rem;outline:none}
.add-section-row input:focus{border-color:#4f8cff}
.add-section-row button{padding:10px 18px;background:transparent;color:#4f8cff;border:1px solid #4f8cff;border-radius:8px;cursor:pointer;font-size:.9rem;white-space:nowrap}
.add-section-row button:hover{background:#4f8cff22}
.sync-indicator{font-size:.75rem;color:#555;transition:color .3s}
.sync-indicator.syncing{color:#f39c12}
.sync-indicator.synced{color:#2ecc71}
.sync-indicator.error{color:#e74c3c}
.gh-link{color:#666;text-decoration:none;font-size:.8rem}
.gh-link:hover{color:#aaa}
</style></head><body>
<div class="topbar">
  <h1>Todo</h1>
  <div class="actions">
    <span id="syncStatus" class="sync-indicator">synced</span>
    <button onclick="syncNow()">Sync</button>
    <a href="https://github.com/${GH_REPO}" target="_blank" class="gh-link">GitHub</a>
    <a href="/logout">Logout</a>
  </div>
</div>
<div class="container" id="app"></div>
<script>
let data = ${JSON.stringify(data)};
const GH_REPO = '${GH_REPO}';

function render() {
  const app = document.getElementById('app');
  let html = '';
  data.sections.forEach((sec, si) => {
    html += '<div class="section">';
    html += '<div class="section-header"><h2>' + esc(sec.name) + '</h2>';
    if (data.sections.length > 1) html += '<button class="del-section" onclick="deleteSection(\\''+esc(sec.name)+'\\')">remove</button>';
    html += '</div>';
    sec.items.forEach((item, ii) => {
      html += '<div class="todo-item' + (item.done ? ' done' : '') + '">';
      html += '<div class="todo-check' + (item.done ? ' checked' : '') + '" onclick="toggleItem(\\''+esc(sec.name)+'\\','+ii+')"></div>';
      html += '<div class="todo-text" contenteditable="true" data-section="'+esc(sec.name)+'" data-index="'+ii+'" onblur="editItem(this)" onkeydown="if(event.key===\\'Enter\\'){event.preventDefault();this.blur()}">' + esc(item.text) + '</div>';
      html += '<button class="todo-delete" onclick="deleteItem(\\''+esc(sec.name)+'\\','+ii+')">×</button>';
      html += '</div>';
    });
    html += '<div class="add-row"><input type="text" placeholder="Add a todo..." onkeydown="if(event.key===\\'Enter\\')addItem(\\''+esc(sec.name)+'\\',this)"><button onclick="addItem(\\''+esc(sec.name)+'\\',this.previousElementSibling)">Add</button></div>';
    html += '</div>';
  });
  html += '<div class="add-section-row"><input type="text" id="newSectionName" placeholder="New section name..." onkeydown="if(event.key===\\'Enter\\')addSection()"><button onclick="addSection()">Add Section</button></div>';
  app.innerHTML = html;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function setSync(state) {
  const el = document.getElementById('syncStatus');
  el.className = 'sync-indicator ' + state;
  el.textContent = state === 'syncing' ? 'syncing...' : state;
}

async function api(method, url, body) {
  setSync('syncing');
  try {
    const res = await fetch(url, {
      method, headers: {'Content-Type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined
    });
    data = await res.json();
    render();
    setSync('synced');
  } catch(e) {
    setSync('error');
    console.error(e);
  }
}

function toggleItem(section, index) { api('PUT', '/api/todos/toggle', {section, index}); }
function deleteItem(section, index) { api('DELETE', '/api/todos', {section, index}); }
function addItem(section, input) {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  api('POST', '/api/todos', {section, text});
}
function editItem(el) {
  const section = el.dataset.section;
  const index = parseInt(el.dataset.index);
  const text = el.textContent.trim();
  const current = data.sections.find(s => s.name === section)?.items[index]?.text;
  if (text && text !== current) api('PUT', '/api/todos/edit', {section, index, text});
}
function addSection() {
  const input = document.getElementById('newSectionName');
  const name = input.value.trim();
  if (!name) return;
  input.value = '';
  api('POST', '/api/sections', {name});
}
function deleteSection(name) {
  if (confirm('Delete section "'+name+'" and all its items?')) api('DELETE', '/api/sections', {name});
}
function syncNow() { api('POST', '/api/sync'); }

// Auto-sync every 60s
setInterval(syncNow, 60000);

render();
</script></body></html>`;
}
