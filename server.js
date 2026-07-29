const { PrismaClient } = require('@prisma/client');
const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'constructflow-secret-change-in-production';

// ─── MIDDLEWARE: extrair usuário do token ──────────────
function getUserFromToken(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(auth.split(' ')[1], JWT_SECRET);
  } catch {
    return null;
  }
}

// ─── HELPERS ───────────────────────────────────────────
function sendJSON(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('JSON inválido')); }
    });
  });
}

// ─── SERVER ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  try {
    // ─── FRONTEND ──────────────────────────────────────
    if (req.url === '/' || req.url === '/index.html') {
      return fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
        if (err) return sendJSON(res, 500, { error: 'Erro ao carregar página' });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(data);
      });
    }

    // ─── ROTAS PÚBLICAS ────────────────────────────────

    // Health check
    if (req.url === '/api/v1/health' && req.method === 'GET') {
      return sendJSON(res, 200, {
        status: 'ok',
        version: '1.0.0',
        name: 'ConstructFlow API',
        timestamp: new Date().toISOString()
      });
    }

    // Signup (criar conta)
    if (req.url === '/api/v1/auth/signup' && req.method === 'POST') {
      const { name, email, password, organizationName } = await parseBody(req);

      if (!name || !email || !password || !organizationName) {
        return sendJSON(res, 400, { error: 'Todos os campos são obrigatórios' });
      }
      if (password.length < 6) {
        return sendJSON(res, 400, { error: 'Senha deve ter no mínimo 6 caracteres' });
      }

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return sendJSON(res, 400, { error: 'Email já cadastrado' });
      }

      const slug = organizationName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40);

      const passwordHash = await bcrypt.hash(password, 10);

      const org = await prisma.organization.create({
        data: {
          name: organizationName,
          slug,
          users: {
            create: {
              name,
              email,
              passwordHash,
              role: 'admin'
            }
          }
        },
        include: { users: true }
      });

      const token = jwt.sign(
        { userId: org.users[0].id, email, organizationId: org.id, role: 'admin' },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      return sendJSON(res, 201, {
        token,
        user: { id: org.users[0].id, name, email, role: 'admin' },
        organization: { id: org.id, name: org.name, slug: org.slug }
      });
    }

    // Login
    if (req.url === '/api/v1/auth/login' && req.method === 'POST') {
      const { email, password } = await parseBody(req);

      if (!email || !password) {
        return sendJSON(res, 400, { error: 'Email e senha são obrigatórios' });
      }

      const user = await prisma.user.findUnique({
        where: { email },
        include: { organization: true }
      });

      if (!user) {
        return sendJSON(res, 401, { error: 'Email ou senha inválidos' });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return sendJSON(res, 401, { error: 'Email ou senha inválidos' });
      }

      if (!user.organization.active) {
        return sendJSON(res, 403, { error: 'Conta desativada. Entre em contato com o suporte.' });
      }

      const token = jwt.sign(
        { userId: user.id, email: user.email, organizationId: user.organizationId, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      return sendJSON(res, 200, {
        token,
        user: { id: user.id, name:
