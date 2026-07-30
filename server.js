const express = require('express');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 888;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-troque-isso';

app.use(express.json());

// ============ HELPERS ============
function signToken(user) {
    return jwt.sign(
        { id: user.id, organizationId: user.organizationId, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

function authenticate(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token não fornecido' });
    }
    const token = header.split(' ')[1];
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload; // { id, organizationId, role }
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
}

// Garante que um Project pertence à organização do usuário logado
async function getOwnedProject(projectId, organizationId) {
    const project = await prisma.project.findFirst({
        where: { id: projectId, organizationId }
    });
    return project;
}

// ============ HEALTH CHECK ============
app.get('/', (req, res) => {
    res.send('OK: porta ' + PORT);
});

// ============ AUTH ============
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, organizationName } = req.body;
        if (!name || !email || !password || !organizationName) {
            return res.status(400).json({ error: 'Campos obrigatórios: name, email, password, organizationName' });
        }

        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
            return res.status(409).json({ error: 'E-mail já cadastrado' });
        }

        const slug = organizationName
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36);

        const passwordHash = await bcrypt.hash(password, 10);

        const organization = await prisma.organization.create({
            data: { name: organizationName, slug }
        });

        const user = await prisma.user.create({
            data: {
                name,
                email,
                passwordHash,
                role: 'admin',
                organizationId: organization.id
            }
        });

        const token = signToken(user);
        res.status(201).json({
            token,
            user: { id: user.id, name: user.name, email: user.email, role: user.role },
            organization: { id: organization.id, name: organization.name, slug: organization.slug }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao registrar' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Campos obrigatórios: email, password' });
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        const token = signToken(user);
        res.json({
            token,
            user: { id: user.id, name: user.name, email: user.email, role: user.role }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao fazer login' });
    }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
    const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        include: { organization: true }
    });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        organization: { id: user.organization.id, name: user.organization.name }
    });
});

// ============ PROJECTS ============
app.get('/api/projects', authenticate, async (req, res) => {
    const projects = await prisma.project.findMany({
        where: { organizationId: req.user.organizationId },
        orderBy: { createdAt: 'desc' }
    });
    res.json(projects);
});

app.get('/api/projects/:id', authenticate, async (req, res) => {
    const project = await getOwnedProject(req.params.id, req.user.organizationId);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado' });
    res.json(project);
});

app.post('/api/projects', authenticate, async (req, res) => {
    try {
        const { name, description, status, budget, responsible, deadline } = req.body;
        if (!name) return res.status(400).json({ error: 'Campo obrigatório: name' });

        const project = await prisma.project.create({
            data: {
                name,
                description,
                status: status || 'active',
                budget: budget || 0,
                responsible,
                deadline: deadline ? new Date(deadline) : null,
                organizationId: req.user.organizationId
            }
        });
        res.status(201).json(project);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao criar projeto' });
    }
});

app.put('/api/projects/:id', authenticate, async (req, res) => {
    try {
        const existing = await getOwnedProject(req.params.id, req.user.organizationId);
        if (!existing) return res.status(404).json({ error: 'Projeto não encontrado' });

        const { name, description, status, budget, spent, responsible, deadline } = req.body;
        const project = await prisma.project.update({
            where: { id: req.params.id },
            data: {
                ...(name !== undefined && { name }),
                ...(description !== undefined && { description }),
                ...(status !== undefined && { status }),
                ...(budget !== undefined && { budget }),
                ...(spent !== undefined && { spent }),
                ...(responsible !== undefined && { responsible }),
                ...(deadline !== undefined && { deadline: deadline ? new Date(deadline) : null })
            }
        });
        res.json(project);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao atualizar projeto' });
    }
});

app.delete('/api/projects/:id', authenticate, async (req, res) => {
    const existing = await getOwnedProject(req.params.id, req.user.organizationId);
    if (!existing) return res.status(404).json({ error: 'Projeto não encontrado' });

    await prisma.project.delete({ where: { id: req.params.id } });
    res.status(204).send();
});

