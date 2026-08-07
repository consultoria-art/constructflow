const { PrismaClient } = require('@prisma/client');
const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'constructflow-secret';
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const APP_URL = process.env.APP_URL || '';

const PLANS = {
  basico: { name: 'Basico', price: 97, description: 'Ate 3 projetos ativos, ate 5 usuarios', priceId: process.env.STRIPE_PRICE_BASICO },
  pro: { name: 'Pro', price: 197, description: 'Ate 15 projetos ativos, ate 20 usuarios', priceId: process.env.STRIPE_PRICE_PRO },
  enterprise: { name: 'Enterprise', price: 397, description: 'Projetos e usuarios ilimitados', priceId: process.env.STRIPE_PRICE_ENTERPRISE }
};

function parseRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

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

function canSeeFinance(role) {
  return role === 'admin' || role === 'coordenador';
}

// ============ AUTOMACAO: deteccao de desvios ============
async function runAutomation(organizationId) {
  const projects = await prisma.project.findMany({ where: { organizationId } });
  const now = new Date();
  let alertsCreated = 0;
  let projectsMarkedDelayed = 0;

  for (const p of projects) {
    if (p.deadline && new Date(p.deadline) < now && p.status !== 'completed' && p.status !== 'delayed') {
      await prisma.project.update({ where: { id: p.id }, data: { status: 'delayed' } });
      projectsMarkedDelayed++;
    }

    if (p.deadline && new Date(p.deadline) < now && p.status !== 'completed') {
      const title = 'Desvio de prazo: ' + p.name;
      const exists = await prisma.alert.findFirst({ where: { projectId: p.id, title, read: false } });
      if (!exists) {
        await prisma.alert.create({ data: { projectId: p.id, title, message: 'O prazo deste projeto venceu em ' + new Date(p.deadline).toLocaleDateString('pt-BR') + ' e ele ainda nao foi concluido.', type: 'urgent' } });
        alertsCreated++;
      }
    }

    if (p.budget > 0 && p.spent > p.budget) {
      const title = 'Desvio de custo: ' + p.name;
      const exists = await prisma.alert.findFirst({ where: { projectId: p.id, title, read: false } });
      if (!exists) {
        const pct = Math.round((p.spent / p.budget) * 100);
        await prisma.alert.create({ data: { projectId: p.id, title, message: 'O gasto atual (' + pct + '% do orcamento) ultrapassou o valor orcado.', type: 'alert' } });
        alertsCreated++;
      }
    }
  }

  const materials = await prisma.material.findMany({ where: { organizationId }, include: { movements: true } });
  for (const m of materials) {
    const entradas = m.movements.filter(mv => mv.type === 'entrada').reduce((s, mv) => s + mv.quantity, 0);
    const saidas = m.movements.filter(mv => mv.type === 'saida').reduce((s, mv) => s + mv.quantity, 0);
    if (saidas > entradas) {
      const title = 'Desvio de suprimento: ' + m.name;
      const projectIdForAlert = m.movements.find(mv => mv.projectId)?.projectId;
      if (projectIdForAlert) {
        const exists = await prisma.alert.findFirst({ where: { projectId: projectIdForAlert, title, read: false } });
        if (!exists) {
          await prisma.alert.create({ data: { projectId: projectIdForAlert, title, message: 'Saida de ' + m.name + ' (' + saidas + ' ' + m.unit + ') maior que entrada (' + entradas + ' ' + m.unit + ').', type: 'alert' } });
          alertsCreated++;
        }
      }
    }
  }

  const openRisks = await prisma.riskIssue.findMany({ where: { project: { organizationId }, status: 'aberto', type: 'risco', impact: 'alto' }, include: { project: true } });
  for (const r of openRisks) {
    const title = 'Risco alto em aberto: ' + r.title;
    const exists = await prisma.alert.findFirst({ where: { projectId: r.projectId, title, read: false } });
    if (!exists) {
      await prisma.alert.create({ data: { projectId: r.projectId, title, message: 'Risco de alto impacto ainda esta aberto no projeto ' + r.project.name + '.', type: 'urgent' } });
      alertsCreated++;
    }
  }

  return { alertsCreated, projectsMarkedDelayed };
}

