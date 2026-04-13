const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const gh = require('./github');

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const PORT = process.env.PORT || 3000;

// ============================================================
// SERVAL MVP — AI Access Management Platform
// Self-serve: Setup company → employees register → AI manages access
// ============================================================

// ---------- HELPERS ----------
function genId() { return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function ticketId() { return 'SRV-' + (1000 + db.prepare('SELECT COUNT(*) as c FROM tickets').get().c + 1); }

function getCompany(id) {
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(id);
  if (!company) return null;
  company.repos = db.prepare('SELECT * FROM repos WHERE company_id=?').all(id);
  return company;
}

// ---------- GROQ AI ----------
async function askAI(message, context) {
  if (!GROQ_API_KEY) return null;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: 'Kamu Serval AI, asisten access management. Jawab SINGKAT 2-3 kalimat. Bahasa Indonesia kasual. ' + context },
          { role: 'user', content: message }], max_tokens: 200, temperature: 0.7 })
    });
    const t = await res.text(); const d = JSON.parse(t);
    return d.choices?.[0]?.message?.content || null;
  } catch (e) { return null; }
}

// ---------- CHAT HANDLER ----------
async function handleChat(msg, sessionId, companyId) {
  let user = db.prepare('SELECT * FROM users WHERE session_id=? AND company_id=?').get(sessionId, companyId);

  // Manager AI chat (no user session needed)
  if (!user && sessionId === 'manager') {
    const company = getCompany(companyId);
    if (!company) return { response: 'Company not found.', intent: 'Error', processingTime: 0 };
    const st = Date.now();
    const users = db.prepare('SELECT name, division, github FROM users WHERE company_id=?').all(companyId);
    const tickets = db.prepare('SELECT * FROM tickets WHERE company_id=? ORDER BY created_at DESC LIMIT 10').all(companyId);
    const accessLog = db.prepare('SELECT * FROM access_log WHERE company_id=? ORDER BY created_at DESC LIMIT 10').all(companyId);
    const pending = db.prepare('SELECT * FROM pending_approvals WHERE company_id=? AND status=?').all(companyId, 'pending');
    const context = `Company: ${company.name}. Users: ${users.map(u=>u.name+'('+u.division+',@'+u.github+')').join(', ')||'none'}. Pending: ${pending.length}. Tickets: ${tickets.length}. Recent access: ${accessLog.slice(0,5).map(l=>l.action+' @'+l.github+'→'+l.repo_key).join(', ')||'none'}. Repos: ${company.repos.map(r=>r.key+'('+JSON.parse(r.departments).join(',')+')').join(', ')}`;
    const ai = await askAI(msg, context);
    return R(ai || 'Coba lagi.', 'Manager AI', st);
  }

  if (!user) return { response: 'Session expired. Please re-register.', intent: 'Error', processingTime: 0 };

  const company = getCompany(companyId);
  if (!company) return { response: 'Company not found.', intent: 'Error', processingTime: 0 };

  const m = msg.toLowerCase().trim();
  const st = Date.now();
  const repos = company.repos;

  // Greeting
  if (/^(halo|hai|hi|hello|hey)/i.test(m)) {
    const repoList = repos.map(r => `<b>${r.key}</b> — ${r.description} [${JSON.parse(r.departments).join(', ')}]`).join('\n');
    return R(`Halo ${user.name}! (${user.division}, @${user.github})\n\n${company.name} repos:\n${repoList}\n\nCoba: "minta akses [repo]" atau "help"`, 'Greeting', st);
  }

  // Access request
  if (/akses|access|minta|butuh/.test(m) || repos.some(r => m.includes(r.key))) {
    let repoRow = null;
    for (const r of repos) { if (m.includes(r.key) || m.includes(r.github_name)) { repoRow = r; break; } }
    if (!repoRow) {
      const keys = repos.map(r => r.key).join(', ');
      return R(`Repo mana?\n\nAvailable: ${keys}`, 'Which Repo', st);
    }

    const depts = JSON.parse(repoRow.departments);
    const allowed = depts.includes('*') || depts.includes('Everyone') || depts.includes(user.division);

    if (!allowed) {
      const tid = ticketId();
      db.prepare('INSERT INTO tickets (ticket_id, company_id, type, description, status, requester) VALUES (?,?,?,?,?,?)').run(tid, companyId, 'Access Denied', `${user.name} (@${user.github}) → ${repoRow.key}`, 'Rejected', user.name);
      db.prepare('INSERT INTO notifications (company_id, target, github, message) VALUES (?,?,?,?)').run(companyId, 'manager', user.github, `❌ <b>${user.name}</b> (${user.division}) tried to access <b>${repoRow.key}</b> — denied by policy`);
      return R(`❌ <b>Access Denied</b>\n\n<b>${repoRow.key}</b> hanya untuk: <b>${depts.join(', ')}</b>\nKamu: <b>${user.division}</b>\n\n<span class="tref">${tid}</span>`, 'Access Denied', st);
    }

    // Needs approval?
    if (repoRow.requires_approval) {
      const tid = ticketId();
      const paId = 'pa_' + Date.now();
      db.prepare('INSERT INTO tickets (ticket_id, company_id, type, description, status, requester) VALUES (?,?,?,?,?,?)').run(tid, companyId, 'Pending Approval', `${user.name} (@${user.github}) → ${repoRow.key}`, 'Pending Approval', user.name);
      db.prepare('INSERT INTO pending_approvals (id, company_id, user_name, github, division, repo_key, repo_name, ticket_id, session_id) VALUES (?,?,?,?,?,?,?,?,?)').run(paId, companyId, user.name, user.github, user.division, repoRow.key, repoRow.github_name, tid, sessionId);
      db.prepare('INSERT INTO notifications (company_id, target, github, message) VALUES (?,?,?,?)').run(companyId, 'manager', user.github, `⏳ <b>${user.name}</b> (${user.division}) requesting access to <b>${repoRow.key}</b> — needs approval`);
      return R(`⏳ <b>Pending Approval</b>\n\n<b>${repoRow.key}</b> requires approval (${repoRow.approver || 'Manager'}).\nYou'll be notified when approved.\n\n<span class="tref">${tid}</span>`, 'Pending Approval', st);
    }

    // Auto-approve → REAL GITHUB
    const result = await gh.addCollaborator(company.github_token, company.github_org, repoRow.github_name, user.github);
    if (result.ok) {
      const tid = ticketId();
      db.prepare('INSERT INTO tickets (ticket_id, company_id, type, description, status, requester) VALUES (?,?,?,?,?,?)').run(tid, companyId, 'Access Granted', `${user.name} (@${user.github}) → ${repoRow.key}`, 'Resolved', user.name);
      db.prepare('INSERT INTO access_log (company_id, user_name, github, division, repo_key, repo_name, action) VALUES (?,?,?,?,?,?,?)').run(companyId, user.name, user.github, user.division, repoRow.key, repoRow.github_name, 'GRANTED');
      db.prepare('INSERT INTO notifications (company_id, target, github, message) VALUES (?,?,?,?)').run(companyId, 'manager', user.github, `✅ <b>${user.name}</b> auto-granted access to <b>${repoRow.key}</b>`);
      return R(`✅ <b>Access Granted!</b>\n\n📦 Repo: <b>${repoRow.key}</b>\n🔑 Permission: Push\n\n<a href="https://github.com/${company.github_org}/${repoRow.github_name}" target="_blank">Open on GitHub ↗</a>\n\n<span class="tref">${tid} — Auto-approved via GitHub API</span>`, 'Access Granted', st);
    } else {
      return R(`⚠️ GitHub API error (${result.status}). Username @${user.github} mungkin nggak valid.`, 'Error', st);
    }
  }

  // Revoke
  if (/revoke|cabut|hapus akses|remove/.test(m)) {
    let repoRow = null;
    for (const r of repos) { if (m.includes(r.key)) { repoRow = r; break; } }

    if (/semua|all/.test(m) || !repoRow) {
      let removed = 0;
      for (const r of repos) {
        const result = await gh.removeCollaborator(company.github_token, company.github_org, r.github_name, user.github);
        if (result.ok) removed++;
        db.prepare('INSERT INTO access_log (company_id, user_name, github, division, repo_key, repo_name, action) VALUES (?,?,?,?,?,?,?)').run(companyId, user.name, user.github, user.division, r.key, r.github_name, 'REVOKED');
      }
      const tid = ticketId();
      db.prepare('INSERT INTO tickets (ticket_id, company_id, type, description, status, requester) VALUES (?,?,?,?,?,?)').run(tid, companyId, 'Offboarding', `ALL revoked: @${user.github}`, 'Resolved', user.name);
      return R(`🔒 <b>ALL Access Revoked!</b>\n\n@${user.github} removed from ${removed} repos.\n⚠️ Previous GitHub links in this chat are no longer accessible.\n\n<span class="tref">${tid}</span>`, 'Offboarding', st);
    }

    await gh.removeCollaborator(company.github_token, company.github_org, repoRow.github_name, user.github);
    db.prepare('INSERT INTO access_log (company_id, user_name, github, division, repo_key, repo_name, action) VALUES (?,?,?,?,?,?,?)').run(companyId, user.name, user.github, user.division, repoRow.key, repoRow.github_name, 'REVOKED');
    const tid = ticketId();
    db.prepare('INSERT INTO tickets (ticket_id, company_id, type, description, status, requester) VALUES (?,?,?,?,?,?)').run(tid, companyId, 'Access Revoked', `@${user.github} → ${repoRow.key}`, 'Resolved', user.name);
    return R(`🔒 @${user.github} removed from <b>${repoRow.key}</b>.\n\n<span class="tref">${tid}</span>`, 'Revoked', st);
  }

  // Status
  if (/status|akses saya|cek/.test(m)) {
    const grants = db.prepare('SELECT DISTINCT repo_key FROM access_log WHERE company_id=? AND github=? AND action=? ORDER BY created_at DESC').all(companyId, user.github, 'GRANTED');
    const revokes = db.prepare('SELECT DISTINCT repo_key FROM access_log WHERE company_id=? AND github=? AND action=? ORDER BY created_at DESC').all(companyId, user.github, 'REVOKED');
    const revokedKeys = new Set(revokes.map(r => r.repo_key));
    const active = grants.filter(g => !revokedKeys.has(g.repo_key));
    if (!active.length) return R(`@${user.github} belum punya akses.\n\nCoba: "minta akses [repo]"`, 'No Access', st);
    const list = active.map(a => `✅ <b>${a.repo_key}</b>`).join('\n');
    return R(`Akses aktif @${user.github}:\n\n${list}`, 'Status', st);
  }

  // Help
  if (/help|bantuan|bisa apa/.test(m)) {
    const keys = repos.map(r => r.key).join(', ');
    return R(`Commands:\n• "minta akses [repo]" — request access (REAL GitHub)\n• "status" — cek akses kamu\n• "revoke semua" — cabut semua\n\nRepos: ${keys}`, 'Help', st);
  }

  // AI fallback
  const ai = await askAI(msg, `User: ${user.name}, Division: ${user.division}, GitHub: @${user.github}. Company: ${company.name}. Repos: ${repos.map(r=>r.key+'('+JSON.parse(r.departments).join(',')+')').join(', ')}`);
  if (ai) return R(ai, 'AI', st);

  return R(`Coba "help" atau "minta akses [repo]"`, 'Unknown', st);
}

