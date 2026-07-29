const { PrismaClient } = require('@prisma/client');
const http = require('http');

const prisma = new PrismaClient();

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    // ─── HEALTH CHECK ────────────────────────────────────────
    if (req.url === '/api/v1/health' && req.method === 'GET') {
      return res.end(JSON.stringify({
        status: 'ok',
        version: '1.0.0',
        name: 'ConstructFlow API',
        timestamp: new Date().toISOString()
      }));
    }

    // ─── DASHBOARD ───────────────────────────────────────────
    if (req.url === '/api/v1/dashboard' && req.method === 'GET') {
      const totalProjects = await prisma.project.count();
      const delayedProjects = await prisma.project.count({ where: { status: 'delayed' } });
      const totalTasks = await prisma.task.count();
      const pendingTasks = await prisma.task.count({ where: { status: 'pending' } });
      const totalHours = totalTasks * 8;

      const projects = await prisma.project.findMany();
      const totalBudget = projects.reduce((sum, p) => sum + (p.budget || 0), 0);
      const totalSpent = projects.reduce((sum, p) => sum + (p.spent || 0), 0);
      const budgetUsage = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;

      return res.end(JSON.stringify({
        projetosAndamento: totalProjects,
        atrasados: delayedProjects,
        orcamentoVsGasto: budgetUsage,
        totalHoras: totalHours,
        tarefasPendentes: pendingTasks
      }));
    }

    // ─── LISTAR PROJETOS ─────────────────────────────────────
    if (req.url === '/api/v1/projects' && req.method === 'GET') {
      const projects = await prisma.project.findMany({
        include: { tasks: true, alerts: true },
        orderBy: { createdAt: 'desc' }
      });
      return res.end(JSON.stringify(projects));
    }

    // ─── CRIAR PROJETO ───────────────────────────────────────
    if (req.url === '/api/v1/projects' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const data = JSON.parse(body);
        const project = await prisma.project.create({ data });
        res.statusCode = 201;
        return res.end(JSON.stringify(project));
      });
      return;
    }

    // ─── LISTAR TAREFAS ──────────────────────────────────────
    if (req.url === '/api/v1/tasks' && req.method === 'GET') {
      const tasks = await prisma.task.findMany({
        include: { project: true },
        orderBy: { createdAt: 'desc' }
      });
      return res.end(JSON.stringify(tasks));
    }

    // ─── CRIAR TAREFA ────────────────────────────────────────
    if (req.url === '/api/v1/tasks' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const data = JSON.parse(body);
        const task = await prisma.task.create({ data });
        res.statusCode = 201;
        return res.end(JSON.stringify(task));
      });
      return;
    }

    // ─── LISTAR ALERTAS ──────────────────────────────────────
    if (req.url === '/api/v1/alerts' && req.method === 'GET') {
      const alerts = await prisma.alert.findMany({
        include: { project: true },
        orderBy: { createdAt: 'desc' }
      });
      return res.end(JSON.stringify(alerts));
    }

    // ─── CRIAR ALERTA ────────────────────────────────────────
    if (req.url === '/api/v1/alerts' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const data = JSON.parse(body);
        const alert = await prisma.alert.create({ data });
        res.statusCode = 201;
        return res.end(JSON.stringify(alert));
      });
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Rota não encontrada' }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error.message }));
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`API rodando na porta ${PORT}`));