function calcProjecoes(projects) {
  const now = new Date();
  return projects
    .filter(p => p.status !== 'completed')
    .map(p => {
      const diasDecorridos = Math.max(1, Math.round((now - new Date(p.createdAt)) / (1000 * 60 * 60 * 24)));
      const ritmoDiario = p.spent / diasDecorridos;
      let diasAteFinal = 30;
      if (p.deadline) {
        diasAteFinal = Math.max(1, Math.round((new Date(p.deadline) - new Date(p.createdAt)) / (1000 * 60 * 60 * 24)));
      }
      const gastoProjetado = Math.round(ritmoDiario * diasAteFinal * 100) / 100;
      const estouraOrcamento = p.budget > 0 && gastoProjetado > p.budget;
      return {
        projectId: p.id,
        projectName: p.name,
        gastoAtual: p.spent,
        gastoProjetado,
        orcamento: p.budget,
        estouraOrcamento,
        diferenca: Math.round((gastoProjetado - p.budget) * 100) / 100
      };
    });
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
      if (password.length < 6)
        return sendJSON(res, 400, { error: 'Senha deve ter no minimo 6 caracteres' });
      const exist = await prisma.user.findUnique({ where: { email } });
      if (exist) return sendJSON(res, 400, { error: 'Email ja cadastrado' });
      const slug = organizationName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40);
      const hash = await bcrypt.hash(password, 10);
      const org = await prisma.organization.create({
        data: { name: organizationName, slug, active: false, subscriptionStatus: 'pending', users: { create: { name, email, passwordHash: hash, role: 'admin' } } },
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
      const token = jwt.sign({ userId: user.id, email, organizationId: user.organizationId, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
      return sendJSON(res, 200, { token, user: { id: user.id, name: user.name, email: user.email, role: user.role }, organization: { id: user.organization.id, name: user.organization.name, slug: user.organization.slug } });
    }

    // ============ BILLING (STRIPE) ============
    if (req.url === '/api/v1/billing/webhook' && req.method === 'POST') {
      if (!stripe) return sendJSON(res, 500, { error: 'Stripe nao configurado' });
      const sig = req.headers['stripe-signature'];
      const rawBody = await parseRawBody(req);
      let event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
      } catch (err) {
        return sendJSON(res, 400, { error: 'Assinatura do webhook invalida' });
      }
      try {
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const organizationId = session.metadata && session.metadata.organizationId;
          if (organizationId) {
            await prisma.organization.update({ where: { id: organizationId }, data: { active: true, subscriptionStatus: 'active', stripeSubscriptionId: session.subscription } });
          }
        } else if (event.type === 'invoice.payment_succeeded') {
          const invoice = event.data.object;
          if (invoice.subscription) {
            const org = await prisma.organization.findFirst({ where: { stripeSubscriptionId: invoice.subscription } });
            if (org) await prisma.organization.update({ where: { id: org.id }, data: { active: true, subscriptionStatus: 'active' } });
          }
        } else if (event.type === 'invoice.payment_failed') {
          const invoice = event.data.object;
          if (invoice.subscription) {
            const org = await prisma.organization.findFirst({ where: { stripeSubscriptionId: invoice.subscription } });
            if (org) await prisma.organization.update({ where: { id: org.id }, data: { active: false, subscriptionStatus: 'overdue' } });
          }
        } else if (event.type === 'customer.subscription.deleted') {
          const sub = event.data.object;
          const org = await prisma.organization.findFirst({ where: { stripeSubscriptionId: sub.id } });
          if (org) await prisma.organization.update({ where: { id: org.id }, data: { active: false, subscriptionStatus: 'canceled' } });
        }
      } catch (e) { /* erro ao processar, mas confirma recebimento para nao gerar retentativas infinitas */ }
      return sendJSON(res, 200, { received: true });
    }

    const user = getUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Token ausente' });

    if (req.url === '/api/v1/auth/me' && req.method === 'GET') {
      const u = await prisma.user.findUnique({ where: { id: user.userId }, include: { organization: true } });
      if (!u) return sendJSON(res, 404, { error: 'Usuario nao encontrado' });
      return sendJSON(res, 200, { id: u.id, name: u.name, email: u.email, role: u.role, organization: { id: u.organization.id, name: u.organization.name, slug: u.organization.slug } });
    }

    if (req.url === '/api/v1/billing/plans' && req.method === 'GET') {
      const clean = {};
      Object.entries(PLANS).forEach(([k, p]) => { clean[k] = { name: p.name, price: p.price, description: p.description, available: !!p.priceId }; });
      return sendJSON(res, 200, clean);
    }

    if (req.url === '/api/v1/billing/status' && req.method === 'GET') {
      const org = await prisma.organization.findUnique({ where: { id: user.organizationId } });
      return sendJSON(res, 200, { plan: org.plan, active: org.active, subscriptionStatus: org.subscriptionStatus });
    }

    if (req.url === '/api/v1/billing/subscribe' && req.method === 'POST') {
      if (user.role !== 'admin') return sendJSON(res, 403, { error: 'Apenas o administrador pode gerenciar a assinatura' });
      if (!process.env.STRIPE_SECRET_KEY) return sendJSON(res, 500, { error: 'Integracao de pagamento nao configurada (STRIPE_SECRET_KEY ausente)' });
      const { planKey } = await parseBody(req);
      if (!PLANS[planKey]) return sendJSON(res, 400, { error: 'Plano invalido' });
      if (!PLANS[planKey].priceId) return sendJSON(res, 400, { error: 'Este plano ainda nao tem um preco configurado no Stripe (STRIPE_PRICE_' + planKey.toUpperCase() + ')' });
      try {
        const org = await prisma.organization.findUnique({ where: { id: user.organizationId } });
        const u = await prisma.user.findUnique({ where: { id: user.userId } });
        let customerId = org.stripeCustomerId;
        if (!customerId) {
          const customer = await stripe.customers.create({ email: u.email, name: u.name, metadata: { organizationId: org.id } });
          customerId = customer.id;
          await prisma.organization.update({ where: { id: org.id }, data: { stripeCustomerId: customerId } });
        }
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer: customerId,
          line_items: [{ price: PLANS[planKey].priceId, quantity: 1 }],
          success_url: APP_URL + '/?billing=success',
          cancel_url: APP_URL + '/?billing=cancel',
          metadata: { organizationId: org.id, planKey }
        });
        await prisma.organization.update({ where: { id: org.id }, data: { plan: planKey, subscriptionStatus: 'pending' } });
        return sendJSON(res, 201, { checkoutUrl: session.url });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }

    if (req.url === '/api/v1/dashboard' && req.method === 'GET') {
      await runAutomation(user.organizationId);
      const tp = await prisma.project.count({ where: { organizationId: user.organizationId } });
      const pp = await prisma.project.findMany({ where: { organizationId: user.organizationId } });
      const tb = pp.reduce((s, p) => s + (p.budget || 0), 0);
      const ts = pp.reduce((s, p) => s + (p.spent || 0), 0);
      const tt = await prisma.task.count({ where: { project: { organizationId: user.organizationId } } });
      const tpen = await prisma.task.count({ where: { project: { organizationId: user.organizationId }, status: 'pending' } });
      const financeOk = canSeeFinance(user.role);
      const projecoes = financeOk ? calcProjecoes(pp) : [];
      const isOwner = user.role === 'admin';
      const prazoDistribuicao = isOwner ? {
        atrasado: pp.filter(p => p.status === 'delayed').length,
        concluido: pp.filter(p => p.status === 'completed').length,
        ativo: pp.filter(p => p.status === 'active').length,
        reprojetado: pp.filter(p => p.status === 'reprojetado').length
      } : null;
      const resumoFinanceiro = (isOwner && financeOk) ? { orcamentoTotal: tb, gastoTotal: ts } : null;
      return sendJSON(res, 200, { projetosAndamento: tp, atrasados: pp.filter(p => p.status === 'delayed').length, orcamentoVsGasto: financeOk ? (tb > 0 ? Math.round((ts / tb) * 100) : 0) : null, totalHoras: tt * 8, tarefasPendentes: tpen, projecoes, prazoDistribuicao, resumoFinanceiro });
    }

    if (req.url === '/api/v1/automation/run' && req.method === 'POST') {
      const result = await runAutomation(user.organizationId);
      return sendJSON(res, 200, result);
    }

    if (req.url === '/api/v1/projects' && req.method === 'GET') {
      const projects = await prisma.project.findMany({ where: { organizationId: user.organizationId }, include: { tasks: true, alerts: true }, orderBy: { createdAt: 'desc' } });
      if (!canSeeFinance(user.role)) {
        return sendJSON(res, 200, projects.map(p => ({ ...p, budget: null, spent: null })));
      }
      return sendJSON(res, 200, projects);
    }

    if (req.url === '/api/v1/projects' && req.method === 'POST') {
      const data = await parseBody(req);
      data.organizationId = user.organizationId;
      if (data.deadline) data.deadline = new Date(data.deadline);
      if (data.startDate) data.startDate = new Date(data.startDate);
      if (!canSeeFinance(user.role)) { delete data.budget; delete data.spent; }
      else { if (data.budget !== undefined) data.budget = parseFloat(data.budget) || 0; if (data.spent !== undefined) data.spent = parseFloat(data.spent) || 0; }
      return sendJSON(res, 201, await prisma.project.create({ data }));
    }

    if (req.url === '/api/v1/projects/bulk' && req.method === 'POST') {
      const { rows } = await parseBody(req);
      if (!Array.isArray(rows)) return sendJSON(res, 400, { error: 'Formato invalido' });
      let created = 0;
      for (const r of rows) {
        if (!r.name) continue;
        await prisma.project.create({
          data: {
            name: String(r.name),
            description: r.description ? String(r.description) : null,
            budget: parseFloat(r.budget) || 0,
            spent: parseFloat(r.spent) || 0,
            status: r.status || 'active',
            responsible: r.responsible ? String(r.responsible) : null,
            startDate: r.startDate ? new Date(r.startDate) : null,
            deadline: r.deadline ? new Date(r.deadline) : null,
            organizationId: user.organizationId
          }
        });
        created++;
      }
      return sendJSON(res, 201, { created });
    }

    if (req.url.startsWith('/api/v1/projects/') && req.url.endsWith('/comments') && req.method === 'GET') {
      const projectId = req.url.split('/')[4];
      const comments = await prisma.comment.findMany({ where: { projectId }, include: { user: true }, orderBy: { createdAt: 'asc' } });
      return sendJSON(res, 200, comments.map(c => ({ id: c.id, message: c.message, createdAt: c.createdAt, userName: c.user.name, userId: c.userId })));
    }

    if (req.url.startsWith('/api/v1/projects/') && req.url.endsWith('/comments') && req.method === 'POST') {
      const projectId = req.url.split('/')[4];
      const { message } = await parseBody(req);
      if (!message) return sendJSON(res, 400, { error: 'Mensagem vazia' });
      const comment = await prisma.comment.create({ data: { message, projectId, userId: user.userId } });
      const withUser = await prisma.comment.findUnique({ where: { id: comment.id }, include: { user: true } });
      return sendJSON(res, 201, { id: withUser.id, message: withUser.message, createdAt: withUser.createdAt, userName: withUser.user.name, userId: withUser.userId });
    }

    if (req.url.startsWith('/api/v1/projects/') && req.method === 'PUT') {
      const id = req.url.split('/')[4];
      const data = await parseBody(req);
      if (data.deadline) data.deadline = new Date(data.deadline);
      if (data.startDate) data.startDate = new Date(data.startDate);
      if (!canSeeFinance(user.role)) { delete data.budget; delete data.spent; }
      else { if (data.budget !== undefined) data.budget = parseFloat(data.budget) || 0; if (data.spent !== undefined) data.spent = parseFloat(data.spent) || 0; }
      delete data.organizationId;
      return sendJSON(res, 200, await prisma.project.update({ where: { id }, data }));
    }

    if (req.url.startsWith('/api/v1/projects/') && req.method === 'DELETE') {
      const id = req.url.split('/')[4];
      await prisma.task.deleteMany({ where: { projectId: id } });
      await prisma.alert.deleteMany({ where: { projectId: id } });
      await prisma.comment.deleteMany({ where: { projectId: id } });
      await prisma.stockMovement.deleteMany({ where: { projectId: id } });
      await prisma.expense.deleteMany({ where: { projectId: id } });
      await prisma.riskIssue.deleteMany({ where: { projectId: id } });
      await prisma.document.deleteMany({ where: { projectId: id } });
      await prisma.project.delete({ where: { id } });
      return sendJSON(res, 200, { success: true });
    }

    if (req.url === '/api/v1/tasks' && req.method === 'GET') {
      return sendJSON(res, 200, await prisma.task.findMany({ where: { project: { organizationId: user.organizationId } }, include: { project: true, assignee: true }, orderBy: { createdAt: 'desc' } }));
    }

    if (req.url === '/api/v1/tasks' && req.method === 'POST') {
      const data = await parseBody(req);
      if (data.deadline) data.deadline = new Date(data.deadline);
      if (data.startDate) data.startDate = new Date(data.startDate);
      if (data.progress !== undefined) data.progress = parseInt(data.progress) || 0;
      if (data.hoursLogged !== undefined) data.hoursLogged = parseFloat(data.hoursLogged) || 0;
      if (data.cost !== undefined) data.cost = parseFloat(data.cost) || 0;
      return sendJSON(res, 201, await prisma.task.create({ data }));
    }

    if (req.url === '/api/v1/tasks/bulk' && req.method === 'POST') {
      const { rows } = await parseBody(req);
      if (!Array.isArray(rows)) return sendJSON(res, 400, { error: 'Formato invalido' });
      const projects = await prisma.project.findMany({ where: { organizationId: user.organizationId } });
      const orgUsers = await prisma.user.findMany({ where: { organizationId: user.organizationId } });
      let created = 0, skipped = 0;
      for (const r of rows) {
        if (!r.title) { skipped++; continue; }
        let projectId = r.projectId;
        if (!projectId && r.project) {
          const match = projects.find(p => p.name.toLowerCase() === String(r.project).toLowerCase());
          if (match) projectId = match.id;
        }
        if (!projectId) { skipped++; continue; }
        let assigneeId = null;
        if (r.responsible) {
          const matchUser = orgUsers.find(u => u.name.toLowerCase() === String(r.responsible).toLowerCase() || u.email.toLowerCase() === String(r.responsible).toLowerCase());
          if (matchUser) assigneeId = matchUser.id;
        }
        await prisma.task.create({
          data: {
            title: String(r.title),
            description: r.description ? String(r.description) : null,
            status: r.status || 'pending',
            priority: r.priority || 'medium',
            assigneeId,
            parentId: r.parentId || null,
            startDate: r.startDate ? new Date(r.startDate) : null,
            deadline: r.deadline ? new Date(r.deadline) : null,
            progress: parseInt(r.progress) || 0,
            hoursLogged: parseFloat(r.hoursLogged) || 0,
            cost: parseFloat(r.cost) || 0,
            projectId
          }
        });
        created++;
      }
      return sendJSON(res, 201, { created, skipped });
    }

    if (req.url.startsWith('/api/v1/tasks/') && req.method === 'PUT') {
      const id = req.url.split('/')[4];
      const data = await parseBody(req);
      if (data.deadline) data.deadline = new Date(data.deadline);
      if (data.startDate) data.startDate = new Date(data.startDate);
      if (data.progress !== undefined) data.progress = parseInt(data.progress) || 0;
      if (data.hoursLogged !== undefined) data.hoursLogged = parseFloat(data.hoursLogged) || 0;
      if (data.cost !== undefined) data.cost = parseFloat(data.cost) || 0;
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

    // ============ USUARIOS / EQUIPE ============
    if (req.url === '/api/v1/users' && req.method === 'GET') {
      const users = await prisma.user.findMany({ where: { organizationId: user.organizationId }, orderBy: { createdAt: 'asc' } });
      return sendJSON(res, 200, users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt })));
    }

    if (req.url === '/api/v1/users' && req.method === 'POST') {
      if (user.role !== 'admin') return sendJSON(res, 403, { error: 'Apenas administradores podem convidar usuarios' });
      const { name, email, password, role } = await parseBody(req);
      if (!name || !email || !password) return sendJSON(res, 400, { error: 'Nome, email e senha sao obrigatorios' });
      if (password.length < 6) return sendJSON(res, 400, { error: 'Senha deve ter no minimo 6 caracteres' });
      const exist = await prisma.user.findUnique({ where: { email } });
      if (exist) return sendJSON(res, 400, { error: 'Email ja cadastrado' });
      const hash = await bcrypt.hash(password, 10);
      const newUser = await prisma.user.create({ data: { name, email, passwordHash: hash, role: role || 'user', organizationId: user.organizationId } });
      return sendJSON(res, 201, { id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role });
    }

    if (req.url.startsWith('/api/v1/users/') && req.method === 'DELETE') {
      if (user.role !== 'admin') return sendJSON(res, 403, { error: 'Apenas administradores podem remover usuarios' });
      const id = req.url.split('/')[4];
      if (id === user.userId) return sendJSON(res, 400, { error: 'Voce nao pode remover a si mesmo' });
      const target = await prisma.user.findFirst({ where: { id, organizationId: user.organizationId } });
      if (!target) return sendJSON(res, 404, { error: 'Usuario nao encontrado' });
      await prisma.user.delete({ where: { id } });
      return sendJSON(res, 200, { success: true });
    }

    // ============ ORGANIZACAO / CONFIGURACOES ============
    if (req.url === '/api/v1/organization' && req.method === 'PUT') {
      if (user.role !== 'admin') return sendJSON(res, 403, { error: 'Apenas administradores podem alterar essas configuracoes' });
      const { name } = await parseBody(req);
      if (!name) return sendJSON(res, 400, { error: 'Nome e obrigatorio' });
      const org = await prisma.organization.update({ where: { id: user.organizationId }, data: { name } });
      return sendJSON(res, 200, { id: org.id, name: org.name, slug: org.slug });
    }

    // ============ MATERIAIS (SUPRIMENTOS) ============
    if (req.url === '/api/v1/materials' && req.method === 'GET') {
      const materials = await prisma.material.findMany({ where: { organizationId: user.organizationId }, include: { movements: true }, orderBy: { name: 'asc' } });
      const withBalance = materials.map(m => {
        const entradas = m.movements.filter(mv => mv.type === 'entrada').reduce((s, mv) => s + mv.quantity, 0);
        const saidas = m.movements.filter(mv => mv.type === 'saida').reduce((s, mv) => s + mv.quantity, 0);
        return { id: m.id, name: m.name, unit: m.unit, entradas, saidas, saldo: entradas - saidas, desvio: saidas > entradas };
      });
      return sendJSON(res, 200, withBalance);
    }

    if (req.url === '/api/v1/materials' && req.method === 'POST') {
      const { name, unit } = await parseBody(req);
      if (!name) return sendJSON(res, 400, { error: 'Nome do material e obrigatorio' });
      const material = await prisma.material.create({ data: { name, unit: unit || 'un', organizationId: user.organizationId } });
      return sendJSON(res, 201, material);
    }

    if (req.url.startsWith('/api/v1/materials/') && req.method === 'DELETE') {
      const id = req.url.split('/')[4];
      await prisma.stockMovement.deleteMany({ where: { materialId: id } });
      await prisma.material.delete({ where: { id } });
      return sendJSON(res, 200, { success: true });
    }

    if (req.url === '/api/v1/movements' && req.method === 'GET') {
      const movements = await prisma.stockMovement.findMany({ where: { material: { organizationId: user.organizationId } }, include: { material: true, project: true }, orderBy: { createdAt: 'desc' } });
      return sendJSON(res, 200, movements);
    }

    if (req.url === '/api/v1/movements' && req.method === 'POST') {
      const { materialId, projectId, type, quantity, unitValue, notes, responsible } = await parseBody(req);
      if (!materialId || !type || !quantity) return sendJSON(res, 400, { error: 'Material, tipo e quantidade sao obrigatorios' });
      if (type !== 'entrada' && type !== 'saida') return sendJSON(res, 400, { error: 'Tipo deve ser entrada ou saida' });
      const movement = await prisma.stockMovement.create({
        data: {
          materialId,
          projectId: projectId || null,
          type,
          quantity: parseFloat(quantity),
          unitValue: parseFloat(unitValue) || 0,
          notes: notes || null,
          responsible: responsible || null
        }
      });
      return sendJSON(res, 201, movement);
    }

    if (req.url.startsWith('/api/v1/movements/') && req.method === 'DELETE') {
      const id = req.url.split('/')[4];
      await prisma.stockMovement.delete({ where: { id } });
      return sendJSON(res, 200, { success: true });
    }

    // ============ DESPESAS ============
    if (req.url === '/api/v1/expenses' && req.method === 'GET') {
      if (!canSeeFinance(user.role)) return sendJSON(res, 403, { error: 'Sem permissao para ver dados financeiros' });
      return sendJSON(res, 200, await prisma.expense.findMany({ where: { project: { organizationId: user.organizationId } }, include: { project: true }, orderBy: { date: 'desc' } }));
    }

    if (req.url === '/api/v1/expenses' && req.method === 'POST') {
      if (!canSeeFinance(user.role)) return sendJSON(res, 403, { error: 'Sem permissao para ver dados financeiros' });
      const { description, amount, category, date, responsible, projectId } = await parseBody(req);
      if (!description || !amount || !projectId) return sendJSON(res, 400, { error: 'Descricao, valor e projeto sao obrigatorios' });
      const expense = await prisma.expense.create({ data: { description, amount: parseFloat(amount), category: category || null, date: date ? new Date(date) : new Date(), responsible: responsible || null, projectId } });
      return sendJSON(res, 201, expense);
    }

    if (req.url.startsWith('/api/v1/expenses/') && req.method === 'PUT') {
      if (!canSeeFinance(user.role)) return sendJSON(res, 403, { error: 'Sem permissao para ver dados financeiros' });
      const id = req.url.split('/')[4];
      const data = await parseBody(req);
      if (data.amount !== undefined) data.amount = parseFloat(data.amount) || 0;
      if (data.date) data.date = new Date(data.date);
      return sendJSON(res, 200, await prisma.expense.update({ where: { id }, data }));
    }

    if (req.url.startsWith('/api/v1/expenses/') && req.method === 'DELETE') {
      if (!canSeeFinance(user.role)) return sendJSON(res, 403, { error: 'Sem permissao para ver dados financeiros' });
      const id = req.url.split('/')[4];
      await prisma.expense.delete({ where: { id } });
      return sendJSON(res, 200, { success: true });
    }

    if (req.url === '/api/v1/expenses/bulk' && req.method === 'POST') {
      if (!canSeeFinance(user.role)) return sendJSON(res, 403, { error: 'Sem permissao para ver dados financeiros' });
      const { rows } = await parseBody(req);
      if (!Array.isArray(rows)) return sendJSON(res, 400, { error: 'Formato invalido' });
      let created = 0;
      for (const r of rows) {
        if (!r.description || !r.amount || !r.projectId) continue;
        const project = await prisma.project.findFirst({ where: { id: r.projectId, organizationId: user.organizationId } });
        if (!project) continue;
        await prisma.expense.create({ data: { description: String(r.description), amount: parseFloat(r.amount) || 0, category: r.category || null, date: r.date ? new Date(r.date) : new Date(), responsible: r.responsible || null, projectId: r.projectId } });
        created++;
      }
      return sendJSON(res, 201, { created });
    }

    // ============ RISCOS E PENDENCIAS ============
    if (req.url === '/api/v1/risks' && req.method === 'GET') {
      return sendJSON(res, 200, await prisma.riskIssue.findMany({ where: { project: { organizationId: user.organizationId } }, include: { project: true }, orderBy: { createdAt: 'desc' } }));
    }

    if (req.url === '/api/v1/risks' && req.method === 'POST') {
      const { type, title, description, probability, impact, status, projectId } = await parseBody(req);
      if (!title || !projectId) return sendJSON(res, 400, { error: 'Titulo e projeto sao obrigatorios' });
      const risk = await prisma.riskIssue.create({ data: { type: type || 'risco', title, description: description || null, probability: probability || null, impact: impact || null, status: status || 'aberto', projectId } });
      return sendJSON(res, 201, risk);
    }

    if (req.url.startsWith('/api/v1/risks/') && req.method === 'PUT') {
      const id = req.url.split('/')[4];
      const data = await parseBody(req);
      return sendJSON(res, 200, await prisma.riskIssue.update({ where: { id }, data }));
    }

    if (req.url.startsWith('/api/v1/risks/') && req.method === 'DELETE') {
      const id = req.url.split('/')[4];
      await prisma.riskIssue.delete({ where: { id } });
      return sendJSON(res, 200, { success: true });
    }

    if (req.url === '/api/v1/risks/bulk' && req.method === 'POST') {
      const { rows } = await parseBody(req);
      if (!Array.isArray(rows)) return sendJSON(res, 400, { error: 'Formato invalido' });
      let created = 0;
      for (const r of rows) {
        if (!r.title || !r.projectId) continue;
        const project = await prisma.project.findFirst({ where: { id: r.projectId, organizationId: user.organizationId } });
        if (!project) continue;
        await prisma.riskIssue.create({ data: { type: r.type === 'pendencia' ? 'pendencia' : 'risco', title: String(r.title), description: r.description || null, probability: r.probability || null, impact: r.impact || null, status: r.status || 'aberto', projectId: r.projectId } });
        created++;
      }
      return sendJSON(res, 201, { created });
    }

    // ============ DOCUMENTOS ============
    if (req.url === '/api/v1/documents' && req.method === 'GET') {
      const docs = await prisma.document.findMany({ where: { project: { organizationId: user.organizationId } }, include: { project: true }, orderBy: { createdAt: 'desc' } });
      return sendJSON(res, 200, docs.map(d => ({ id: d.id, filename: d.filename, mimeType: d.mimeType, uploadedBy: d.uploadedBy, createdAt: d.createdAt, projectId: d.projectId, projectName: d.project.name, size: d.data.length })));
    }

    if (req.url === '/api/v1/documents' && req.method === 'POST') {
      const { filename, mimeType, data, projectId } = await parseBody(req);
      if (!filename || !data || !projectId) return sendJSON(res, 400, { error: 'Arquivo, nome e projeto sao obrigatorios' });
      const doc = await prisma.document.create({ data: { filename, mimeType: mimeType || 'application/octet-stream', data, uploadedBy: user.userId, projectId } });
      return sendJSON(res, 201, { id: doc.id, filename: doc.filename, mimeType: doc.mimeType, createdAt: doc.createdAt });
    }

    if (req.url.match(/^\/api\/v1\/documents\/[^\/]+\/download$/) && req.method === 'GET') {
      const id = req.url.split('/')[4];
      const doc = await prisma.document.findFirst({ where: { id, project: { organizationId: user.organizationId } } });
      if (!doc) return sendJSON(res, 404, { error: 'Documento nao encontrado' });
      return sendJSON(res, 200, { filename: doc.filename, mimeType: doc.mimeType, data: doc.data });
    }

    if (req.url.startsWith('/api/v1/documents/') && req.method === 'DELETE') {
      const id = req.url.split('/')[4];
      await prisma.document.delete({ where: { id } });
      return sendJSON(res, 200, { success: true });
    }

    return sendJSON(res, 404, { error: 'Rota nao encontrada' });
  } catch (error) {
    return sendJSON(res, 500, { error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log('OK: porta ' + PORT));
