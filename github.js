// GitHub API wrapper
async function githubAPI(token, method, endpoint, body) {
  try {
    const res = await fetch(`https://api.github.com${endpoint}`, {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null, ok: res.ok || res.status === 201 || res.status === 204 };
  } catch (e) { return { status: 500, data: null, ok: false, error: e.message }; }
}

async function addCollaborator(token, owner, repoName, githubUser) {
  const r = await githubAPI(token, 'PUT', `/repos/${owner}/${repoName}/collaborators/${githubUser}`, { permission: 'push' });
  console.log(`  GitHub ADD @${githubUser} → ${repoName}: ${r.status}`);
  return r;
}

async function removeCollaborator(token, owner, repoName, githubUser) {
  const r = await githubAPI(token, 'DELETE', `/repos/${owner}/${repoName}/collaborators/${githubUser}`);
  console.log(`  GitHub REMOVE @${githubUser} → ${repoName}: ${r.status}`);
  return r;
}

async function checkCollaborator(token, owner, repoName, githubUser) {
  const r = await githubAPI(token, 'GET', `/repos/${owner}/${repoName}/collaborators/${githubUser}`);
  return r.status === 204;
}

async function listRepos(token, owner) {
  // Try org repos first
  const r = await githubAPI(token, 'GET', `/orgs/${owner}/repos?per_page=100`);
  if (r.ok && r.data?.length) return r.data.map(r => ({ name: r.name, description: r.description || '', private: r.private }));
  // Try authenticated user's own repos (includes private)
  const r2 = await githubAPI(token, 'GET', `/user/repos?per_page=100&affiliation=owner`);
  if (r2.ok && r2.data?.length) return r2.data.filter(r => r.owner?.login === owner).map(r => ({ name: r.name, description: r.description || '', private: r.private }));
  // Fallback: public repos
  const r3 = await githubAPI(token, 'GET', `/users/${owner}/repos?per_page=100`);
  if (r3.ok) return r3.data.map(r => ({ name: r.name, description: r.description || '', private: r.private }));
  return [];
}

async function validateToken(token, owner) {
  const repos = await listRepos(token, owner);
  return repos.length > 0;
}

module.exports = { githubAPI, addCollaborator, removeCollaborator, checkCollaborator, listRepos, validateToken };
