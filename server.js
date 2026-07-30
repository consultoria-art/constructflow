const express = require('express');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 1. ROTA INICIAL DE DIAGNÓSTICO
app.get('/', (req, res) => {
    res.json({ status: "OK", message: "Servidor ConstructFlow operando com todas as rotas ativas!" });
});

// =========================================================================
// 2. ROTAS DE ORGANIZAÇÃO (Organizations)
// =========================================================================

// Criar Organização
app.post('/organizations', async (req, res) => {
    try {
        const { name, slug, plan } = req.body;
        const newOrg = await prisma.organization.create({
            data: { name, slug, plan }
        });
        res.status(201).json(newOrg);
    } catch (error) {
        res.status(400).json({ error: "Erro ao criar organização", details: error.message });
    }
});

// Listar todas as Organizações
app.get('/organizations', async (req, res) => {
    try {
        const orgs = await prisma.organization.findMany({
            include: { users: true, projects: true }
        });
        res.json(orgs);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar organizações" });
    }
});

// =========================================================================
// 3. ROTAS DE USUÁRIO (Users)
// =========================================================================

// Criar Usuário (Vinculado a uma Organização)
app.post('/users', async (req, res) => {
    try {
        const { name, email, passwordHash, role, organizationId } = req.body;
        const newUser = await prisma.user.create({
            data: { name, email, passwordHash, role, organizationId }
        });
        res.status(201).json(newUser);
    } catch (error) {
        res.status(400).json({ error: "Erro ao criar usuário", details: error.message });
    }
});

// Listar Usuários
app.get('/users', async (req, res) => {
    try {
        const users = await prisma.user.findMany();
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar usuários" });
    }
});

// =========================================================================
// 4. ROTAS DE PROJETO (Projects)
// =========================================================================

// Criar Projeto
app.post('/projects', async (req, res) => {
    try {
        const { name, description, status, budget, spent, responsible, deadline, organizationId } = req.body;
        const newProject = await prisma.project.create({
            data: { 
                name, description, status, budget, spent, responsible,
                deadline: deadline ? new Date(deadline) : null, 
                organizationId 
            }
        });
        res.status(201).json(newProject);
    } catch (error) {
        res.status(400).json({ error: "Erro ao criar projeto", details: error.message });
    }
});

// Listar Projetos com Tarefas e Alertas inclusos
app.get('/projects', async (req, res) => {
    try {
        const projects = await prisma.project.findMany({
            include: { tasks: true, alerts: true }
        });
        res.json(projects);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar projetos" });
    }
});

// =========================================================================
// 5. ROTAS DE TAREFA (Tasks)
// =========================================================================

// Criar Tarefa para um Projeto
app.post('/tasks', async (req, res) => {
    try {
        const { title, description, status, priority, responsible, deadline, projectId } = req.body;
        const newTask = await prisma.task.create({
            data: {
                title, description, status, priority, responsible,
                deadline: deadline ? new Date(deadline) : null,
                projectId
            }
        });
        res.status(201).json(newTask);
    } catch (error) {
        res.status(400).json({ error: "Erro ao criar tarefa", details: error.message });
    }
});

// Listar Tarefas
app.get('/tasks', async (req, res) => {
    try {
        const tasks = await prisma.task.findMany();
        res.json(tasks);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar tarefas" });
    }
});

// =========================================================================
// 6. ROTAS DE ALERTA (Alerts)
// =========================================================================

// Criar Alerta para um Projeto
app.post('/alerts', async (req, res) => {
    try {
        const { title, message, type, projectId } = req.body;
        const newAlert = await prisma.alert.create({
            data: { title, message, type, projectId }
        });
        res.status(201).json(newAlert);
    } catch (error) {
        res.status(400).json({ error: "Erro ao criar alerta", details: error.message });
    }
});

// Listar Alertas
app.get('/alerts', async (req, res) => {
    try {
        const alerts = await prisma.alert.findMany();
        res.json(alerts);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar alertas" });
    }
});

// INICIALIZAÇÃO
app.listen(PORT, () => {
    console.log(`Servidor ConstructFlow rodando com sucesso na porta ${PORT}`);
});