// ============ TASKS ============
app.get('/api/projects/:projectId/tasks', authenticate, async (req, res) => {
    const project = await getOwnedProject(req.params.projectId, req.user.organizationId);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado' });

    const tasks = await prisma.task.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' }
    });
    res.json(tasks);
});

app.post('/api/projects/:projectId/tasks', authenticate, async (req, res) => {
    try {
        const project = await getOwnedProject(req.params.projectId, req.user.organizationId);
        if (!project) return res.status(404).json({ error: 'Projeto não encontrado' });

        const { title, description, status, priority, responsible, deadline } = req.body;
        if (!title) return res.status(400).json({ error: 'Campo obrigatório: title' });

        const task = await prisma.task.create({
            data: {
                title,
                description,
                status: status || 'pending',
                priority: priority || 'medium',
                responsible,
                deadline: deadline ? new Date(deadline) : null,
                projectId: project.id
            }
        });
        res.status(201).json(task);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao criar tarefa' });
    }
});

app.put('/api/tasks/:id', authenticate, async (req, res) => {
    try {
        const task = await prisma.task.findFirst({
            where: { id: req.params.id, project: { organizationId: req.user.organizationId } }
        });
        if (!task) return res.status(404).json({ error: 'Tarefa não encontrada' });

        const { title, description, status, priority, responsible, deadline } = req.body;
        const updated = await prisma.task.update({
            where: { id: req.params.id },
            data: {
                ...(title !== undefined && { title }),
                ...(description !== undefined && { description }),
                ...(status !== undefined && { status }),
                ...(priority !== undefined && { priority }),
                ...(responsible !== undefined && { responsible }),
                ...(deadline !== undefined && { deadline: deadline ? new Date(deadline) : null })
            }
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao atualizar tarefa' });
    }
});

app.delete('/api/tasks/:id', authenticate, async (req, res) => {
    const task = await prisma.task.findFirst({
        where: { id: req.params.id, project: { organizationId: req.user.organizationId } }
    });
    if (!task) return res.status(404).json({ error: 'Tarefa não encontrada' });

    await prisma.task.delete({ where: { id: req.params.id } });
    res.status(204).send();
});

// ============ ALERTS ============
app.get('/api/projects/:projectId/alerts', authenticate, async (req, res) => {
    const project = await getOwnedProject(req.params.projectId, req.user.organizationId);
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado' });

    const alerts = await prisma.alert.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' }
    });
    res.json(alerts);
});

app.post('/api/projects/:projectId/alerts', authenticate, async (req, res) => {
    try {
        const project = await getOwnedProject(req.params.projectId, req.user.organizationId);
        if (!project) return res.status(404).json({ error: 'Projeto não encontrado' });

        const { title, message, type } = req.body;
        if (!title || !message) {
            return res.status(400).json({ error: 'Campos obrigatórios: title, message' });
        }

        const alert = await prisma.alert.create({
            data: {
                title,
                message,
                type: type || 'info',
                projectId: project.id
            }
        });
        res.status(201).json(alert);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao criar alerta' });
    }
});

app.put('/api/alerts/:id/read', authenticate, async (req, res) => {
    const alert = await prisma.alert.findFirst({
        where: { id: req.params.id, project: { organizationId: req.user.organizationId } }
    });
    if (!alert) return res.status(404).json({ error: 'Alerta não encontrado' });

    const updated = await prisma.alert.update({
        where: { id: req.params.id },
        data: { read: true }
    });
    res.json(updated);
});

app.delete('/api/alerts/:id', authenticate, async (req, res) => {
    const alert = await prisma.alert.findFirst({
        where: { id: req.params.id, project: { organizationId: req.user.organizationId } }
    });
    if (!alert) return res.status(404).json({ error: 'Alerta não encontrado' });

    await prisma.alert.delete({ where: { id: req.params.id } });
    res.status(204).send();
});

// ============ START ============
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
