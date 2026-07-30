const express = require('express');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

// Configuração de CORS manual usando middleware nativo (Sem precisar instalar pacotes)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    
    // Trata a requisição de pré-autenticação (Preflight) do navegador
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

// Rota de Diagnóstico Inicial
app.get('/', (req, res) => {
    res.json({ status: "OK", message: "Servidor ConstructFlow operando com modulo de produtos ativo!" });
});

// =========================================================================
// MÓDULO DE PRODUTOS
// =========================================================================

// Buscar todos os produtos (GET)
app.get('/produtos', async (req, res) => {
    try {
        const produtos = await prisma.produto.findMany();
        res.json(produtos);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar produtos", details: error.message });
    }
});

// Adicionar um novo produto (POST)
app.post('/produtos', async (req, res) => {
    try {
        const { nome, preco, estoque } = req.body;
        const novoProduto = await prisma.produto.create({
            data: {
                nome,
                preco: parseFloat(preco),
                estoque: parseInt(estoque)
            }
        });
        res.status(201).json(novoProduto);
    } catch (error) {
        res.status(400).json({ error: "Erro ao salvar produto", details: error.message });
    }
});

// Remover um produto (DELETE)
app.delete('/produtos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.produto.delete({
            where: { id: parseInt(id) }
        });
        res.json({ success: true, message: "Produto removido com sucesso" });
    } catch (error) {
        res.status(400).json({ error: "Erro ao remover produto", details: error.message });
    }
});

// Inicialização do Servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando com sucesso na porta ${PORT}`);
});
