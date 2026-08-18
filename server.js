const { PrismaClient } = require('@prisma/client');
const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const crypto = require('crypto');
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('AVISO DE SEGURANCA: variavel de ambiente JWT_SECRET nao configurada. Um segredo aleatorio foi gerado automaticamente para esta execucao, mas todos os usuarios serao desconectados a cada reinicio do servidor. Configure JWT_SECRET no Railway com um valor fixo e aleatorio o quanto antes.');
}
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_SYSTEM_PROMPT = `Voce e o assistente de ajuda da plataforma ConstructFlow, um software de gestao de obras. Responda SEMPRE em portugues do Brasil, de forma curta, direta e pratica, guiando o usuario pelo passo a passo dentro da propria plataforma. Nao invente funcionalidades que nao existem. Aqui esta o mapa da plataforma:

- Visao Geral: painel com KPIs, grafico de cronograma geral, alertas automaticos de desvio. Graficos de pizza financeiros e previsao de receita mensal so aparecem para o Administrador (dono da conta).
- Projetos: cadastro de obras. Botao "+ Novo Projeto" cria um projeto, com opcao de anexar uma planilha completa (varias abas) que distribui automaticamente para Tarefas, Despesas e Riscos. Botao "Complementar Projeto" faz o mesmo em um projeto ja existente. Tem tambem a Curva S e o Cronograma da Obra (Gantt por Atividade) com 4 cores: Planejado (cinza), Realizado (verde), Atrasado (vermelho), Replanejado (roxo).
- Tarefas: quadro Kanban (arrastar e soltar) com 3 colunas (Pendente, Em Andamento, Concluida). Aqui ficam APENAS tarefas internas de recurso (ex: solicitar um equipamento para Suprimentos), nao as atividades de obra da planilha de servicos (essas ficam no Cronograma, dentro de Projetos).
- Suprimentos: controle de materiais, entradas e saidas, com alerta automatico se sair mais material do que entrou.
- Despesas: lancamento de gastos gerais do projeto. So visivel para Administrador e Coordenador.
- Riscos e Pendencias: registro de riscos (com probabilidade/impacto) e pendencias, com destaque automatico de pontos criticos.
- Equipe: convidar e remover usuarios. Niveis de acesso: Administrador (tudo), Coordenador (tudo, menos algumas restricoes futuras), Engenheiro (tudo exceto dados financeiros).
- Configuracoes: editar nome da organizacao e ver a assinatura (plano/status de pagamento).
- Assinatura: pagamentos processados via Stripe. Planos Basico, Pro e Enterprise.

Se o usuario perguntar algo fora do escopo da plataforma, ou tiver um problema tecnico que voce nao consegue resolver por texto, oriente a usar o botao "Fale Conosco" para contato direto com o suporte.`;
const APP_URL = process.env.APP_URL || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'notificacoes@arqenergy.net';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || '';

async function sendEmailNotification(toEmail, subject, htmlBody) {
  if (!RESEND_API_KEY || !toEmail) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RESEND_API_KEY },
      body: JSON.stringify({ from: 'ConstructFlow <' + RESEND_FROM_EMAIL + '>', to: [toEmail], subject, html: htmlBody })
    });
  } catch (e) { console.error('Erro ao enviar email:', e.message); }
}

async function sendWhatsAppNotification(toPhone, message) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM || !toPhone) return;
  try {
    const cleanPhone = String(toPhone).replace(/\D/g, '');
    const to = 'whatsapp:+' + cleanPhone;
    const params = new URLSearchParams({ From: TWILIO_WHATSAPP_FROM, To: to, Body: message });
    await fetch('https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_ACCOUNT_SID + '/Messages.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64')
      },
      body: params.toString()
    });
  } catch (e) { console.error('Erro ao enviar WhatsApp:', e.message); }
}

async function notifyTaskAssignment(task, projectName) {
  if (!task.assigneeId) return;
  const assignee = await prisma.user.findUnique({ where: { id: task.assigneeId } });
  if (!assignee) return;
  const deadlineStr = task.deadline ? new Date(task.deadline).toLocaleDateString('pt-BR') : 'sem prazo definido';
  const subject = 'Nova tarefa atribuida: ' + task.title;
  const html = '<p>Ola ' + assignee.name + ',</p><p>Voce foi designado(a) para a tarefa <strong>' + task.title + '</strong> no projeto <strong>' + projectName + '</strong>.</p><p><strong>Prazo:</strong> ' + deadlineStr + '</p><p>Acesse a plataforma para mais detalhes: ' + APP_URL + '</p>';
  const wppMsg = 'Ola ' + assignee.name + '! Voce foi designado(a) para a tarefa "' + task.title + '" no projeto ' + projectName + '. Prazo: ' + deadlineStr + '.';
  sendEmailNotification(assignee.email, subject, html);
  if (assignee.phone) sendWhatsAppNotification(assignee.phone, wppMsg);
}

