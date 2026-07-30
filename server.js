const { PrismaClient } = require('@prisma/client');
const http = require('http');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

function sendJSON(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  try {
    // Frontend
    if (req.url === '/' || req.url === '/index.html') {
      return fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
        if (err) return sendJSON(res, 500, { error: 'Erro ao carregar página' });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(data);
      });
    }

    // Health
    if (req.url === '/api/v1/health' && req.method === 'GET') {
      return sendJSON(res, 200, { status: 'ok', version: '1.0.0', name: 'ConstructFlow API' });
    }

    // Dashboard
    if (req.url === '/api/v1/dashboard' && req.method === 'GET') {
      const totalProjects = await prisma.project.count();
      const delayedProjects = await prisma.project.count({ where: { status: 'delayed' } });
      const projects = await prisma.project.findMany();
      const totalBudget = projects.reduce((s, p) => s + (p.budget || 0), 0);
      const totalSpent = projects.reduce((s, p) => s + (p.spent || 0), 0);
      return sendJSON(res, 200, {
        projetosAndamento: totalProjects,
        atrasados: delayedProjects,
        orcamentoVsGasto: totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0,
        totalHoras: totalProjects * 80,
        tarefasPendentes: 0
      });
    }

    // Listar projetos
    if (req.url === '/api/v1/projects' && req.method === 'GET') {
      const projects = await prisma.project.findMany({ orderBy: { createdAt: 'desc' } });
      return sendJSON(res, 200, projects);
    }

    // Criar projeto
    if (req.url === '/api/v1/projects' && req.method === 'POST') {
      const data = await parseBody(req);
      const project = await prisma.project.create({ data });
      return sendJSON(res, 201, project);
    }

    return sendJSON(res, 404, { error: 'Rota não encontrada' });
  } catch (error) {
    return sendJSON(res, 500, { error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`ConstructFlow API rodando na porta ${PORT}`));
