const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

// Configuração de CORS Nativa para Produção
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-organization-id");
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

// Rota de Status da Infraestrutura
app.get('/', (req, res) => {
    res.json({ 
        status: "OK", 
        message: "Plataforma ConstructFlow 100% Operacional",
        modules: ["Organizations", "Users", "Projects", "Tasks", "Alerts", "Products"]
    });
});

// =========================================================================
// MÓDULO 1: ORGANIZAÇÕES & INFORMAÇÕES DO CLIENTE
// =========================================================================
app.post('/organizations', async (req, res) => {
    try {
        const { name, slug, plan } = req.body;
        const org = await prisma.organization.create({ data: { name, slug, plan } });
        res.status(201).json(org);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/organizations', async (req, res) => {
    const orgs = await prisma.organization.findMany({ include: { users: true, projects: true } });
    res.json(orgs);
});

// =========================================================================
// MÓDULO 2: PROJETOS (Obras e Contratos do Cliente)
// =========================================================================
app.post('/projects', async (req, res) => {
    try {
        const { name, description, status, budget, spent, responsible, deadline, organizationId } = req.body;
        const project = await prisma.project.create({
            data: { name, description, status, budget, spent, responsible, deadline: deadline ? new Date(deadline) : null, organizationId }
        });
        res.status(201).json(project);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/projects', async (req, res) => {
    try {
        // Filtra os projetos com base no ID enviado pelo cabeçalho do front-end
        const orgId = req.headers['x-organization-id'];
        const where = orgId ? { organizationId: orgId } : {};
        const projects = await prisma.project.findMany({ where, include: { tasks: true, alerts: true } });
        res.json(projects);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// =========================================================================
// MÓDULO 3: CRONOGRAMA & TAREFAS
// =========================================================================
app.post('/tasks', async (req, res) => {
    try {
        const { title, description, status, priority, responsible, deadline, projectId } = req.body;
        const task = await prisma.task.create({
            data: { title, description, status, priority, responsible, deadline: deadline ? new Date(deadline) : null, projectId }
        });
        res.status(201).json(task);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/tasks', async (req, res) => {
    const tasks = await prisma.task.findMany();
    res.json(tasks);
});

// =========================================================================
// MÓDULO 4: ALERTAS & NOTIFICAÇÕES TÉCNICAS
// =========================================================================
app.post('/alerts', async (req, res) => {
    try {
        const { title, message, type, projectId } = req.body;
        const alert = await prisma.alert.create({ data: { title, message, type, projectId } });
        res.status(201).json(alert);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/alerts', async (req, res) => {
    const alerts = await prisma.alert.findMany();
    res.json(alerts);
});

// =========================================================================
// MÓDULO 5: ESTOQUE & INSUMOS (Produtos)
// =========================================================================
app.get('/produtos', async (req, res) => {
    const produtos = await prisma.produto.findMany();
    res.json(produtos);
});

app.post('/produtos', async (req, res) => {
    try {
        const { nome, preco, estoque } = req.body;
        const prod = await prisma.produto.create({ data: { nome, preco: parseFloat(preco), estoque: parseInt(estoque) } });
        res.status(201).json(prod);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/produtos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.produto.delete({ where: { id: parseInt(id) } });
        res.json({ success: true, message: "Removido com sucesso" });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Inicialização Estável
app.listen(PORT, () => {
    console.log(`Servidor rodando com todas as engrenagens ativas na porta ${PORT}`);
});