async function notifyTaskOverdue(task, projectName) {
  if (!task.assigneeId) return;
  const assignee = await prisma.user.findUnique({ where: { id: task.assigneeId } });
  if (!assignee) return;
  const deadlineStr = task.deadline ? new Date(task.deadline).toLocaleDateString('pt-BR') : '';
  const subject = 'Tarefa atrasada: ' + task.title;
  const html = '<p>Ola ' + assignee.name + ',</p><p>A tarefa <strong>' + task.title + '</strong> no projeto <strong>' + projectName + '</strong> esta atrasada. O prazo era ' + deadlineStr + '.</p><p>Acesse a plataforma para atualizar: ' + APP_URL + '</p>';
  const wppMsg = 'Atencao ' + assignee.name + ': a tarefa "' + task.title + '" (' + projectName + ') esta atrasada. Prazo era ' + deadlineStr + '.';
  sendEmailNotification(assignee.email, subject, html);
  if (assignee.phone) sendWhatsAppNotification(assignee.phone, wppMsg);
}

const PLANS = {
  basico: { name: 'Basico', price: 97, description: 'Ate 3 projetos ativos, ate 5 usuarios', priceId: process.env.STRIPE_PRICE_BASICO },
  pro: { name: 'Pro', price: 197, description: 'Ate 15 projetos ativos, ate 20 usuarios', priceId: process.env.STRIPE_PRICE_PRO },
  enterprise: { name: 'Enterprise', price: 397, description: 'Projetos e usuarios ilimitados', priceId: process.env.STRIPE_PRICE_ENTERPRISE }
};

const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry) return { blocked: false };
  if (now - entry.firstAttempt > WINDOW_MS) { loginAttempts.delete(key); return { blocked: false }; }
  if (entry.count >= MAX_ATTEMPTS) {
    const minutesLeft = Math.ceil((WINDOW_MS - (now - entry.firstAttempt)) / 60000);
    return { blocked: true, minutesLeft };
  }
  return { blocked: false };
}

function recordFailedAttempt(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAttempt > WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttempt: now });
  } else {
    entry.count++;
  }
}