function R(resp, intent, st) { return { response: resp, intent, processingTime: Date.now()-st }; }

// ---------- HTTP SERVER ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); res.end(); return; }

  const jsonHead = {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'};

  // ==================== SETUP API ====================

  // Create company
  if (req.method === 'POST' && url.pathname === '/api/setup') {
    let body=''; req.on('data',c=>body+=c); req.on('end', async()=>{
      try {
        const { name, github_org, github_token, repos: repoList } = JSON.parse(body);
        if (!name || !github_org || !github_token) { res.writeHead(400, jsonHead); res.end('{"error":"Missing fields"}'); return; }

        // Validate GitHub token
        const valid = await gh.validateToken(github_token, github_org);

        const companyId = genId();
        db.prepare('INSERT INTO companies (id, name, github_org, github_token) VALUES (?,?,?,?)').run(companyId, name, github_org, github_token);

        // Add repos
        if (repoList && repoList.length) {
          const insert = db.prepare('INSERT INTO repos (company_id, key, github_name, description, departments, requires_approval, approver) VALUES (?,?,?,?,?,?,?)');
          for (const r of repoList) {
            insert.run(companyId, r.key, r.github_name, r.description || '', JSON.stringify(r.departments || []), r.requires_approval ? 1 : 0, r.approver || '');
          }
        }

        console.log(`✅ Company created: ${name} (${github_org}) — ${(repoList||[]).length} repos`);
        res.writeHead(200, jsonHead);
        res.end(JSON.stringify({ success: true, companyId, valid_token: valid }));
      } catch(e) { res.writeHead(400, jsonHead); res.end(JSON.stringify({error:e.message})); }
    }); return;
  }

  // List repos from GitHub (for setup wizard)
  if (req.method === 'POST' && url.pathname === '/api/list-repos') {
    let body=''; req.on('data',c=>body+=c); req.on('end', async()=>{
      try {
        const { github_org, github_token } = JSON.parse(body);
        const repos = await gh.listRepos(github_token, github_org);
        res.writeHead(200, jsonHead);
        res.end(JSON.stringify({ repos }));
      } catch(e) { res.writeHead(400, jsonHead); res.end('{"repos":[]}'); }
    }); return;
  }

  // ==================== COMPANY API ====================

  // Register user
  if (req.method === 'POST' && url.pathname === '/api/register') {
    let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
      try {
        const { name, email, division, github, companyId } = JSON.parse(body);
        if (!name || !github || !division || !companyId) { res.writeHead(400, jsonHead); res.end('{"error":"Missing fields"}'); return; }
        const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
        db.prepare('INSERT INTO users (company_id, name, email, division, github, session_id) VALUES (?,?,?,?,?,?)').run(companyId, name, email||'', division, github.replace('@',''), sessionId);
        console.log(`  Registered: ${name} (${division}) → @${github}`);
        res.writeHead(200, jsonHead);
        res.end(JSON.stringify({ success: true, sessionId }));
      } catch(e) { res.writeHead(400, jsonHead); res.end(JSON.stringify({error:e.message})); }
    }); return;
  }

  // Chat
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let body=''; req.on('data',c=>body+=c); req.on('end', async()=>{
      try {
        const { message, sessionId, companyId } = JSON.parse(body);
        const result = await handleChat(message, sessionId, companyId);
        res.writeHead(200, jsonHead);
        res.end(JSON.stringify(result));
      } catch(e) { res.writeHead(400, jsonHead); res.end('{}'); }
    }); return;
  }

  // Approve
  if (req.method === 'POST' && url.pathname === '/api/approve') {
    let body=''; req.on('data',c=>body+=c); req.on('end', async()=>{
      try {
        const { paId } = JSON.parse(body);
        const pa = db.prepare('SELECT * FROM pending_approvals WHERE id=? AND status=?').get(paId, 'pending');
        if (!pa) { res.writeHead(404, jsonHead); res.end('{"error":"not found"}'); return; }
        const company = getCompany(pa.company_id);
        if (!company) { res.writeHead(404, jsonHead); res.end('{"error":"company not found"}'); return; }
        const repo = company.repos.find(r => r.key === pa.repo_key);
        const result = await gh.addCollaborator(company.github_token, company.github_org, pa.repo_name, pa.github);
        // Always update status + notify, regardless of GitHub result
        db.prepare('UPDATE pending_approvals SET status=? WHERE id=?').run('approved', paId);
        db.prepare('UPDATE tickets SET status=?, resolved_at=? WHERE ticket_id=?').run('Approved', new Date().toLocaleString('id-ID'), pa.ticket_id);
        db.prepare('INSERT INTO access_log (company_id, user_name, github, division, repo_key, repo_name, action) VALUES (?,?,?,?,?,?,?)').run(pa.company_id, pa.user_name, pa.github, pa.division, pa.repo_key, pa.repo_name, 'GRANTED');
        db.prepare('INSERT INTO notifications (company_id, target, github, session_id, message) VALUES (?,?,?,?,?)').run(pa.company_id, 'employee', pa.github, pa.session_id, `✅ Access to <b>${pa.repo_key}</b> has been <b>APPROVED</b> by manager!${result.ok ? ' <a href="https://github.com/'+company.github_org+'/'+pa.repo_name+'" target="_blank">Open repo ↗</a>' : ' (GitHub provisioning: '+result.status+')'}`);
        db.prepare('INSERT INTO notifications (company_id, target, github, message) VALUES (?,?,?,?)').run(pa.company_id, 'manager', pa.github, `✅ Manager approved @${pa.github} → ${pa.repo_key}`);
        console.log('  Approved:', pa.user_name, '@'+pa.github, '→', pa.repo_key, 'GitHub:', result.status);
        res.writeHead(200, jsonHead);
        res.end(JSON.stringify({ success: true, github_status: result.status }));
      } catch(e) { console.error('Approve error:', e); res.writeHead(400, jsonHead); res.end(JSON.stringify({error:e.message})); }
    }); return;
  }

  // Reject
  if (req.method === 'POST' && url.pathname === '/api/reject') {
    let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
      try {
        const { paId } = JSON.parse(body);
        const pa = db.prepare('SELECT * FROM pending_approvals WHERE id=? AND status=?').get(paId, 'pending');
        if (!pa) { res.writeHead(404, jsonHead); res.end('{"error":"not found"}'); return; }
        db.prepare('UPDATE pending_approvals SET status=? WHERE id=?').run('rejected', paId);
        db.prepare('UPDATE tickets SET status=? WHERE ticket_id=?').run('Rejected', pa.ticket_id);
        db.prepare('INSERT INTO notifications (company_id, target, github, session_id, message) VALUES (?,?,?,?,?)').run(pa.company_id, 'employee', pa.github, pa.session_id, `❌ Access to <b>${pa.repo_key}</b> was <b>REJECTED</b>.`);
        res.writeHead(200, jsonHead);
        res.end(JSON.stringify({ success: true }));
      } catch(e) { res.writeHead(400, jsonHead); res.end('{}'); }
    }); return;
  }

  // Get company data (for dashboard)
  if (req.method === 'GET' && url.pathname === '/api/data') {
    const cid = url.searchParams.get('companyId');
    if (!cid) { res.writeHead(400, jsonHead); res.end('{"error":"need companyId"}'); return; }
    const company = getCompany(cid);
    if (!company) { res.writeHead(404, jsonHead); res.end('{"error":"not found"}'); return; }
    const users = db.prepare('SELECT name, email, division, github, created_at FROM users WHERE company_id=?').all(cid);
    const tickets = db.prepare('SELECT * FROM tickets WHERE company_id=? ORDER BY created_at DESC LIMIT 30').all(cid);
    const accessLog = db.prepare('SELECT * FROM access_log WHERE company_id=? ORDER BY created_at DESC LIMIT 30').all(cid);
    const pending = db.prepare('SELECT * FROM pending_approvals WHERE company_id=? AND status=?').all(cid, 'pending');
    const notifications = db.prepare('SELECT * FROM notifications WHERE company_id=? ORDER BY created_at DESC LIMIT 30').all(cid);
    // Don't send token to frontend
    delete company.github_token;
    res.writeHead(200, jsonHead);
    res.end(JSON.stringify({ company, users, tickets, accessLog, pending, notifications }));
    return;
  }

  // Get notifications for employee
  if (req.method === 'GET' && url.pathname === '/api/notifications') {
    const cid = url.searchParams.get('companyId');
    const sid = url.searchParams.get('sessionId');
    const gh = url.searchParams.get('github');
    if (!cid) { res.writeHead(400, jsonHead); res.end('{"notifications":[]}'); return; }
    const notifs = db.prepare('SELECT * FROM notifications WHERE company_id=? AND target=? AND is_read=0 AND (session_id=? OR github=?)').all(cid, 'employee', sid||'', gh||'');
    db.prepare('UPDATE notifications SET is_read=1 WHERE company_id=? AND target=? AND is_read=0 AND (session_id=? OR github=?)').run(cid, 'employee', sid||'', gh||'');
    res.writeHead(200, jsonHead);
    res.end(JSON.stringify({ notifications: notifs }));
    return;
  }

  // ==================== SERVE HTML ====================
  const view = url.pathname;
  res.writeHead(200, { 'Content-Type': 'text/html' });

  if (view === '/setup') { res.end(fs.readFileSync(path.join(__dirname, 'views/setup.html'), 'utf8')); return; }
  if (view.startsWith('/app/')) {
    const companyId = view.split('/')[2];
    const subpage = view.split('/')[3] || 'chat';
    const company = getCompany(companyId);
    if (!company) { res.end('<h1>Company not found</h1>'); return; }
    if (subpage === 'manager') { res.end(fs.readFileSync(path.join(__dirname, 'views/manager.html'), 'utf8')); return; }
    res.end(fs.readFileSync(path.join(__dirname, 'views/chat.html'), 'utf8'));
    return;
  }

  // Landing / home
  res.end(fs.readFileSync(path.join(__dirname, 'views/home.html'), 'utf8'));
});

server.listen(PORT, () => console.log(`\n🚀 Serval MVP — http://localhost:${PORT}\n`));
