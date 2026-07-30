const { PrismaClient } = require('@prisma/client');
const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'constructflow-secret';

function sendJSON(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function getUser(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try { return jwt.verify(auth.split(' ')[1], JWT_SECRET); } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  try {
    if (req.url === '/' || req.url === '/index.html') {
      return fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
        if (err) return sendJSON(res, 500, { error: 'Erro' });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(data);
      });
    }

    if (req.url === '/api/v1/health' && req.method === 'GET') {
      return sendJSON(res, 200, { status: 'ok' });
    }

    if (req.url === '/api/v1/auth/signup' && req.method === 'POST') {
      const { name, email, password, organizationName } = await parseBody(req);
      if (!name || !email || !password || !organizationName)
        return sendJSON(res, 400, { error: 'Todos os campos sao obrigatorios' });
      if (password.length &lt; 6)
        return sendJSON(res, 400, { error: 'Senha deve ter no minimo 6 caracteres' });
      const exist = await prisma.user.findUnique({ where: { email } });
      if (exist) return sendJSON(res, 400, { error: 'Email ja cadastrado' });
      const slug = organizationName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40);
      const hash = await bcrypt.hash(password, 10);
      const org = await prisma.organization.create({
        data: { name: organizationName, slug, users: { create: { name, email, passwordHash: hash, role: 'admin' } } },
        include: { users: true }
      });
      const token = jwt.sign({ userId: org.users[0].id, email, organizationId: org.id, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
      return sendJSON(res, 201, { token, user: { id: org.users[0].id, name, email, role: 'admin' }, organization: { id: org.id, name: org.name, slug: org.slug } });
    }

    if (req.url === '/api/v1/auth/login' && req.method === 'POST') {
      const { email, password } = await parseBody(req);
      if (!email || !password) return sendJSON(res, 400, { error: 'Email e senha obrigatorios' });
      const user = await prisma.user.findUnique({ where: { email }, include: { organization: true } });
      if (!user) return sendJSON(res, 401, { error: 'Email ou senha invalidos' });
      if (!await bcrypt.compare(password, user.passwordHash)) return sendJSON(res, 401, { error: 'Email ou senha invalidos' });
      if (!user.organization.active) return sendJSON(res, 403, { error: 'Conta desativada' });
      const token = jwt.sign({ userId: user.id, email, organizationId: user.organizationId, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
      return sendJSON(res, 200, { token, user: { id: user.id, name: user.name, email: user.email, role: user.role }, organization: { id: user.organization.id, name: user.organization.name, slug: user.organization.slug } });
    }

    const user = getUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Token ausente' });

    if (req.url === '/api/v1/auth/me' && req.method === 'GET') {
      const u = await prisma.user.findUnique({ where: { id: user.userId }, include: { organization: true } });
      if (!u) return sendJSON(res, 404, { error: 'Usuario nao encontrado' });
      return sendJSON(res, 200, { id: u.id, name: u.name, email: u.email, role: u.role, organization: { id: u.organization.id, name: u.organization.name, slug: u.organization.slug } });
    }

    if (req.url === '/api/v1/dashboard' && req.method === 'GET') {
      const tp = await prisma.project.count({ where: { organizationId: user.organizationId } });
      const pp = await prisma.project.findMany({ where: { organizationId: user.organizationId } });
      const tb = pp.reduce((s, p) => s + (p.budget || 0), 0);
      const ts = pp.reduce((s, p) => s + (p.spent || 0), 0);
      const tt = await prisma.task.count({ where: { project: { organizationId: user.organizationId } } });
      const tpen = await prisma.task.count({ where: { project: { organizationId: user.organizationId }, status: 'pending' } });
      return sendJSON(res, 200, { projetosAndamento: tp, atrasados: pp.filter(p => p.status === 'delayed').length, orcamentoVsGasto: tb > 0 ? Math.round((ts / tb) * 100) : 0, totalHoras: tt * 8, tarefasPendentes: tpen });
    }

    if (req.url === '/api/v1/projects' && req.method === 'GET') {
      return sendJSON(res, 200, await prisma.project.findMany({ where: { organizationId: user.organizationId }, include: { tasks: true, alerts: true }, orderBy: { createdAt: 'desc' } }));
    }

    if (req.url === '/api/v1/projects' && req.method === 'POST') {
      const data = await parseBody(req);
      data.organizationId = user.organizationId;
      return sendJSON(res, 201, await prisma.project.create({ data }));
    }

    if (req.url.startsWith('/api/v1/projects/') && req.method === 'PUT') {
      const id = req.url.split('/')[4];
      const data = await parseBody(req);
      return sendJSON(res, 200, await prisma.project.update({ where: { id }, data }));
    }

    if (req.url.startsWith('/api/v1/projects/') && req.method === 'DELETE') {
      const id = req.url.split('/')[4];
      await prisma.project.delete({ where: { id } });
      return sendJSON(res, 200, { success: true });
    }

    if (req.url === '/api/v1/tasks' && req.method === 'GET') {
      return sendJSON(res, 200, await prisma.task.findMany({ where: { project: { organizationId: user.organizationId } }, include: { project: true }, orderBy: { createdAt: 'desc' } }));
    }

    if (req.url === '/api/v1/tasks' && req.method === 'POST') {
      const data = await parseBody(req);
      return sendJSON(res, 201, await prisma.task.create({ data }));
    }

    if (req.url.startsWith('/api/v1/tasks/') && req.method === 'PUT') {
      const id = req.url.split('/')[4];
      const data = await parseBody(req);
      return sendJSON(res, 200, await prisma.task.update({ where: { id }, data }));
    }

    if (req.url.startsWith('/api/v1/tasks/') && req.method === 'DELETE') {
      const id = req.url.split('/')[4];
      await prisma.task.delete({ where: { id } });
      return sendJSON(res, 200, { success: true });
    }

    if (req.url === '/api/v1/alerts' && req.method === 'GET') {
      return sendJSON(res, 200, await prisma.alert.findMany({ where: { project: { organizationId: user.organizationId } }, include: { project: true }, orderBy: { createdAt: 'desc' } }));
    }

    if (req.url === '/api/v1/alerts' && req.method === 'POST') {
      const data = await parseBody(req);
      return sendJSON(res, 201, await prisma.alert.create({ data }));
    }

    if (req.url.startsWith('/api/v1/alerts/') && req.method === 'PUT') {
      const id = req.url.split('/')[4];
      const data = await parseBody(req);
      return sendJSON(res, 200, await prisma.alert.update({ where: { id }, data }));
    }

    if (req.url.startsWith('/api/v1/alerts/') && req.method === 'DELETE') {
      const id = req.url.split('/')[4];
      await prisma.alert.delete({ where: { id } });
      return sendJSON(res, 200, { success: true });
    }

    return sendJSON(res, 404, { error: 'Rota nao encontrada' });
  } catch (error) {
    return sendJSON(res, 500, { error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log('OK: porta ' + PORT));