function clearAttempts(key) {
  loginAttempts.delete(key);
}

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

  const overdueTasks = await prisma.task.findMany({
    where: {
      project: { organizationId },
      type: 'tarefa',
      status: { not: 'done' },
      deadline: { lt: now },
      replannedDeadline: null
    },
    include: { project: true, assignee: true }
  });
  for (const t of overdueTasks) {
    const title = 'Tarefa atrasada: ' + t.title;
    const exists = await prisma.alert.findFirst({ where: { projectId: t.projectId, title, read: false } });
    if (!exists) {
      const quem = t.assignee ? ' (responsavel: ' + t.assignee.name + ')' : '';
      await prisma.alert.create({ data: { projectId: t.projectId, title, message: 'O prazo desta tarefa venceu em ' + new Date(t.deadline).toLocaleDateString('pt-BR') + quem + '.', type: 'urgent' } });
      alertsCreated++;
      notifyTaskOverdue(t, t.project ? t.project.name : '');
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

async function logAudit(organizationId, { entityType, entityId, action, channel, userId, userName, previousValue, newValue }) {
  try {
    await prisma.auditLog.create({
      data: {
        entityType,
        entityId: entityId || '',
        action,
        channel: channel || 'web',
        userId: userId || null,
        userName: userName || null,
        previousValue: previousValue !== undefined ? JSON.stringify(previousValue) : null,
        newValue: newValue !== undefined ? JSON.stringify(newValue) : null,
        organizationId
      }
    });
  } catch (e) { console.error('Falha ao gravar log de auditoria:', e.message); }
}

function monthKey(date) {
  const d = new Date(date);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function monthLabel(key) {
  const [y, m] = key.split('-');
  const names = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return names[parseInt(m) - 1] + '/' + y;
}

async function calcRevenueForecast(organizationId) {
  const tasks = await prisma.task.findMany({ where: { project: { organizationId }, cost: { gt: 0 } } });
  const expenses = await prisma.expense.findMany({ where: { project: { organizationId } } });

  const now = new Date();
  const revenueByMonth = {};
  tasks.forEach(t => {
    const targetDate = t.replannedDeadline || t.deadline;
    if (!targetDate) return;
    const actualEndInPast = t.actualEndDate && new Date(t.actualEndDate) <= now;
    if (actualEndInPast) {
      // Genuinamente concluido: receita realizada no mes da conclusao real
      const key = monthKey(t.actualEndDate);
      if (!revenueByMonth[key]) revenueByMonth[key] = { realizada: 0, prevista: 0 };
      revenueByMonth[key].realizada += t.cost;
    } else {
      // Ainda nao concluido de verdade (independente do % informado) - conta como previsto no mes planejado
      const key = monthKey(targetDate);
      if (!revenueByMonth[key]) revenueByMonth[key] = { realizada: 0, prevista: 0 };
      revenueByMonth[key].prevista += t.cost;
    }
  });

  const expensesByMonth = {};
  expenses.forEach(e => {
    const key = monthKey(e.date);
    expensesByMonth[key] = (expensesByMonth[key] || 0) + e.amount;
  });

  const allKeys = new Set([...Object.keys(revenueByMonth), ...Object.keys(expensesByMonth)]);
  const sortedKeys = [...allKeys].sort();

  return sortedKeys.map(key => ({
    month: key,
    label: monthLabel(key),
    receitaRealizada: Math.round((revenueByMonth[key]?.realizada || 0) * 100) / 100,
    receitaPrevista: Math.round((revenueByMonth[key]?.prevista || 0) * 100) / 100,
    despesas: Math.round((expensesByMonth[key] || 0) * 100) / 100
  }));
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

    if (req.url === '/termos.html' || req.url === '/privacidade.html') {
      return fs.readFile(path.join(__dirname, req.url.substring(1)), (err, data) => {
        if (err) return sendJSON(res, 404, { error: 'Pagina nao encontrada' });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(data);
      });
    }

    if (req.url === '/api/v1/health' && req.method === 'GET') {
      return sendJSON(res, 200, { status: 'ok' });
    }

    if (req.url === '/api/v1/auth/signup' && req.method === 'POST') {
      const ipKey = 'signup:' + (req.socket.remoteAddress || 'unknown');
      const rlSignup = checkRateLimit(ipKey);
      if (rlSignup.blocked) return sendJSON(res, 429, { error: 'Muitas tentativas de cadastro. Tente novamente em ' + rlSignup.minutesLeft + ' minuto(s).' });
      const { name, email, password, organizationName } = await parseBody(req);
      if (!name || !email || !password || !organizationName)
        return sendJSON(res, 400, { error: 'Todos os campos sao obrigatorios' });
      if (password.length < 6)
        return sendJSON(res, 400, { error: 'Senha deve ter no minimo 6 caracteres' });
      const exist = await prisma.user.findUnique({ where: { email } });
      if (exist) { recordFailedAttempt(ipKey); return sendJSON(res, 400, { error: 'Email ja cadastrado' }); }
      const slug = organizationName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40);
      const hash = await bcrypt.hash(password, 10);
      const org = await prisma.organization.create({
        data: { name: organizationName, slug, active: false, subscriptionStatus: 'pending', users: { create: { name, email, passwordHash: hash, role: 'admin' } } },
        include: { users: true }
      });
      const token = jwt.sign({ userId: org.users[0].id, email, organizationId: org.id, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
      return sendJSON(res, 201, { token, user: { id: org.users[0].id, name, email, role: 'admin' }, organization: { id: org.id, name: org.name, slug: org.slug } });
    }

    if (req.url === '/api/v1/public/plans' && req.method === 'GET') {
      const clean = {};
      Object.entries(PLANS).forEach(([k, p]) => { clean[k] = { name: p.name, price: p.price, description: p.description }; });
      return sendJSON(res, 200, clean);
    }

    if (req.url === '/api/v1/auth/login' && req.method === 'POST') {
      const { email, password } = await parseBody(req);
      if (!email || !password) return sendJSON(res, 400, { error: 'Email e senha obrigatorios' });
      const rateLimitKey = String(email).toLowerCase();
      const rl = checkRateLimit(rateLimitKey);
      if (rl.blocked) return sendJSON(res, 429, { error: 'Muitas tentativas de login. Tente novamente em ' + rl.minutesLeft + ' minuto(s).' });
      const user = await prisma.user.findUnique({ where: { email }, include: { organization: true } });
      if (!user) { recordFailedAttempt(rateLimitKey); return sendJSON(res, 401, { error: 'Email ou senha invalidos' }); }
      if (!await bcrypt.compare(password, user.passwordHash)) { recordFailedAttempt(rateLimitKey); return sendJSON(res, 401, { error: 'Email ou senha invalidos' }); }
      clearAttempts(rateLimitKey);
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

    if (req.url === '/api/v1/ai/chat' && req.method === 'POST') {
      if (!ANTHROPIC_API_KEY) return sendJSON(res, 500, { error: 'Assistente de IA nao configurado (ANTHROPIC_API_KEY ausente)' });
      const { message, history } = await parseBody(req);
      if (!message) return sendJSON(res, 400, { error: 'Mensagem vazia' });
      try {
        const messages = (Array.isArray(history) ? history : []).concat([{ role: 'user', content: String(message).slice(0, 2000) }]).slice(-20);
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 500, system: AI_SYSTEM_PROMPT, messages })
        });
        const data = await aiRes.json();
        if (!aiRes.ok) throw new Error((data.error && data.error.message) || 'Erro no assistente de IA');
        const reply = (data.content || []).map(c => c.text || '').join('');
        return sendJSON(res, 200, { reply });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
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
      const previsaoReceita = isOwner ? await calcRevenueForecast(user.organizationId) : null;
      return sendJSON(res, 200, { projetosAndamento: tp, atrasados: pp.filter(p => p.status === 'delayed').length, orcamentoVsGasto: financeOk ? (tb > 0 ? Math.round((ts / tb) * 100) : 0) : null, totalHoras: tt * 8, tarefasPendentes: tpen, projecoes, prazoDistribuicao, resumoFinanceiro, previsaoReceita });
    }

    if (req.url === '/api/v1/automation/run' && req.method === 'POST') {
      const result = await runAutomation(user.organizationId);
      return sendJSON(res, 200, result);
    }

    if (req.url === '/api/v1/projects' && req.method === 'GET') {
      const projects = await prisma.project.findMany({ where: { organizationId: user.organizationId }, include: { tasks: true, alerts: true, responsibleUser: true }, orderBy: { createdAt: 'desc' } });
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
      const createdProject = await prisma.project.create({ data, include: { responsibleUser: true } });
      logAudit(user.organizationId, { entityType: 'Project', entityId: createdProject.id, action: 'create', userId: user.userId, userName: user.email, newValue: { name: createdProject.name, budget: createdProject.budget, status: createdProject.status } });
      return sendJSON(res, 201, createdProject);
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
      const before = await prisma.project.findUnique({ where: { id } });
      const updated = await prisma.project.update({ where: { id }, data, include: { responsibleUser: true } });
      logAudit(user.organizationId, { entityType: 'Project', entityId: id, action: 'update', userId: user.userId, userName: user.email, previousValue: before ? { name: before.name, budget: before.budget, status: before.status, deadline: before.deadline, startDate: before.startDate } : null, newValue: { name: updated.name, budget: updated.budget, status: updated.status, deadline: updated.deadline, startDate: updated.startDate } });
      return sendJSON(res, 200, updated);
    }

    if (req.url.startsWith('/api/v1/projects/') && req.method === 'DELETE') {
      const id = req.url.split('/')[4];
      const before = await prisma.project.findUnique({ where: { id } });
      await prisma.task.deleteMany({ where: { projectId: id } });
      await prisma.alert.deleteMany({ where: { projectId: id } });
      await prisma.comment.deleteMany({ where: { projectId: id } });
      await prisma.stockMovement.deleteMany({ where: { projectId: id } });
      await prisma.expense.deleteMany({ where: { projectId: id } });
      await prisma.riskIssue.deleteMany({ where: { projectId: id } });
      await prisma.document.deleteMany({ where: { projectId: id } });
      await prisma.project.delete({ where: { id } });
      logAudit(user.organizationId, { entityType: 'Project', entityId: id, action: 'delete', userId: user.userId, userName: user.email, previousValue: before ? { name: before.name } : null });
      return sendJSON(res, 200, { success: true });
    }

    if (req.url === '/api/v1/task-columns' && req.method === 'GET') {
      let columns = await prisma.taskColumn.findMany({ where: { organizationId: user.organizationId }, orderBy: { order: 'asc' } });
      if (!columns.length) {
        await prisma.taskColumn.createMany({
          data: [
            { id: 'pending', name: 'Pendente', color: '#6b7280', order: 0, organizationId: user.organizationId },
            { id: 'in_progress', name: 'Em Andamento', color: '#3b82f6', order: 1, organizationId: user.organizationId },
            { id: 'done', name: 'Concluida', color: '#22c55e', order: 2, organizationId: user.organizationId }
          ]
        });
        columns = await prisma.taskColumn.findMany({ where: { organizationId: user.organizationId }, orderBy: { order: 'asc' } });
      }
      return sendJSON(res, 200, columns);
    }

    if (req.url === '/api/v1/task-columns' && req.method === 'POST') {
      const { name, color } = await parseBody(req);
      if (!name) return sendJSON(res, 400, { error: 'Nome da coluna e obrigatorio' });
      const maxOrder = await prisma.taskColumn.aggregate({ where: { organizationId: user.organizationId }, _max: { order: true } });
      const col = await prisma.taskColumn.create({ data: { name, color: color || '#6b7280', order: (maxOrder._max.order ?? -1) + 1, organizationId: user.organizationId } });
      return sendJSON(res, 201, col);
    }

    if (req.url.startsWith('/api/v1/task-columns/') && req.method === 'PUT') {
      const id = req.url.split('/')[4];
      const { name, color, order } = await parseBody(req);
      const data = {};
      if (name !== undefined) data.name = name;
      if (color !== undefined) data.color = color;
      if (order !== undefined) data.order = order;
      const col = await prisma.taskColumn.update({ where: { id }, data });
      return sendJSON(res, 200, col);
    }

    if (req.url.startsWith('/api/v1/task-columns/') && req.method === 'DELETE') {
      const id = req.url.split('/')[4];
      const taskCount = await prisma.task.count({ where: { status: id, project: { organizationId: user.organizationId } } });
      if (taskCount > 0) return sendJSON(res, 400, { error: 'Esta coluna tem ' + taskCount + ' tarefa(s). Mova ou exclua as tarefas antes de remover a coluna.' });
      await prisma.taskColumn.delete({ where: { id } });
      return sendJSON(res, 200, { success: true });
    }

    if (req.url === '/api/v1/tasks' && req.method === 'GET') {
      return sendJSON(res, 200, await prisma.task.findMany({ where: { project: { organizationId: user.organizationId } }, include: { project: true, assignee: true }, orderBy: { createdAt: 'desc' } }));
    }

    if (req.url === '/api/v1/tasks' && req.method === 'POST') {
      const data = await parseBody(req);
      if (data.deadline) data.deadline = new Date(data.deadline);
      if (data.startDate) data.startDate = new Date(data.startDate);
      if (data.replannedDeadline) data.replannedDeadline = new Date(data.replannedDeadline);
      if (data.actualStartDate) data.actualStartDate = new Date(data.actualStartDate);
      if (data.actualEndDate) data.actualEndDate = new Date(data.actualEndDate);
      if (data.progress !== undefined) data.progress = parseInt(data.progress) || 0;
      if (data.hoursLogged !== undefined) data.hoursLogged = parseFloat(data.hoursLogged) || 0;
      if (data.cost !== undefined) data.cost = parseFloat(data.cost) || 0;
      const newTask = await prisma.task.create({ data });
      if (newTask.type !== 'atividade' && newTask.assigneeId) {
        const proj = await prisma.project.findUnique({ where: { id: newTask.projectId } });
        notifyTaskAssignment(newTask, proj ? proj.name : '');
      }
      logAudit(user.organizationId, { entityType: 'Task', entityId: newTask.id, action: 'create', userId: user.userId, userName: user.email, newValue: { title: newTask.title, status: newTask.status, deadline: newTask.deadline, cost: newTask.cost } });
      return sendJSON(res, 201, newTask);
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
            type: r.type === 'atividade' ? 'atividade' : 'tarefa',
            status: r.status || 'pending',
            priority: r.priority || 'medium',
            assigneeId,
            parentId: r.parentId || null,
            startDate: r.startDate ? new Date(r.startDate) : null,
            deadline: r.deadline ? new Date(r.deadline) : null,
            actualStartDate: r.actualStartDate ? new Date(r.actualStartDate) : null,
            actualEndDate: r.actualEndDate ? new Date(r.actualEndDate) : null,
            progress: parseInt(r.progress) || 0,
            hoursLogged: parseFloat(r.hoursLogged) || 0,
            cost: parseFloat(r.cost) || 0,
            projectId
          }
        });
        created++;
      }
      if (created > 0) logAudit(user.organizationId, { entityType: 'Task', entityId: 'bulk', action: 'bulk_import', userId: user.userId, userName: user.email, newValue: { created, skipped } });
      return sendJSON(res, 201, { created, skipped });
    }

    if (req.url.startsWith('/api/v1/tasks/') && req.method === 'PUT') {
      const id = req.url.split('/')[4];
      const data = await parseBody(req);
      if (data.deadline) data.deadline = new Date(data.deadline);
      if (data.startDate) data.startDate = new Date(data.startDate);
      if (data.replannedDeadline !== undefined) data.replannedDeadline = data.replannedDeadline ? new Date(data.replannedDeadline) : null;
      if (data.actualStartDate !== undefined) data.actualStartDate = data.actualStartDate ? new Date(data.actualStartDate) : null;
      if (data.actualEndDate !== undefined) data.actualEndDate = data.actualEndDate ? new Date(data.actualEndDate) : null;
      if (data.progress !== undefined) data.progress = parseInt(data.progress) || 0;
      if (data.hoursLogged !== undefined) data.hoursLogged = parseFloat(data.hoursLogged) || 0;
      if (data.cost !== undefined) data.cost = parseFloat(data.cost) || 0;
      const before = await prisma.task.findUnique({ where: { id } });
      const updated = await prisma.task.update({ where: { id }, data });
      if (updated.type !== 'atividade' && updated.assigneeId && before && before.assigneeId !== updated.assigneeId) {
        const proj = await prisma.project.findUnique({ where: { id: updated.projectId } });
        notifyTaskAssignment(updated, proj ? proj.name : '');
      }
      logAudit(user.organizationId, { entityType: 'Task', entityId: id, action: 'update', userId: user.userId, userName: user.email, previousValue: before ? { status: before.status, deadline: before.deadline, progress: before.progress, assigneeId: before.assigneeId } : null, newValue: { status: updated.status, deadline: updated.deadline, progress: updated.progress, assigneeId: updated.assigneeId } });
      return sendJSON(res, 200, updated);
    }

    if (req.url === '/api/v1/tasks/bulk-delete' && req.method === 'POST') {
      const { projectId, type } = await parseBody(req);
      if (!projectId) return sendJSON(res, 400, { error: 'Projeto e obrigatorio' });
      const project = await prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
      if (!project) return sendJSON(res, 404, { error: 'Projeto nao encontrado' });
      const where = { projectId };
      if (type === 'atividade' || type === 'tarefa') where.type = type;
      const tasks = await prisma.task.findMany({ where, select: { id: true } });
      const ids = tasks.map(t => t.id);
      if (ids.length) {
        await prisma.document.deleteMany({ where: { taskId: { in: ids } } });
        await prisma.task.deleteMany({ where: { parentId: { in: ids } } });
        await prisma.task.deleteMany({ where: { id: { in: ids } } });
      }
      return sendJSON(res, 200, { deleted: ids.length });
    }

    if (req.url.startsWith('/api/v1/tasks/') && req.method === 'DELETE') {
      const id = req.url.split('/')[4];
      const before = await prisma.task.findUnique({ where: { id } });
      await prisma.document.deleteMany({ where: { taskId: id } });
      await prisma.task.deleteMany({ where: { parentId: id } });
      await prisma.task.delete({ where: { id } });
      logAudit(user.organizationId, { entityType: 'Task', entityId: id, action: 'delete', userId: user.userId, userName: user.email, previousValue: before ? { title: before.title } : null });
      return sendJSON(res, 200, { success: true });
    }

    if (req.url === '/api/v1/purchase-requests' && req.method === 'GET') {
      const reqs = await prisma.purchaseRequest.findMany({
        where: { project: { organizationId: user.organizationId } },
        include: { quotes: true, requestedBy: true, approvedBy: true, project: true },
        orderBy: { createdAt: 'desc' }
      });
      return sendJSON(res, 200, reqs.map(r => ({
        id: r.id, itemName: r.itemName, description: r.description, quantity: r.quantity, estimatedValue: r.estimatedValue,
        status: r.status, isSingleSource: r.isSingleSource, singleSourceReason: r.singleSourceReason, paymentMethod: r.paymentMethod,
        invoiceNumber: r.invoiceNumber, invoiceValue: r.invoiceValue, invoiceDate: r.invoiceDate, expectedDeliveryDate: r.expectedDeliveryDate,
        deliveredAt: r.deliveredAt, approvedAt: r.approvedAt, rejectionReason: r.rejectionReason, createdAt: r.createdAt,
        projectId: r.projectId, projectName: r.project.name,
        requestedByName: r.requestedBy.name, approvedByName: r.approvedBy ? r.approvedBy.name : null,
        quotes: r.quotes
      })));
    }

    if (req.url === '/api/v1/purchase-requests' && req.method === 'POST') {
      const { itemName, description, quantity, estimatedValue, isSingleSource, singleSourceReason, projectId, expectedDeliveryDate } = await parseBody(req);
      if (!itemName || !projectId) return sendJSON(res, 400, { error: 'Item e projeto sao obrigatorios' });
      const project = await prisma.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } });
      if (!project) return sendJSON(res, 404, { error: 'Projeto nao encontrado' });
      const pr = await prisma.purchaseRequest.create({
        data: {
          itemName, description: description || null, quantity: parseFloat(quantity) || 1, estimatedValue: parseFloat(estimatedValue) || 0,
          isSingleSource: !!isSingleSource, singleSourceReason: singleSourceReason || null,
          expectedDeliveryDate: expectedDeliveryDate ? new Date(expectedDeliveryDate) : null,
          requestedById: user.userId, projectId
        }
      });
      logAudit(user.organizationId, { entityType: 'PurchaseRequest', entityId: pr.id, action: 'create', userId: user.userId, userName: user.email, newValue: { itemName: pr.itemName, estimatedValue: pr.estimatedValue } });
      const approvers = await prisma.user.findMany({ where: { organizationId: user.organizationId, role: { in: ['admin', 'coordenador'] } } });
      const requester = await prisma.user.findUnique({ where: { id: user.userId } });
      approvers.forEach(a => {
        const subject = 'Nova solicitacao de compra: ' + pr.itemName;
        const html = '<p>' + (requester ? requester.name : 'Um engenheiro') + ' solicitou a compra de <strong>' + pr.itemName + '</strong> (qtd ' + pr.quantity + ') no projeto ' + project.name + '. Valor estimado: R$ ' + pr.estimatedValue.toFixed(2) + '.</p><p>Acesse a plataforma para aprovar: ' + APP_URL + '</p>';
        sendEmailNotification(a.email, subject, html);
        if (a.phone) sendWhatsAppNotification(a.phone, 'Nova solicitacao de compra: ' + pr.itemName + ' (' + project.name + '), valor estimado R$ ' + pr.estimatedValue.toFixed(2) + '. Acesse a plataforma para aprovar.');
      });
      return sendJSON(res, 201, pr);
    }

    if (req.url.startsWith('/api/v1/purchase-requests/') && req.url.endsWith('/quotes') && req.method === 'POST') {
      const purchaseRequestId = req.url.split('/')[4];
      const { supplierName, value, deliveryDays, paymentCondition } = await parseBody(req);
      if (!supplierName || value === undefined) return sendJSON(res, 400, { error: 'Fornecedor e valor sao obrigatorios' });
      const quote = await prisma.supplierQuote.create({ data: { supplierName, value: parseFloat(value) || 0, deliveryDays: deliveryDays ? parseInt(deliveryDays) : null, paymentCondition: paymentCondition || null, purchaseRequestId } });
      return sendJSON(res, 201, quote);
    }

    if (req.url.startsWith('/api/v1/purchase-requests/') && req.method === 'PUT') {
      const id = req.url.split('/')[4];
      const body = await parseBody(req);
      const data = {};
      const before = await prisma.purchaseRequest.findUnique({ where: { id }, include: { project: true, requestedBy: true } });
      if (!before) return sendJSON(res, 404, { error: 'Solicitacao nao encontrada' });

      if (body.status === 'approved' || body.status === 'rejected') {
        if (!canSeeFinance(user.role)) return sendJSON(res, 403, { error: 'Somente Administrador ou Coordenador podem aprovar/reprovar compras' });
        data.status = body.status;
        data.approvedById = user.userId;
        data.approvedAt = new Date();
        if (body.status === 'approved') { data.paymentMethod = body.paymentMethod || null; data.supplierChosenId = body.supplierChosenId || null; }
        if (body.status === 'rejected') data.rejectionReason = body.rejectionReason || null;
      }
      if (body.status === 'adjustment_requested') { data.status = body.status; data.rejectionReason = body.rejectionReason || null; }
      if (body.status === 'waiting_delivery') data.status = body.status;
      if (body.status === 'delivered') { data.status = body.status; data.deliveredAt = new Date(); }
      if (body.invoiceNumber !== undefined) data.invoiceNumber = body.invoiceNumber;
      if (body.invoiceValue !== undefined) data.invoiceValue = parseFloat(body.invoiceValue) || 0;
      if (body.invoiceDate) data.invoiceDate = new Date(body.invoiceDate);
      if (body.expectedDeliveryDate !== undefined) data.expectedDeliveryDate = body.expectedDeliveryDate ? new Date(body.expectedDeliveryDate) : null;

      const updated = await prisma.purchaseRequest.update({ where: { id }, data });
      logAudit(user.organizationId, { entityType: 'PurchaseRequest', entityId: id, action: body.status || 'update', userId: user.userId, userName: user.email, previousValue: { status: before.status }, newValue: { status: updated.status, paymentMethod: updated.paymentMethod } });

      if (body.status === 'approved' || body.status === 'rejected' || body.status === 'adjustment_requested') {
        const requester = before.requestedBy;
        const statusLabel = body.status === 'approved' ? 'aprovada' : body.status === 'rejected' ? 'reprovada' : 'ajuste solicitado';
        const subject = 'Solicitacao de compra ' + statusLabel + ': ' + before.itemName;
        const html = '<p>Sua solicitacao de <strong>' + before.itemName + '</strong> foi <strong>' + statusLabel + '</strong>' + (body.rejectionReason ? ': ' + body.rejectionReason : '') + '.</p>';
        sendEmailNotification(requester.email, subject, html);
        if (requester.phone) sendWhatsAppNotification(requester.phone, 'Sua solicitacao "' + before.itemName + '" foi ' + statusLabel + '.' + (body.rejectionReason ? ' Motivo: ' + body.rejectionReason : ''));
      }
      return sendJSON(res, 200, updated);
    }

    if (req.url.startsWith('/api/v1/purchase-requests/') && req.method === 'DELETE') {
      const id = req.url.split('/')[4];
      await prisma.supplierQuote.deleteMany({ where: { purchaseRequestId: id } });
      await prisma.purchaseRequest.delete({ where: { id } });
      logAudit(user.organizationId, { entityType: 'PurchaseRequest', entityId: id, action: 'delete', userId: user.userId, userName: user.email });
      return sendJSON(res, 200, { success: true });
    }

    if (req.url === '/api/v1/audit-log' && req.method === 'GET') {
      if (user.role !== 'admin') return sendJSON(res, 403, { error: 'Apenas administradores podem ver o log de auditoria' });
      const urlObj = new URL(req.url, 'http://x');
      const entityType = urlObj.searchParams.get('entityType');
      const where = { organizationId: user.organizationId };
      if (entityType) where.entityType = entityType;
      const logs = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300 });
      return sendJSON(res, 200, logs);
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
      return sendJSON(res, 200, users.map(u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, createdAt: u.createdAt })));
    }

    if (req.url === '/api/v1/users' && req.method === 'POST') {
      if (user.role !== 'admin') return sendJSON(res, 403, { error: 'Apenas administradores podem convidar usuarios' });
      const { name, email, password, role, phone } = await parseBody(req);
      if (!name || !email || !password) return sendJSON(res, 400, { error: 'Nome, email e senha sao obrigatorios' });
      if (password.length < 6) return sendJSON(res, 400, { error: 'Senha deve ter no minimo 6 caracteres' });
      const exist = await prisma.user.findUnique({ where: { email } });
      if (exist) return sendJSON(res, 400, { error: 'Email ja cadastrado' });
      const hash = await bcrypt.hash(password, 10);
      const newUser = await prisma.user.create({ data: { name, email, phone: phone || null, passwordHash: hash, role: role || 'user', organizationId: user.organizationId } });
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
      logAudit(user.organizationId, { entityType: 'Expense', entityId: expense.id, action: 'create', userId: user.userId, userName: user.email, newValue: { description: expense.description, amount: expense.amount } });
      return sendJSON(res, 201, expense);
    }

    if (req.url.startsWith('/api/v1/expenses/') && req.method === 'PUT') {
      if (!canSeeFinance(user.role)) return sendJSON(res, 403, { error: 'Sem permissao para ver dados financeiros' });
      const id = req.url.split('/')[4];
      const data = await parseBody(req);
      if (data.amount !== undefined) data.amount = parseFloat(data.amount) || 0;
      if (data.date) data.date = new Date(data.date);
      const before = await prisma.expense.findUnique({ where: { id } });
      const updated = await prisma.expense.update({ where: { id }, data });
      logAudit(user.organizationId, { entityType: 'Expense', entityId: id, action: 'update', userId: user.userId, userName: user.email, previousValue: before ? { description: before.description, amount: before.amount } : null, newValue: { description: updated.description, amount: updated.amount } });
      return sendJSON(res, 200, updated);
    }

    if (req.url.startsWith('/api/v1/expenses/') && req.method === 'DELETE') {
      if (!canSeeFinance(user.role)) return sendJSON(res, 403, { error: 'Sem permissao para ver dados financeiros' });
      const id = req.url.split('/')[4];
      const before = await prisma.expense.findUnique({ where: { id } });
      await prisma.expense.delete({ where: { id } });
      logAudit(user.organizationId, { entityType: 'Expense', entityId: id, action: 'delete', userId: user.userId, userName: user.email, previousValue: before ? { description: before.description, amount: before.amount } : null });
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
      return sendJSON(res, 200, docs.map(d => ({ id: d.id, filename: d.filename, mimeType: d.mimeType, uploadedBy: d.uploadedBy, createdAt: d.createdAt, projectId: d.projectId, projectName: d.project.name, taskId: d.taskId, size: d.data.length })));
    }

    if (req.url === '/api/v1/documents' && req.method === 'POST') {
      const { filename, mimeType, data, projectId, taskId } = await parseBody(req);
      if (!filename || !data || !projectId) return sendJSON(res, 400, { error: 'Arquivo, nome e projeto sao obrigatorios' });
      const doc = await prisma.document.create({ data: { filename, mimeType: mimeType || 'application/octet-stream', data, uploadedBy: user.userId, projectId, taskId: taskId || null } });
      return sendJSON(res, 201, { id: doc.id, filename: doc.filename, mimeType: doc.mimeType, createdAt: doc.createdAt, taskId: doc.taskId });
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
